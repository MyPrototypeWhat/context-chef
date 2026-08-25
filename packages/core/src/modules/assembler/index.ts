import type { Message } from '../../types';

export type DynamicStatePlacement = 'system' | 'last_user';

/**
 * @internal
 *
 * Options passed by {@link ContextChef.compile} to {@link Assembler.compile}.
 * Not part of the public API — the field shape may change between minor
 * releases as the compile pipeline evolves. External callers should use the
 * `ContextChef` facade instead of invoking the Assembler directly.
 *
 * The Assembler does not know which parts went into the stitch and does not
 * append any wrapper, separator, or anchor text — callers control the full
 * payload. When the effective tail is not a user message (tool-result tail,
 * empty history), a new user message is created carrying just the stitch —
 * see {@link Assembler} for the placement rules.
 */
export interface AssembleOptions {
  /** XML stitch to place at the effective tail of the conversation. */
  tailXml?: string;
}

/**
 * The Assembler is the physical compiler of the Sandwich Model.
 *
 * **Public surface (stable):** the static helpers {@link Assembler.orderKeysDeterministically}
 * and {@link Assembler.stringifyPayload}, which expose ContextChef's deterministic-JSON
 * convention so external callers can hash payloads consistently with the
 * compile pipeline (useful for cache-aware logging, custom adapters, etc.).
 *
 * **Internal surface (`@internal`, may change without a major bump):**
 * the {@link Assembler.compile} instance method and its {@link AssembleOptions}
 * parameter type. These are implementation details of `ContextChef.compile()`'s
 * sandwich assembly. Treat them as private even though TypeScript marks them
 * `public`; consume the assembly pipeline through `ContextChef.compile()`.
 *
 * Responsibilities:
 * 1. **Deterministic Serialization**: Guarantees identical byte-level output for identical
 *    logical inputs by sorting JSON keys lexicographically. This maximizes KV-Cache hits.
 * 2. **Tail injection**: Places a caller-built XML stitch at the effective tail of the
 *    conversation (merged into a trailing user message, or inserted as a new user
 *    message after tool results / before assistant prefill) so volatile content
 *    (dynamic state, memory data, implicit context) benefits from the model's recency
 *    bias while keeping the cacheable prefix stable.
 */
export class Assembler {
  /**
   * Deterministically sorts object keys for stable serialization (KV-cache friendliness).
   * This is a purely structural transformation — the input type T is returned unchanged,
   * but TypeScript cannot express "same shape with reordered keys" at the type level,
   * so a single boundary assertion is used to preserve the caller's type.
   */
  public static orderKeysDeterministically<T>(obj: T): T {
    return Assembler._orderKeysRecursive(obj) as T;
  }

  private static _orderKeysRecursive(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(Assembler._orderKeysRecursive);
    const sortedObj: Record<string, unknown> = {};
    const sortedEntries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
    for (const [key, value] of sortedEntries) {
      sortedObj[key] = key === '_cache_breakpoint' ? value : Assembler._orderKeysRecursive(value);
    }
    return sortedObj;
  }

  public static stringifyPayload(payload: unknown): string {
    return JSON.stringify(Assembler.orderKeysDeterministically(payload));
  }

  /**
   * Places `tailXml` at the effective tail of the conversation.
   *
   * This leverages the LLM's Recency Bias: the model pays the most attention
   * to content closest to its generation point (the end of the message array).
   * By placing volatile state here instead of in a system message at the top,
   * we prevent "Lost in the Middle" state drift in long conversations.
   *
   * Placement rules (in order):
   * 1. The conversational tail is the LAST `user` or `tool` message. Anything
   *    after it — assistant prefill, or system messages the sandwich appended
   *    behind history (dynamic state / guardrail in `'system'` placement) —
   *    stays behind the injection point.
   * 2. Tail is a `user` message → the stitch is appended to it, separated by
   *    a blank line. This includes histories ending `[.., user, assistant]`:
   *    at compile time a trailing plain assistant is BY DEFINITION treated
   *    as prefill (a completed answer would not be compiled against), so the
   *    stitch merges into the user turn before it. Callers compiling a
   *    "continue"-style request after a finished assistant answer should
   *    append their next user message first — and should not place a cache
   *    breakpoint on the user message that receives the stitch (the cache
   *    audit's breakpoint-tail diagnosis flags exactly that).
   * 3. Tail is a `tool` result awaiting interpretation → a NEW user message
   *    carrying just the stitch is inserted immediately after it. This is
   *    valid on every target: the Anthropic API auto-merges the consecutive
   *    user-role messages its adapter produces, the Gemini adapter merges
   *    consecutive same-role contents client-side, and OpenAI accepts a user
   *    message after tool results as-is.
   * 4. No user/tool message exists at all → the new user message goes before
   *    any trailing assistant prefill, after the system top layer.
   *
   * Rule 3 previously walked BACK to the most recent user message, which in
   * mid-agent-loop compiles (history ending in tool results) landed the stitch
   * mid-conversation — rewriting a message that cache breakpoints downstream
   * had already hashed, and burying the freshest state away from the
   * generation point. Inserting after the tool results keeps every earlier
   * message byte-identical across compiles. Rule 4 previously pushed the new
   * user message to the absolute end, which put it AFTER an assistant prefill
   * — an [assistant, user] ending that Anthropic rejects and that silently
   * disabled the prefill everywhere else.
   */
  private injectIntoLastUser(messages: Message[], tailXml: string): Message[] {
    const result = [...messages];

    let tail = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user' || result[i].role === 'tool') {
        tail = i;
        break;
      }
    }

    if (tail !== -1 && result[tail].role === 'user') {
      result[tail] = {
        ...result[tail],
        content: `${result[tail].content}\n\n${tailXml}`,
      };
      return result;
    }

    let insertAt: number;
    if (tail !== -1) {
      insertAt = tail + 1;
    } else {
      insertAt = result.length;
      while (insertAt > 0 && result[insertAt - 1].role === 'assistant') insertAt--;
    }
    result.splice(insertAt, 0, { role: 'user', content: tailXml });
    return result;
  }

  /**
   * @internal
   *
   * Compiles the final message array. Invoked by {@link ContextChef.compile}
   * after the sandwich is assembled — not part of the public API. The
   * signature (including {@link AssembleOptions}) may change between minor
   * releases as the compile pipeline evolves.
   *
   * @param messages - The pre-assembled sandwich (top layer + history + any system-placed tails)
   * @param options  - Optional tail-injection stitch built by the caller
   */
  public compile(messages: Message[], options?: AssembleOptions): { messages: Message[] } {
    let assembled = [...messages];

    if (options?.tailXml) {
      assembled = this.injectIntoLastUser(assembled, options.tailXml);
    }

    return {
      messages: assembled.map((msg) => Assembler.orderKeysDeterministically(msg)),
    };
  }
}
