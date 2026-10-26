import { createHash } from 'node:crypto';
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
import { Assembler } from '../modules/assembler';
import { isThinkingBlock } from '../prefix';
import type {
  AnthropicPayload,
  Attachment,
  ChefLogger,
  HistoryMessage,
  Message,
  ParsedMessages,
  ToolCall,
} from '../types';
import { ensureValidHistory, isOpeningPlaceholder } from '../utils/ensureValidHistory';
import type { ITargetAdapter } from './targetAdapter';

// ─── Input: Anthropic → IR ───

/** Options for {@link fromAnthropic}. */
export interface FromAnthropicOptions {
  /**
   * Keep the mid-conversation `role: "system"` messages in `history`, where
   * they were, as positional system messages (`_positional`, plus
   * `_clear_at` for a turn-scoped one), so they are sent again unchanged.
   * For the system messages your own code writes: a payload the chef
   * compiled also holds the chef's announcements and events, which it adds
   * again by itself. Default `false`: they are skipped, as in 4.x, and a
   * history that had one changes where it was.
   *
   * A system message's text blocks are joined with `\n` into one, and it is
   * sent back as one text block. The chef only ever sends one, but if you
   * sent several in one system message yourself, the next request changes
   * there.
   */
  keepPositionalSystem?: boolean;
}

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
 * into the cached prefix and defeat `retractAnnouncement()`. Pass
 * `keepPositionalSystem` for the ones you wrote yourself; `history` then
 * holds system messages too.
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
  options?: FromAnthropicOptions & { keepPositionalSystem?: false },
): ParsedMessages;
export function fromAnthropic(
  messages: SDKMessageParam[],
  system: SDKTextBlockParam[] | undefined,
  options: FromAnthropicOptions,
): { system: Message[]; history: Message[] };
export function fromAnthropic(
  messages: SDKMessageParam[],
  system?: SDKTextBlockParam[],
  options: FromAnthropicOptions = {},
): { system: Message[]; history: Message[] } {
  const systemMsgs: Message[] = [];
  const history: Message[] = [];

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
    // state that injected it — unless the caller says it wrote them. (The SDK
    // role union predates mid-conversation system messages, hence the
    // widened view.)
    if ((msg as { role: string }).role === 'system') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
      if (history.length === 0) {
        systemMsgs.push({ role: 'system', content: text });
      } else if (options.keepPositionalSystem) {
        const turnScoped = (msg as { clear_at?: unknown }).clear_at === 'next_user_message';
        history.push({
          role: 'system',
          content: text,
          _positional: true,
          ...(turnScoped ? { _clear_at: 'next_user_message' as const } : {}),
        });
      }
      continue;
    }

    // String content shorthand
    if (typeof msg.content === 'string') {
      history.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Complex content blocks. Everything parsed from this message is collected
    // first so the group can be stamped with its origin (see stampOrigin).
    const parsed: HistoryMessage[] = [];
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
          parsed.push({
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
      parsed.push(ir);
    }

    stampOrigin(parsed, msg.content);
    history.push(...parsed);
  }

  // Sanitize at boundary: enforce IR invariants before handing to caller.
  // Without keepPositionalSystem the history holds no system message, as the
  // first overload says: ensureValidHistory only inserts user/tool messages.
  return { system: systemMsgs, history: ensureValidHistory(history) };
}

/**
 * Hash of the IR fields the Anthropic target would otherwise rebuild a message
 * from. Key order is normalized: compile() re-orders keys deterministically,
 * which must not read as a modification.
 */
function irHash(msg: Message): string {
  const fields = [
    msg.role,
    msg.content,
    msg.tool_call_id,
    msg.tool_calls,
    msg.thinking,
    msg.redacted_thinking,
    msg.attachments,
    msg._anthropic_compaction,
  ];
  return createHash('sha256')
    .update(Assembler.stringifyPayload(fields))
    .digest('hex')
    .substring(0, 16);
}

/** Records on each IR message parsed from one wire message where it came from. */
function stampOrigin(parsed: HistoryMessage[], blocks: SDKContentBlockParam[]): void {
  parsed.forEach((msg, part) => {
    msg._anthropic_origin = {
      ...(part === 0 ? { blocks: structuredClone(blocks) } : {}),
      part,
      parts: parsed.length,
      hash: irHash(msg),
    };
  });
}

/** A compaction block as on-demand compaction (beta `compact-2026-09-04`) returns it. */
export interface AnthropicCompactionBlock {
  type: 'compaction';
  content: string;
  signature: string;
  tool_changes?: unknown;
}

/**
 * The history message that replays `block` verbatim: every later request has
 * to send it unchanged, first in `messages`, in place of the messages it
 * summarized. It is the message `fromAnthropic` parses the block into — the
 * summary in `_anthropic_compaction`, the signed block in
 * `_anthropic_origin`, pinned — so the Anthropic target sends the block
 * itself and the other targets inline the summary.
 */
