import type {
  ContentBlockParam as SDKContentBlockParam,
  DocumentBlockParam as SDKDocumentBlockParam,
  ImageBlockParam as SDKImageBlockParam,
  MessageParam as SDKMessageParam,
  RedactedThinkingBlockParam as SDKRedactedThinkingBlockParam,
  TextBlockParam as SDKTextBlockParam,
  ThinkingBlockParam as SDKThinkingBlockParam,
  ToolResultBlockParam as SDKToolResultBlockParam,
  ToolUseBlockParam as SDKToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  AnthropicPayload,
  Attachment,
  ChefLogger,
  HistoryMessage,
  Message,
  ParsedMessages,
  ToolCall,
} from '../types';
import { ensureValidHistory } from '../utils/ensureValidHistory';
import type { ITargetAdapter } from './targetAdapter';

// ─── Input: Anthropic → IR ───

/**
 * Converts Anthropic Messages API messages to ContextChef IR.
 * Separates system messages from conversation history.
 *
 * Boundary sanitization: history is run through {@link ensureValidHistory}
 * to fix orphan tool results, missing tool results, and ensure the first
 * non-system message is a user message. This is a system boundary — IR
 * downstream of `setHistory` is trusted to satisfy invariants.
 *
 * Mid-conversation `role: "system"` entries in `messages` (positional system
 * output — announcements and the like) are SKIPPED, not parsed into history:
 * they are volatile channel content whose ownership stays with the chef state
 * that injected it; round-tripping them as durable history would bake them
 * into the cached prefix and defeat `retractAnnouncement()`.
 *
 * @param messages - Anthropic chat messages (user/assistant with content blocks)
 * @param system - Optional top-level system text blocks
 *
 * @example
 * const { system, history } = fromAnthropic(anthropicMessages, anthropicSystem);
 * chef.setSystemPrompt(system).setHistory(history);
 */
