import type { Message } from '../../types';

export type DynamicStatePlacement = 'system' | 'last_user';

export interface StitchOptions {
  /** XML content of the dynamic state to inject */
  dynamicStateXml?: string;
  /** Where to inject the dynamic state */
  placement?: DynamicStatePlacement;
}

/**
 * The Stitcher is the physical compiler of the Sandwich Model.
 *
 * It has two responsibilities:
 * 1. **Deterministic Serialization**: Guarantees identical byte-level output for identical
 *    logical inputs by sorting JSON keys lexicographically. This maximizes KV-Cache hits.
 * 2. **Sandwich Assembly**: Physically arranges Top Layer, Rolling History, and Dynamic State
 *    into the optimal position within the message array, respecting the configured placement
 *    strategy (system message vs last-user-message injection).
 */
export class Stitcher {
  public static orderKeysDeterministically(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(Stitcher.orderKeysDeterministically);
    const sortedObj: Record<string, unknown> = {};
    const keys = Object.keys(obj as object).sort();
    const src = obj as Record<string, unknown>;
    for (const key of keys) {
      if (key !== '_cache_breakpoint') {
        sortedObj[key] = Stitcher.orderKeysDeterministically(src[key]);
      } else {
        sortedObj[key] = src[key];
      }
    }
    return sortedObj;
  }

  public static stringifyPayload(payload: unknown): string {
    return JSON.stringify(Stitcher.orderKeysDeterministically(payload));
  }

  /**
   * Injects the dynamic state XML into the last user message in the array.
   * If no user message exists, appends a new one.
   *
   * This leverages the LLM's Recency Bias: the model pays the most attention
   * to content closest to its generation point (the end of the message array).
   * By placing state here instead of in a system message at the top, we prevent
   * "Lost in the Middle" state drift in long conversations.
   */
  private injectIntoLastUser(messages: Message[], dynamicStateXml: string): Message[] {
    const stateBlock = `\n\n<dynamic_state>\n${dynamicStateXml}\n</dynamic_state>\nAbove is the current system state. Use it to guide your next action.`;

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
        content: result[lastUserIndex].content + stateBlock,
      };
    } else {
      result.push({
        role: 'user',
        content: stateBlock.trim(),
      });
    }

    return result;
  }

  /**
   * Compiles the final message array.
   *
   * @param messages - The pre-assembled sandwich (topLayer + history + dynamicState system messages)
   * @param options  - Optional stitch options for last_user injection
   */
  public compile(messages: Message[], options?: StitchOptions): { messages: Message[] } {
    let assembled = [...messages];

    if (options?.dynamicStateXml && options.placement === 'last_user') {
      assembled = this.injectIntoLastUser(assembled, options.dynamicStateXml);
    }

    return {
      messages: assembled.map((msg) => Stitcher.orderKeysDeterministically(msg) as Message),
    };
  }
}