export function anthropicCompactionMessage(block: AnthropicCompactionBlock): HistoryMessage {
  const message: HistoryMessage = {
    role: 'assistant',
    content: '',
    _anthropic_compaction: block.content,
    pinned: true,
  };
  stampOrigin([message], [block as unknown as SDKContentBlockParam]);
  return message;
}

/**
 * A copy of `message` without its thinking. Removing thinking is the one
 * edit the signature check allows, so when the message still matches the
 * original it was parsed from, the original loses only its thinking blocks
 * and the Anthropic target goes on replaying every other block as it was
 * sent: server tool blocks, citations, separate text blocks. A message its
 * original no longer matches is rebuilt from IR, as before.
 */
export function withoutThinking(message: Message): Message {
  const { thinking: _thinking, redacted_thinking: _redacted, ...rest } = message;
  const origin = message._anthropic_origin;
  if (!origin || origin.hash !== irHash(message)) return rest;
  const blocks = (origin.blocks as SDKContentBlockParam[] | undefined)?.filter(
    (block) => !isThinkingBlock(block),
  );
  // Nothing but thinking: nothing left to replay.
  if (blocks?.length === 0) return rest;
  return {
    ...rest,
    _anthropic_origin: { ...origin, ...(blocks ? { blocks } : {}), hash: irHash(rest) },
  };
}

/**
 * Whether this target has nothing to send for `message` but a text block with
 * no text, which the API rejects: an assistant turn with no thinking, text,
 * tool call, attachment or compaction, and no original it still replays.
 * What {@link withoutThinking} leaves of a reply that held only thinking.
 */
export function sendsNothing(message: Message): boolean {
  if (message.role !== 'assistant' || message.content.trim() !== '') return false;
  if (message.thinking || message.redacted_thinking) return false;
  if (message.tool_calls?.length || message.attachments?.length) return false;
  if (message._anthropic_compaction !== undefined) return false;
  const origin = message._anthropic_origin;
  return origin === undefined || origin.hash !== irHash(message);
}

// ─── Output: IR → Anthropic ───

/**
 * A copy of `value` whose objects and arrays are new, all the way down.
 * Strings are shared: nothing can edit one, and a block's base64 is the bulk
 * of it.
 */
function copyBlock<T>(value: T): T {
  if (Array.isArray(value)) return value.map(copyBlock) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyBlock(v)])) as T;
}

/**
 * A copy of `block` without `cache_control`. Breakpoints are the chef's to
 * place (`_cache_breakpoint`); markers carried in from the original could
 * push a request past the API's four-breakpoint limit. The copy is deep, so
 * an edit to the returned payload, however nested, stays out of the stored
 * original.
 */
function withoutCacheControl(block: SDKContentBlockParam): SDKContentBlockParam {
  const { cache_control: _dropped, ...rest } = block as SDKContentBlockParam & {
    cache_control?: unknown;
  };
  return copyBlock(rest) as SDKContentBlockParam;
}

/**
 * The original message `messages[start]` was parsed from, if every IR message
 * parsed from it is still here, in order, with the fields it was parsed with.
 */
function replayOrigin(
  messages: Message[],
  start: number,
): { message: SDKMessageParam; parts: number } | undefined {
  const head = messages[start]._anthropic_origin;
  if (!head?.blocks || head.part !== 0) return undefined;

  const group = messages.slice(start, start + head.parts);
  const intact =
    group.length === head.parts &&
    group.every((msg, part) => {
      const origin = msg._anthropic_origin;
      return origin?.part === part && origin.parts === head.parts && origin.hash === irHash(msg);
    });
  if (!intact) return undefined;

  const content = (head.blocks as SDKContentBlockParam[]).map(withoutCacheControl);
  if (group.some((msg) => msg._cache_breakpoint)) cacheLastBlock(content);
  const role = messages[start].role === 'assistant' ? 'assistant' : 'user';
  return { message: { role, content }, parts: head.parts };
}