export function fromAnthropic(
  messages: SDKMessageParam[],
  system?: SDKTextBlockParam[],
): ParsedMessages {
  const systemMsgs: Message[] = [];
  const history: HistoryMessage[] = [];

  // Top-level system blocks
  if (system) {
    for (const block of system) {
      systemMsgs.push({ role: 'system', content: block.text });
    }
  }

  for (const msg of messages) {
    // `role: "system"` entries inside `messages` split by position. LEADING
    // ones (before any conversation message) are the prompt's system layer —
    // callers who put their system prompt in messages[0] instead of the
    // `system` param — and are routed into `system` so the text survives
    // (pre-4.1 they landed in `history`, violating HistoryMessage's role
    // union). MID-STREAM ones are positional channel output — announcements
    // re-rendered every compile until retracted — and are SKIPPED: feeding
    // them back as durable history would bake volatile text into the cached
    // prefix and defeat retractAnnouncement(). Ownership stays with the chef
    // state that injected it. (The SDK role union predates mid-conversation
    // system messages, hence the widened view.)
    if ((msg as { role: string }).role === 'system') {
      if (history.length === 0) {
        const text =
          typeof msg.content === 'string'
            ? msg.content
            : msg.content
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
        systemMsgs.push({ role: 'system', content: text });
      }
      continue;
    }

    // String content shorthand
    if (typeof msg.content === 'string') {
      history.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks
    const textParts: string[] = [];
    const attachments: Attachment[] = [];
    const toolCalls: ToolCall[] = [];
    let thinking: { thinking: string; signature?: string } | undefined;
    let redactedThinking: { data: string } | undefined;
    let compaction: string | undefined;

    for (const block of msg.content) {
      // Server-side compaction block (compact_20260112). The SDK type union
      // may lag behind the API — match on the type string.
      if ((block as { type: string }).type === 'compaction') {
        compaction = (block as unknown as { content: string }).content;
        continue;
      }
      switch (block.type) {
        case 'text':
          textParts.push(block.text);
          break;
        case 'image': {
          const src = block.source;
          if (src.type === 'base64') {
            attachments.push({
              mediaType: src.media_type,
              data: src.data,
            });
          } else {
            // URLImageSource
            attachments.push({
              mediaType: 'image/*',
              data: src.url,
            });
          }
          break;
        }
        case 'document': {
          const docSrc = block.source;
          if (docSrc.type === 'base64') {
            attachments.push({
              mediaType: docSrc.media_type,
              data: docSrc.data,
            });
          } else if (docSrc.type === 'url') {
            attachments.push({
              mediaType: 'application/pdf',
              data: docSrc.url,
            });
          } else if (docSrc.type === 'text') {
            attachments.push({
              mediaType: docSrc.media_type,
              data: docSrc.data,
            });
          } else if (docSrc.type === 'content') {
            const nested = docSrc.content;
            if (Array.isArray(nested)) {
              for (const c of nested) {
                if (c.type === 'text' && c.text) textParts.push(c.text);
              }
            }
          }
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
          break;
        case 'tool_result':
          // Tool results in Anthropic live inside user messages as content blocks.
          // Flatten to separate IR tool messages.
          history.push({
            role: 'tool',
            content:
              typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? block.content
                      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
                      .map((c) => c.text)
                      .join('\n')
                  : '',
            tool_call_id: block.tool_use_id,
          });
          break;
        case 'thinking':
          thinking = {
            thinking: block.thinking,
            signature: block.signature,
          };
          break;
        case 'redacted_thinking':
          redactedThinking = { data: block.data };
          break;
        default:
          // Unknown block types are silently skipped
          break;
      }
    }

    // Only push a message for the role if there's meaningful content
    if (
      textParts.length ||
      toolCalls.length ||
      attachments.length ||
      thinking ||
      redactedThinking ||
      compaction !== undefined
    ) {
      const ir: HistoryMessage = {
        role: msg.role,
        content: textParts.join('\n'),
      };
      if (attachments.length) ir.attachments = attachments;
      if (toolCalls.length) ir.tool_calls = toolCalls;
      if (thinking) ir.thinking = thinking;
      if (redactedThinking) ir.redacted_thinking = redactedThinking;
      if (compaction !== undefined) {
        // Passthrough field re-emitted verbatim by the Anthropic target
        // adapter. Pinned so no lossy operation (compress/compact) can
        // destroy it — the API drops everything before this block, so
        // losing it would lose the whole compacted history.
        ir._anthropic_compaction = compaction;
        ir.pinned = true;
      }
      history.push(ir);
    }
  }

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Cast is safe — ensureValidHistory only inserts user/tool messages, never system.
  return { system: systemMsgs, history: ensureValidHistory(history) as HistoryMessage[] };
}

// ─── Output: IR → Anthropic ───

/** Converts IR attachments to Anthropic image/document content blocks. */
function attachmentsToBlocks(attachments: Attachment[]): SDKContentBlockParam[] {
  const blocks: SDKContentBlockParam[] = [];
  for (const att of attachments) {
    const isUrl = att.data.startsWith('http');
    if (att.mediaType.startsWith('image/')) {
      const block: SDKImageBlockParam = isUrl
        ? { type: 'image', source: { type: 'url', url: att.data } }
        : {
            type: 'image',
            source: {
              type: 'base64',
              media_type: att.mediaType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
              data: att.data,
            },
          };
      blocks.push(block);
    } else {
      const block: SDKDocumentBlockParam = isUrl
        ? { type: 'document', source: { type: 'url', url: att.data } }
        : {
            type: 'document',
            source: {
              type: 'base64',
              media_type: att.mediaType as 'application/pdf',
              data: att.data,
            },
          };
      blocks.push(block);
    }
  }
  return blocks;
}

export interface AnthropicAdapterOptions {
  /** Sink for degradation warnings. Defaults to `console`. */
  logger?: ChefLogger;
}

export class AnthropicAdapter implements ITargetAdapter {
  private _positionalHoistWarned = false;

  constructor(private readonly options: AnthropicAdapterOptions = {}) {}

  compile(messages: Message[]): AnthropicPayload {
    const systemMessages: SDKTextBlockParam[] = [];
    const chatMessages: SDKMessageParam[] = [];
    // The API accepts a mid-conversation system message only immediately
    // after a user turn (IR: a user or tool message — tool results map to
    // user-role tool_result content). Anywhere else — leading the stream,
    // after a plain assistant turn, or between a tool_use and its
    // tool_result — the payload 400s, so those positions hoist instead.
    // Consecutive positional system messages after a user turn are fine
    // (the API treats them as one section).
    let afterUserTurn = false;

    for (const msg of messages) {
      if (msg.role === 'system') {
        const sysObj: SDKTextBlockParam = { type: 'text', text: msg.content };
        if (msg._cache_breakpoint) {
          sysObj.cache_control = { type: 'ephemeral' };
        }
        if (msg._positional && afterUserTurn) {
          // Mid-conversation `role: "system"` messages are an API feature newer
          // than the SDK's MessageParam role union — cast at this one emission
          // point rather than widening the type everywhere.
          chatMessages.push({ role: 'system', content: [sysObj] } as unknown as SDKMessageParam);
          continue;
        }
        if (msg._positional && !this._positionalHoistWarned) {
          this._positionalHoistWarned = true;
          (this.options.logger ?? console).warn(
            '[context-chef] a positional system message was not immediately after a user turn ' +
              '(user message or tool result) — the Anthropic API rejects it there, so it was ' +
              'hoisted into the top-level system prompt (warned once).',
          );
        }
        systemMessages.push(sysObj);
      } else {
        afterUserTurn = msg.role === 'user' || msg.role === 'tool';
        const role: 'user' | 'assistant' =
          msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant');
        const content: SDKContentBlockParam[] = [];

        // Re-emit a server-side compaction block verbatim, ahead of any other
        // content of the message (the API ignores everything before it).
        if (typeof msg._anthropic_compaction === 'string') {
          content.push({
            type: 'compaction',
            content: msg._anthropic_compaction,
          } as unknown as SDKContentBlockParam);
        }

        if (msg.role === 'tool') {
          const block: SDKToolResultBlockParam = {
            type: 'tool_result',
            tool_use_id: msg.tool_call_id ?? '',
            content: msg.content,
          };
          content.push(block);
        } else if (msg.tool_calls) {
          // Prepend thinking blocks before tool_use blocks (Anthropic requirement)
          if (msg.thinking) {
            const thinkingBlock: SDKThinkingBlockParam = {
              type: 'thinking',
              thinking: msg.thinking.thinking,
              signature: msg.thinking.signature ?? '',
            };
            content.push(thinkingBlock);
          }
          if (msg.redacted_thinking) {
            const redactedBlock: SDKRedactedThinkingBlockParam = {
              type: 'redacted_thinking',
              data: msg.redacted_thinking.data,
            };
            content.push(redactedBlock);
          }
          const textBlock: SDKTextBlockParam = { type: 'text', text: msg.content || '' };
          content.push(textBlock);
          // Attachments after text, before tool_use blocks
          if (msg.attachments?.length) {
            content.push(...attachmentsToBlocks(msg.attachments));
          }
          for (const tc of msg.tool_calls) {
            const block: SDKToolUseBlockParam = {
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments),
            };
            content.push(block);
          }
        } else {
          // Prepend thinking blocks before text block
          if (msg.thinking) {
            const thinkingBlock: SDKThinkingBlockParam = {
              type: 'thinking',
              thinking: msg.thinking.thinking,
              signature: msg.thinking.signature ?? '',
            };
            content.push(thinkingBlock);
          }
          if (msg.redacted_thinking) {
            const redactedBlock: SDKRedactedThinkingBlockParam = {
              type: 'redacted_thinking',
              data: msg.redacted_thinking.data,
            };
            content.push(redactedBlock);
          }
          const block: SDKTextBlockParam = { type: 'text', text: msg.content };
          if (msg._cache_breakpoint) {
            block.cache_control = { type: 'ephemeral' };
          }
          content.push(block);
          // Attachments after text block
          if (msg.attachments?.length) {
            content.push(...attachmentsToBlocks(msg.attachments));
          }
        }

        chatMessages.push({ role, content });
      }
    }

    return {
      system: systemMessages.length > 0 ? systemMessages : undefined,
      messages: chatMessages,
    };
  }
}
