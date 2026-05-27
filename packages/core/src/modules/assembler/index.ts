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
 * payload. If no last user message exists, a new one is created carrying
 * just the stitch.
 */
export interface AssembleOptions {
  /** XML stitch to append to the last user message at the tail of the conversation. */
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
 * 2. **Tail injection**: Appends a caller-built XML stitch to the last user message so
 *    volatile content (dynamic state, memory data, implicit context) benefits from the
 *    model's recency bias while keeping the cacheable prefix stable.
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
   * Appends `tailXml` to the last user message in the array, separated by a
   * blank line. If no user message exists, a new one is created carrying just
   * the stitch.
   *
   * This leverages the LLM's Recency Bias: the model pays the most attention
   * to content closest to its generation point (the end of the message array).
   * By placing volatile state here instead of in a system message at the top,
   * we prevent "Lost in the Middle" state drift in long conversations.
   */
  private injectIntoLastUser(messages: Message[], tailXml: string): Message[] {
    const block = `\n\n${tailXml}`;

    const result = [...messages];
    let lastUserIndex = -1;
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }

    if (lastUserIndex !== -1) {
      result[lastUserIndex] = {
        ...result[lastUserIndex],
        content: result[lastUserIndex].content + block,
      };
    } else {
      result.push({
        role: 'user',
        content: block.trim(),
      });
    }

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