/** Thinking blocks can't carry a breakpoint; the last other block caches the whole message. */
function cacheLastBlock(content: SDKContentBlockParam[]): void {
  const last = [...content].reverse().find((b) => !isThinkingBlock(b));
  if (last) (last as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
}

/**
 * Puts a breakpoint meant for a turn-scoped message on the message before it
 * that is not turn-scoped: a cleared message is part of no cache key, and the
 * API rejects `cache_control` on one.
 */
function breakpointBefore(chatMessages: SDKMessageParam[]): void {
  for (let i = chatMessages.length - 1; i >= 0; i--) {
    const { content, clear_at } = chatMessages[i] as SDKMessageParam & { clear_at?: unknown };
    if (clear_at !== undefined) continue;
    if (Array.isArray(content)) cacheLastBlock(content);
    return;
  }
}

/**
 * An assistant message's thinking blocks, ahead of everything else it says.
 * The API accepts a thinking block only with the signature it was returned
 * with, so one without a signature is not sent at all.
 */
function thinkingBlocks(msg: Message): SDKContentBlockParam[] {
  const blocks: SDKContentBlockParam[] = [];
  if (msg.thinking?.signature) {
    const thinkingBlock: SDKThinkingBlockParam = {
      type: 'thinking',
      thinking: msg.thinking.thinking,
      signature: msg.thinking.signature,
    };
    blocks.push(thinkingBlock);
  }
  if (msg.redacted_thinking) {
    const redactedBlock: SDKRedactedThinkingBlockParam = {
      type: 'redacted_thinking',
      data: msg.redacted_thinking.data,
    };
    blocks.push(redactedBlock);
  }
  return blocks;
}

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

// ─── Server-side context management ───

/**
 * The two Anthropic request fields a server-managed compile emits.
 * `context_management` is spread into the Messages API request verbatim;
 * `betas` goes into the `anthropic-beta` header / SDK `betas` option.
 */
export interface AnthropicServerContextManagement {
  context_management: unknown;
  betas: string[];
}

/** Turn-scoped system messages (`clear_at`). */
const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21';

/** On-demand compaction, and every request that replays the signed block it returned. */
export const ON_DEMAND_COMPACTION_BETA = 'compact-2026-09-04';

/**
 * The betas a compiled payload needs for the compaction block it replays: a
 * signed block — what on-demand compaction returns, and what `fromAnthropic`
 * resumes — needs `compact-2026-09-04` in every request that sends it, however
 * the window came to start with it.
 */
export function replayedCompactionBetas(payload: AnthropicPayload): string[] {
  const signed = payload.messages.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => {
        const { type, signature } = block as { type: string; signature?: unknown };
        return type === 'compaction' && typeof signature === 'string';
      }),
  );
  return signed ? [ON_DEMAND_COMPACTION_BETA] : [];
}

/** Maps an edits config to the `anthropic-beta` values its edit types require. */
function computeAnthropicBetas(config: unknown): string[] {
  const betas = new Set<string>();
  const edits = (config as { edits?: Array<{ type?: string }> } | undefined)?.edits ?? [];
  for (const edit of edits) {
    if (edit?.type === 'compact_20260112') betas.add('compact-2026-01-12');
    else if (edit?.type) betas.add('context-management-2025-06-27');
  }
  return [...betas];
}

/**
 * Resolves `ChefConfig.contextManagement.server` into the payload fields the
 * Anthropic Messages API expects under server-side context management.
 *
 * Passing `undefined` (strategy `'server'` with no explicit edits config)
 * yields a single `compact_20260112` edit on the server's default trigger.
 * The provider-shaped config is otherwise passed through untouched — only the
 * beta headers it implies are derived from it.
 */
export function anthropicServerContextManagement(
  config?: unknown,
): AnthropicServerContextManagement {
  const context_management = config ?? { edits: [{ type: 'compact_20260112' }] };
  return { context_management, betas: computeAnthropicBetas(context_management) };
}

export class AnthropicAdapter implements ITargetAdapter {
  readonly anthropicWire = true;
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
    let turnScoped = false;

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      // A history that opens with a compaction block (on-demand compaction)
      // gets a placeholder user turn from ensureValidHistory, but the API
      // requires the block itself to come first.
      if (
        chatMessages.length === 0 &&
        isOpeningPlaceholder(msg) &&
        messages.slice(i + 1).find((m) => m.role !== 'system')?._anthropic_compaction !== undefined
      ) {
        continue;
      }
      const replayed = msg.role === 'system' ? undefined : replayOrigin(messages, i);
      if (replayed) {
        chatMessages.push(replayed.message);
        afterUserTurn = replayed.message.role === 'user';
        i += replayed.parts - 1;
        continue;
      }

      if (msg.role === 'system') {
        const sysObj: SDKTextBlockParam = { type: 'text', text: msg.content };
        // Turn-scoped only where it stays a positional message: hoisted, it would never clear.
        const clearAt = msg._positional && afterUserTurn && msg._clear_at === 'next_user_message';
        if (msg._cache_breakpoint) {
          if (clearAt) breakpointBefore(chatMessages);
          else sysObj.cache_control = { type: 'ephemeral' };
        }
        if (msg._positional && afterUserTurn) {
          // Mid-conversation `role: "system"` messages are an API feature newer
          // than the SDK's MessageParam role union — cast at this one emission
          // point rather than widening the type everywhere.
          const positional = clearAt
            ? { role: 'system', clear_at: 'next_user_message', content: [sysObj] }
            : { role: 'system', content: [sysObj] };
          chatMessages.push(positional as unknown as SDKMessageParam);
          if (clearAt) turnScoped = true;
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
          content.push(...thinkingBlocks(msg));
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
          content.push(...thinkingBlocks(msg));
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
      ...(turnScoped ? { betas: [CLEAR_AT_BETA] } : {}),
    };
  }
}
