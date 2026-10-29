/**
 * Verify Thinking Prefix — the API-key experiments behind `appendOnly`
 *
 * Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 sign every thinking
 * block over everything sent before it (docs-site/guide/thinking-prefix.md).
 * `appendOnly` (docs-site/guide/append-only.md) is built on what Anthropic's
 * docs say that check accepts, and none of it has been sent to the API yet.
 * Each experiment below answers lines of TODO.md "Needs an API key": it sends
 * the request shapes ContextChef produces and prints, for each request,
 *
 *   ACCEPTED
 *   REJECTED <status> <error.message>
 *
 * and, where the question is more than whether the API takes it, what came
 * back. The requests are plain `fetch` calls with their bodies built here, so
 * what is tested is what you read; `--bodies` prints them.
 *
 * Every request sends `thinking.block_binding.prefix_mismatch_behavior:
 * "error"` with the `thinking-binding-controls-2026-08-01` beta. The check
 * then runs whatever the account's age, as it does by default on accounts
 * created on or after 2026-08-31, and ACCEPTED means every thinking block the
 * request sent back was verified. `check-enforced` runs first to confirm it.
 *
 * Left out: the AI SDK and TanStack AI lines of that list, which need those
 * SDKs' provider packages, and the OpenAI / Gemini `cached_tokens` line,
 * which needs those providers' keys.
 *
 * Usage, from the repository root, with ANTHROPIC_API_KEY in the gitignored
 * .env.local (the script never prints it):
 *
 *   pnpm --filter @context-chef/core build
 *   node --env-file=.env.local examples/verify-thinking-prefix.ts [options]
 *
 *   --model <id>    default claude-sonnet-5-5; run `system-after-tool-result`
 *                   again with claude-haiku-5-5
 *   --only <name>   one experiment; --list names them
 *   --diagnostic    send the beta without `block_binding`. On an account
 *                   created before 2026-08-31 nothing is then rejected: a
 *                   block that fails the check still reaches the model and is
 *                   listed in `input_transformations` as
 *                   `thinking_mismatch_allowed`, printed after every request
 *   --bodies        print every request body before sending it
 *   --dry-run       print the bodies and answer them with canned replies:
 *                   sends nothing and needs no key
 *   --list
 *
 * A full run sends about 50 requests, most of them a few thousand input
 * tokens. The four of `clear-at-reminder` carry a ~5k-token reminder, and the
 * first one of `server-block-beta` ~60k tokens to trigger server-side
 * compaction.
 */

import { parseArgs } from 'node:util';
import { ContextChef, fromAnthropic, InMemoryStore, summarize } from '@context-chef/core';
import { z } from 'zod';

const { values: args } = parseArgs({
  options: {
    model: { type: 'string', default: 'claude-sonnet-5-5' },
    only: { type: 'string' },
    diagnostic: { type: 'boolean', default: false },
    bodies: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
  },
});
const model = args.model;
const dryRun = args['dry-run'];
const apiKey = process.env.ANTHROPIC_API_KEY ?? '';

const API_URL = 'https://api.anthropic.com/v1/messages';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const CLEAR_AT_BETA = 'mid-conversation-system-clear-at-2026-08-21';
const ON_DEMAND_BETA = 'compact-2026-09-04';
const SERVER_COMPACTION_BETA = 'compact-2026-01-12';

/** A request sent to see whether the API takes it. */
const PROBE_MAX_TOKENS = 512;
/** A reply whose thinking a later request sends back. */
const REPLY_MAX_TOKENS = 2048;
const COMPACTION_MAX_TOKENS = 4096;

/**
 * `budget_tokens` is rejected on these models; adaptive thinking may skip
 * thinking on an easy turn, so a reply that has to come with a signed block
 * is asked for at the lowest effort that returns one.
 */
const EFFORTS = ['low', 'medium', 'high'] as const;
type Effort = (typeof EFFORTS)[number];

// ─── The wire ───

interface Block {
  type: string;
  [field: string]: unknown;
}

interface WireMessage {
  role: 'user' | 'assistant' | 'system';
  content: Block[];
  clear_at?: 'next_user_message';
}

interface Reply {
  content: Block[];
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  input_transformations?: unknown[];
}

type Result = { ok: true; reply: Reply } | { ok: false; status: number; message: string };

type Body = Record<string, unknown>;

/** An experiment that can't ask its question, with the reason. */
class Skipped extends Error {}

// The system prompt is padded past the minimum a prompt cache entry needs,
// for `compaction-cache-hit`.
const SYSTEM_TEXT = [
  'You are a weather assistant in an API test. Use get_weather for every city you are asked ' +
    'about, and answer in one short sentence.',
  '',
  'Station register (reference only, never needed for an answer):',
  ...Array.from(
    { length: 80 },
    (_, i) => `Station ${i + 1}: elevation ${(i + 1) * 7} m, sensor WX-${101 + i}, calibrated.`,
  ),
].join('\n');
const SYSTEM: Block[] = [{ type: 'text', text: SYSTEM_TEXT }];

const TOOLS = [
  {
    name: 'get_weather',
    description: 'The current weather in a city.',
    input_schema: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
];

const WEATHER: Record<string, string> = {
  Paris: '18°C, clear',
  Tokyo: '24°C, humid',
  London: '12°C, light rain',
  Oslo: '4°C, snow',
};

const QUESTION =
  'What is the weather in Paris and in Tokyo? Call get_weather for both cities in the same ' +
  'turn, then answer.';
const FOLLOW_UP = 'Thanks. Which of the two cities is warmer, and by how many degrees?';
/** A dynamic-state event as `appendOnly` appends one: its own user message. */
const EVENT =
  '<dynamic_state rev="1">\n  <units>celsius</units>\n</dynamic_state>\n\n' +
  'Above is the current system state. Each block supersedes any earlier block of its kind ' +
  '(same tag and id). Use it to guide your next action.';
/** A 16×16 PNG, for the attachment-only user message. */
const IMAGE: Block = {
  type: 'image',
  source: {
    type: 'base64',
    media_type: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mPQqDhBEmIY1TCqYfhqAADDSmgQB35GTAAAAABJRU5ErkJggg==',
  },
};

const text = (value: string): Block => ({ type: 'text', text: value });
const user = (value: string): WireMessage => ({ role: 'user', content: [text(value)] });
const assistant = (content: Block[]): WireMessage => ({ role: 'assistant', content });
const system = (value: string, turnScoped = false): WireMessage => ({
  role: 'system',
  content: [text(value)],
  ...(turnScoped ? { clear_at: 'next_user_message' as const } : {}),
});

const isThinking = (block: Block) =>
  block.type === 'thinking' || block.type === 'redacted_thinking';
const isSignedThinking = (block: Block) =>
  block.type === 'thinking' && typeof block.signature === 'string' && block.signature !== '';
const toolUses = (message: WireMessage) => message.content.filter((b) => b.type === 'tool_use');
const withoutThinking = (message: WireMessage) =>
  assistant(message.content.filter((block) => !isThinking(block)));

function weatherFor(use: Block): string {
  const city = String((use.input as { city?: unknown } | undefined)?.city);
  return WEATHER[city] ?? '20°C, cloudy';
}

/** The user message answering every tool call of `call`. */
function toolResults(call: WireMessage): WireMessage {
  return {
    role: 'user',
    content: toolUses(call).map((use) => ({
      type: 'tool_result',
      tool_use_id: use.id,
      content: weatherFor(use),
    })),
  };
}

function compactionBlock(reply: Reply): Block | undefined {
  return reply.content.find((block) => block.type === 'compaction');
}

function replyText(reply: Reply): string {
  const said = reply.content
    .filter((block) => block.type === 'text')
    .map((block) => String(block.text))
    .join(' ')
    .replace(/\s+/g, ' ');
  return said.length > 140 ? `${said.slice(0, 140)}…` : said;
}

// ─── Sending ───

function thinking(binding: 'error' | 'drop_block' = 'error'): Body {
  return args.diagnostic
    ? { type: 'adaptive' }
    : { type: 'adaptive', block_binding: { prefix_mismatch_behavior: binding } };
}

/** A request over the shared system prompt and tools; `fields` override any field. */
function request(messages: readonly WireMessage[], fields: Body = {}): Body {
  return {
    model,
    max_tokens: PROBE_MAX_TOKENS,
    system: SYSTEM,
    tools: TOOLS,
    thinking: thinking(),
    output_config: { effort: 'low' },
    messages,
    ...fields,
  };
}

/** For a printed body: the shared system prompt and tools by name, long strings cut short. */
function shorten(_key: string, value: unknown): unknown {
  if (value === SYSTEM) return '(the shared system prompt)';
  if (value === TOOLS) return '(the shared tools)';
  return typeof value === 'string' && value.length > 200
    ? `${value.slice(0, 60)}… (${value.length} characters)`
    : value;
}

async function post(body: Body, betas: readonly string[] = []): Promise<Result> {
  const beta = [...new Set([BINDING_BETA, ...betas])].join(',');
  if (args.bodies || dryRun) {
    const printed = JSON.stringify({ 'anthropic-beta': beta, ...body }, shorten, 2);
    console.log(printed.replace(/^/gm, '      '));
  }
  if (dryRun) return { ok: true, reply: cannedReply(body) };

  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': beta,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
    } catch (error) {
      return { ok: false, status: 0, message: error instanceof Error ? error.message : `${error}` };
    }
    // A rate limit or an overloaded server says nothing about the request: ask again.
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      const seconds = Number(response.headers.get('retry-after')) || 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      continue;
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (response.ok) return { ok: true, reply: json as Reply };
    const error = (json as { error?: { message?: string } } | undefined)?.error;
    return { ok: false, status: response.status, message: error?.message ?? response.statusText };
  }
}

let canned = 0;

/**
 * What `--dry-run` answers instead of the API: a signed thinking block, then
 * a get_weather call for each city the last message names, or a short reply;
 * a compaction block when one is asked for.
 */
function cannedReply(body: Body): Reply {
  const n = ++canned;
  const usage = {
    input_tokens: Math.round(JSON.stringify(body).length / 4),
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const signed: Block = { type: 'thinking', thinking: '', signature: `DRY_RUN_SIGNATURE_${n}` };
  if (body.compaction !== undefined || body.context_management !== undefined) {
    const block = {
      type: 'compaction',
      content: `Dry-run summary ${n}.`,
      signature: `DRY_RUN_${n}`,
    };
    return {
      content: body.compaction ? [block] : [block, signed, text('OK')],
      stop_reason: body.compaction ? 'compaction' : 'end_turn',
      usage,
      input_transformations: [],
    };
  }
  const messages = body.messages as WireMessage[];
  const said = JSON.stringify(messages[messages.length - 1]);
  const cities = Object.keys(WEATHER).filter((city) => said.includes(city));
  const calls = cities.map((city, i) => ({
    type: 'tool_use',
    id: `toolu_dry_run_${n}_${i}`,
    name: 'get_weather',
    input: { city },
  }));
  return {
    content: [signed, ...(calls.length ? calls : [text('Dry-run reply. ZEBRA-42')])],
    stop_reason: calls.length ? 'tool_use' : 'end_turn',
    usage,
    input_transformations: [],
  };
}

// ─── Printing ───

function outcome(result: Result): string {
  return result.ok ? 'ACCEPTED' : `REJECTED ${result.status} ${result.message}`;
}

function tokens(reply: Reply): string {
  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens } = reply.usage;
  return (
    `${input_tokens} input tokens, ${cache_read_input_tokens ?? 0} read from the cache, ` +
    `${cache_creation_input_tokens ?? 0} written to it`
  );
}

/** Where result lines start: deeper under a heading inside an experiment. */
let indent = '  ';

function report(label: string, result: Result, detail?: (reply: Reply) => string): void {
  console.log(`${indent}${label}: ${outcome(result)}`);
  if (!result.ok) return;
  if (detail) console.log(`${indent}  ${detail(result.reply)}`);
  const transformations = result.reply.input_transformations ?? [];
  if (args.diagnostic || transformations.length > 0) {
    console.log(`${indent}  input_transformations: ${JSON.stringify(transformations)}`);
  }
}

/** A verdict or what a result means: one note, its lines under one arrow. */
function note(...lines: string[]): void {
  for (const [i, line] of lines.entries()) console.log(`${indent}${i === 0 ? '→' : ' '} ${line}`);
}

const thinkingBlocks = (count: number) => `${count} thinking block${count === 1 ? '' : 's'}`;

// ─── Shared turns ───

/** Runs `make` once, however many experiments build on what it returns. */
function once<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => {
    made ??= make();
    return made;
  };
}

interface Thought {
  result: Result;
  reply?: Reply;
  effort: Effort;
}

/** Asks for a reply that comes with a signed thinking block, at the lowest effort that gives one. */
async function think(
  messages: readonly WireMessage[],
  { betas = [], from = 'low' }: { betas?: readonly string[]; from?: Effort } = {},
): Promise<Thought> {
  for (const effort of EFFORTS.slice(EFFORTS.indexOf(from))) {
    const body = request(messages, { max_tokens: REPLY_MAX_TOKENS, output_config: { effort } });
    const result = await post(body, betas);
    if (!result.ok) return { result, effort };
    if (result.reply.content.some(isSignedThinking)) return { result, reply: result.reply, effort };
  }
  throw new Skipped('no reply came with a signed thinking block, at any effort up to high');
}

function answered(thought: Thought, what: string): Reply {
  if (!thought.reply) throw new Skipped(`${what} was ${outcome(thought.result)}`);
  return thought.reply;
}

/**
 * The turn everything else builds on: the question, the model's get_weather
 * calls with their signed thinking, and the results. One thinking request.
 */
const base = once(async () => {
  const u1 = user(QUESTION);
  const thought = await think([u1]);
  const a1 = assistant(answered(thought, 'the first question').content);
  if (toolUses(a1).length === 0) {
    throw new Skipped('the model answered the first question without calling get_weather');
  }
  return { u1, a1, results: toolResults(a1), effort: thought.effort };
});

/**
 * The base turn with an event after its tool results, as its own user
 * message, as `appendOnly` appends one; and the model's reply to it. The
 * event carries the request's cache breakpoint.
 */
const afterEvent = once(async () => {
  const { u1, a1, results, effort } = await base();
  const event: WireMessage = {
    role: 'user',
    content: [{ ...text(EVENT), cache_control: { type: 'ephemeral' } }],
  };
  const messages = [u1, a1, results, event];
  return { messages, event, ...(await think(messages, { from: effort })) };
});

/**
 * The on-demand compaction of the request `afterEvent` sent, which the model
 * answered: what `onDemandCompaction({ keepRecentTurns: 1 })` asks for, the
 * window up to the reply it keeps, as sent, breakpoint included.
 */
const keptBlock = once(async () => {
  const sent = await afterEvent();
  answered(sent, 'the request with the event');
  const body = request(sent.messages, {
    max_tokens: COMPACTION_MAX_TOKENS,
    output_config: { effort: sent.effort },
    compaction: { type: 'summarize' },
  });
  const result = await post(body, [ON_DEMAND_BETA]);
  return { result, block: result.ok ? compactionBlock(result.reply) : undefined };
});

async function requireBlock(): Promise<Block> {
  const { result, block } = await keptBlock();
  report('compaction request over [question, tool calls, results, event]', result, (reply) => {
    return `stop_reason ${reply.stop_reason}, ${tokens(reply)}`;
  });
  if (!block) throw new Skipped('no compaction block came back');
  return block;
}

// ─── Experiments ───

async function checkEnforced(): Promise<void> {
  const { a1, results } = await base();
  const result = await post(request([user(`${QUESTION} Please.`), a1, results]));
  report('the first question edited, its tool call sent back with its thinking', result);
  if (dryRun) return;
  if (args.diagnostic) {
    note('on an account created before 2026-08-31 this is ACCEPTED with one entry above');
  } else if (result.ok) {
    note('WARNING: an edited history was accepted, so ACCEPTED below proves nothing');
  } else {
    note('the check is enforced: a thinking block that no longer matches is rejected');
  }
}

async function stripMidToolLoop(): Promise<void> {
  const { u1, a1, results } = await base();
  report(
    'the tool calls without their thinking, their results in this request',
    await post(request([u1, withoutThinking(a1), results])),
  );
  report('control: with their thinking', await post(request([u1, a1, results])));
}

async function userAfterToolResult(): Promise<void> {
  const { u1, a1, results } = await base();
  const sent = await afterEvent();
  report('an event as its own user message after the tool results', sent.result);
  if (!sent.reply) return;
  const a2 = assistant(sent.reply.content);
  report(
    'sent back as it was sent, with the next question',
    await post(request([...sent.messages, a2, user(FOLLOW_UP)])),
  );
  const merged: WireMessage = {
    role: 'user',
    content: [...results.content, ...sent.event.content],
  };
  report(
    'sent back with the results and the event merged into one user message',
    await post(request([u1, a1, merged, a2, user(FOLLOW_UP)])),
  );
}

async function splitToolResults(): Promise<void> {
  const { u1, a1, results, effort } = await base();
  if (results.content.length < 2) {
    throw new Skipped('the model made one tool call; splitting needs two in one turn');
  }
  const split = results.content.map((block): WireMessage => ({ role: 'user', content: [block] }));
  const sent = [u1, a1, ...split];
  const thought = await think(sent, { from: effort });
  report('the tool results in two consecutive user messages', thought.result);
  if (!thought.reply) return;
  const a2 = assistant(thought.reply.content);
  report(
    'sent back as it was sent, with the next question',
    await post(request([...sent, a2, user(FOLLOW_UP)])),
  );
  report(
    'sent back with the results merged into one user message',
    await post(request([u1, a1, results, a2, user(FOLLOW_UP)])),
  );
}

async function clearAtReminder(): Promise<void> {
  const { u1, a1, results, effort } = await base();
  // Long enough that clearing it shows in the token counts.
  const reminder = [
    'Before you answer, also call get_weather for London.',
    ...Array.from({ length: 600 }, (_, i) => `Reminder note ${i + 1}: no action needed.`),
  ].join('\n');
  // Input tokens of the request after the tool result, turn-scoped and not.
  const after = new Map<boolean, number>();

  for (const turnScoped of [true, false]) {
    const label = turnScoped ? 'turn-scoped (clear_at)' : 'control, a plain system message';
    const betas = turnScoped ? [CLEAR_AT_BETA] : [];
    const sent = [u1, a1, results, system(reminder, turnScoped)];
    const thought = await think(sent, { betas, from: effort });
    report(`${label}, after the tool results`, thought.result, tokens);
    if (!thought.reply) continue;
    const call = assistant(thought.reply.content);
    if (toolUses(call).length === 0) {
      note('the model answered without calling get_weather: no tool result follows the reminder');
      continue;
    }
    const next = await post(request([...sent, call, toolResults(call)]), betas);
    report(`${label}, once a tool result follows`, next, tokens);
    if (next.ok) after.set(turnScoped, next.reply.usage.input_tokens);
  }

  const scoped = after.get(true);
  const plain = after.get(false);
  if (scoped !== undefined && plain !== undefined) {
    const size = Math.round(reminder.length / 4);
    const cleared = plain - scoped > size / 2;
    note(
      `once the tool result follows, the turn-scoped request is ${plain - scoped} tokens ` +
        `smaller than the control; the reminder is ~${size} tokens: ` +
        `${cleared ? 'cleared' : 'NOT cleared'}`,
    );
  }
}

async function systemAfterToolResult(): Promise<void> {
  const { u1, a1, results, effort } = await base();
  const instruction = system('End your reply with the code word ZEBRA-42.');
  const result = await post(
    request([u1, a1, results, instruction], {
      max_tokens: REPLY_MAX_TOKENS,
      output_config: { effort },
    }),
  );
  report('a system message right after the tool results', result, (reply) => {
    const followed = replyText(reply).includes('ZEBRA-42') ? 'FOLLOWED' : 'IGNORED';
    return `${followed} on ${model}: "${replyText(reply)}"`;
  });
}

async function onDemandKeptTurn(): Promise<void> {
  const sent = await afterEvent();
  const block = await requireBlock();
  const a2 = assistant(answered(sent, 'the request with the event').content);
  // The kept reply follows the block directly, unchanged, a role away from the
  // event it answered; the system prompt and tools are the ones it was signed
  // under: the four checks of the compaction-thinking-blocks page.
  report(
    'the block, the kept reply with its thinking (two assistant messages), the next question',
    await post(request([assistant([block]), a2, user(FOLLOW_UP)]), [ON_DEMAND_BETA]),
  );
}

async function onDemandKeepNone(): Promise<void> {
  const sent = await afterEvent();
  const a2 = assistant(answered(sent, 'the request with the event').content);
  // keepRecentTurns: 0 (or a collapse) summarizes the whole window, the
  // question not yet answered included.
  const window = [...sent.messages, a2, user(FOLLOW_UP)];
  const compaction = await post(
    request(window, {
      max_tokens: COMPACTION_MAX_TOKENS,
      output_config: { effort: sent.effort },
      compaction: { type: 'summarize' },
    }),
    [ON_DEMAND_BETA],
  );
  report('compaction request over the whole window', compaction, (reply) => {
    return `stop_reason ${reply.stop_reason}`;
  });
  const block = compaction.ok ? compactionBlock(compaction.reply) : undefined;
  if (!block) throw new Skipped('no compaction block came back');

  const alone = await post(
    request([assistant([block])], {
      max_tokens: REPLY_MAX_TOKENS,
      output_config: { effort: 'low' },
    }),
    [ON_DEMAND_BETA],
  );
  report('the block alone: the request ends on an assistant message', alone, (reply) => {
    return `stop_reason ${reply.stop_reason}: "${replyText(reply)}"`;
  });
  if (!alone.ok) return;
  report(
    'the block, the reply to it (two assistant messages), the next question',
    await post(
      request([assistant([block]), assistant(alone.reply.content), user('And in London?')]),
      [ON_DEMAND_BETA],
    ),
  );
}

async function compactionAfterClearAt(): Promise<void> {
  const { u1, a1, results } = await base();
  const reminder = system('Units: celsius.', true);
  report(
    'compaction request whose window ends in a clear_at reminder',
    await post(
      request([u1, a1, results, reminder], {
        max_tokens: COMPACTION_MAX_TOKENS,
        compaction: { type: 'summarize' },
      }),
      [ON_DEMAND_BETA, CLEAR_AT_BETA],
    ),
    (reply) => `stop_reason ${reply.stop_reason}`,
  );
}

async function blockWithSystemChange(): Promise<void> {
  const sent = await afterEvent();
  const block = await requireBlock();
  const a2 = assistant(answered(sent, 'the request with the event').content);
  // The compaction request went out under the last system prompt sent; the
  // next one has the new prompt, a `system` checkpoint that strips all thinking.
  const changed: Body = { system: [text(`${SYSTEM_TEXT}\nAnswer in French.`)] };
  report(
    'the block under a new system prompt, the kept reply without its thinking',
    await post(request([assistant([block]), withoutThinking(a2), user(FOLLOW_UP)], changed), [
      ON_DEMAND_BETA,
    ]),
  );
  report(
    'control: the kept reply with its thinking',
    await post(request([assistant([block]), a2, user(FOLLOW_UP)], changed), [ON_DEMAND_BETA]),
  );
}

async function compactionCacheHit(): Promise<void> {
  const sent = await afterEvent();
  const { result } = await keptBlock();
  report('the request before, its breakpoint on its last block', sent.result, tokens);
  report('the compaction request, the same messages and breakpoint', result, tokens);
  if (result.ok) {
    const read = result.reply.usage.cache_read_input_tokens ?? 0;
    note(read > 0 ? 'a cache hit' : 'no cache hit');
  }
}

async function serverBlockBeta(): Promise<void> {
  const contextManagement = {
    edits: [{ type: 'compact_20260112', trigger: { type: 'input_tokens', value: 50_000 } }],
  };
  const filler = Array.from(
    { length: 6000 },
    (_, i) => `Archive line ${i + 1}: nothing to report.`,
  );
  const triggered = await post(
    request([user(`${filler.join('\n')}\n\nReply with OK.`)], {
      max_tokens: REPLY_MAX_TOKENS,
      context_management: contextManagement,
    }),
    [SERVER_COMPACTION_BETA],
  );
  report('a request past the server-side compaction trigger', triggered, tokens);
  const reply = triggered.ok ? triggered.reply : undefined;
  const block = reply && compactionBlock(reply);
  if (!reply || !block) throw new Skipped('no compaction block came back');
  note(
    typeof block.signature === 'string'
      ? 'the block is signed, so appendOnly adds compact-2026-09-04 when it replays it'
      : 'the block has no signature, so appendOnly adds no beta for it',
  );

  // Resumed as `fromAnthropic` replays the reply that carried the block: all
  // of its content as it came back, then the next question. The messages
  // before the reply are left out; the API drops everything before the block.
  const resumed = [assistant(reply.content), user('Reply with OK again.')];
  const server = { context_management: contextManagement };
  report(
    'control: resumed with context_management and compact-2026-01-12',
    await post(request(resumed, server), [SERVER_COMPACTION_BETA]),
  );
  report(
    'resumed with compact-2026-09-04 added, as appendOnly sends it',
    await post(request(resumed, server), [SERVER_COMPACTION_BETA, ON_DEMAND_BETA]),
  );
  report(
    'resumed without server() any more: no context_management, compact-2026-09-04 only',
    await post(request(resumed), [ON_DEMAND_BETA]),
  );
}

async function emptyText(): Promise<void> {
  const { u1, a1, results } = await base();
  const thinkingOf = (message: WireMessage) => message.content.filter(isThinking);
  const call = (content: Block[]) => post(request([u1, assistant(content), results]));
  report(
    "tool calls as 4.2 sent them, [thinking, text '', tool_use]",
    await call([...thinkingOf(a1), text(''), ...toolUses(a1)]),
  );
  report(
    "whitespace only, [thinking, text ' ', tool_use]",
    await call([...thinkingOf(a1), text(' '), ...toolUses(a1)]),
  );
  report(
    'as the adapter sends them now, [thinking, tool_use]',
    await call([...thinkingOf(a1), ...toolUses(a1)]),
  );

  const image = (content: Block[]) => post(request([{ role: 'user', content }]));
  report(
    "an attachment-only user message as 4.2 sent it, [text '', image]",
    await image([text(''), IMAGE]),
  );
  report('as the adapter sends it now, [image]', await image([IMAGE]));

  const sent = await afterEvent();
  const a2 = assistant(answered(sent, 'the request with the event').content);
  const reply = (content: Block[]) =>
    post(request([...sent.messages, assistant(content), user(FOLLOW_UP)]));
  report(
    "a reply with no text as 4.2 sent it, [thinking, text '']",
    await reply([...thinkingOf(a2), text('')]),
  );
  report('as the adapter sends it now, [thinking]', await reply(thinkingOf(a2)));
}

const Units = z.object({ units: z.enum(['celsius', 'fahrenheit']), step: z.number() });

/** What the host changes before each question of the agent loop. */
const LOOP: { question: string; before: (chef: ContextChef) => unknown }[] = [
  {
    question: 'What is the weather in Paris?',
    before: async (chef) => {
      chef.setDynamicState(Units, { units: 'celsius', step: 1 });
      await chef.getMemory().set('home_city', 'Paris');
    },
  },
  {
    question: 'And in Tokyo?',
    before: (chef) => {
      chef.setDynamicState(Units, { units: 'celsius', step: 2 });
      chef.announce('humidity', 'get_weather results now include humidity.', { channel: 'system' });
    },
  },
  {
    // The one compaction: the window is summarized before this question goes out.
    question: 'And in London?',
    before: async (chef) => {
      chef.requestNewContext();
      await chef.getMemory().set('home_city', 'London');
    },
  },
  {
    question: 'And in Oslo?',
    before: (chef) => {
      chef.retractAnnouncement('humidity');
      chef.setDynamicState(Units, { units: 'fahrenheit', step: 4 });
    },
  },
];

/**
 * The same agent loop compiled by a chef with `appendOnly` on, then off:
 * dynamic state, an announcement and its retraction, memory changes and one
 * compaction. Without --diagnostic every request sends
 * `prefix_mismatch_behavior: "drop_block"`, so a block that fails the check
 * is dropped and listed as `thinking_dropped` instead of failing the loop.
 */
async function agentLoop(): Promise<void> {
  type HostHistory = Parameters<typeof fromAnthropic>[0];

  for (const appendOnly of [true, false]) {
    console.log(`  appendOnly ${appendOnly ? 'on' : 'off'}:`);
    indent = '    ';
    const chef = new ContextChef({
      ...(appendOnly ? { appendOnly: true, pipelineChecks: true } : {}),
      memory: { store: new InMemoryStore() },
      janitor: { contextWindow: 200_000 },
      overflow: {
        strategy: summarize({
          compressionModel: async () =>
            '<summary>The user asked for the weather in two cities; both were looked up.</summary>',
          split: 'recent-turns',
          preserveRecentMessages: 1,
        }),
      },
      logger: { warn: (message) => console.log(`    chef: ${message}`) },
    }).setSystemPrompt([{ role: 'system', content: SYSTEM_TEXT }]);

    const conversation: WireMessage[] = [];
    let requests = 0;
    let entries = 0;
    loop: for (const [index, step] of LOOP.entries()) {
      await step.before(chef);
      conversation.push(user(step.question));
      for (let round = 0; round < 3; round++) {
        chef.setHistory(fromAnthropic(conversation as unknown as HostHistory).history);
        const payload = await chef.compile({ target: 'anthropic' });
        const tools = (payload.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.parameters ?? { type: 'object', properties: {} },
        }));
        const result = await post(
          {
            model,
            max_tokens: REPLY_MAX_TOKENS,
            system: payload.system,
            tools: [...TOOLS, ...tools],
            thinking: thinking('drop_block'),
            output_config: { effort: 'high' },
            messages: payload.messages,
          },
          payload.betas ?? [],
        );
        requests++;
        const thinkingSent = payload.messages
          .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
          .filter((block) => block.type === 'thinking').length;
        const prefix = payload.meta?.prefix;
        const checkpoint = prefix?.break
          ? `, checkpoint (${prefix.break.reason}) at ${prefix.break.at}, ` +
            `${thinkingBlocks(prefix.break.strippedThinking)} stripped`
          : '';
        const label = round === 0 ? `q${index + 1}` : `q${index + 1}, tool results ${round}`;
        report(label, result, () => {
          const stable = prefix ? `, stable ${prefix.stable}` : '';
          return `${thinkingBlocks(thinkingSent)} sent${stable}${checkpoint}`;
        });
        if (!result.ok) {
          note('the loop stops here');
          break loop;
        }
        entries += result.reply.input_transformations?.length ?? 0;

        const reply = assistant(result.reply.content);
        conversation.push(reply);
        if (toolUses(reply).length === 0) break;
        const answers: Block[] = [];
        for (const use of toolUses(reply)) {
          const name = String(use.name);
          const input = JSON.stringify(use.input ?? {});
          const content = chef.ownsTool(name)
            ? await chef.handleTool({ name, arguments: input })
            : weatherFor(use);
          answers.push({ type: 'tool_result', tool_use_id: use.id, content });
        }
        conversation.push({ role: 'user', content: answers });
      }
    }
    note(`${entries} input_transformations entries in ${requests} requests`);
  }
  indent = '  ';
}

interface Experiment {
  name: string;
  question: string;
  /** The expected outcome, and the library decision each result drives. */
  means?: string[];
  run: () => Promise<void>;
}

const EXPERIMENTS: Experiment[] = [
  {
    name: 'check-enforced',
    question: 'Is the thinking check running? An edited first question must be rejected.',
    run: checkEnforced,
  },
  {
    name: 'strip-mid-tool-loop',
    question:
      'Thinking stripped mid tool loop: is a tool turn sent back without its thinking, its ' +
      'results still to come, rejected?',
    means: [
      'expected: the control ACCEPTED; the question is the first request.',
      'REJECTED → waiting for a user-turn boundary before an unsigned compaction is a hard requirement, as appendOnly does it now.',
      "ACCEPTED → it is a quality choice: a compaction mid tool turn could strip that turn's thinking instead of waiting.",
    ],
    run: stripMidToolLoop,
  },
  {
    name: 'user-after-tool-result',
    question:
      'A user event as its own message after the tool results: accepted, and does the thinking ' +
      'after it verify, sent back as sent and merged?',
    means: [
      'expected: all three ACCEPTED.',
      "the first REJECTED → an event can't follow tool results as its own user message; appendOnly would have to put it in the tool-result message.",
      'sent back as sent REJECTED → such an event breaks the thinking after it: a release blocker for appendOnly.',
      "merged ACCEPTED → the API checks the merged form, so the chef's separate event and fromAnthropic's one-message replay are interchangeable; REJECTED → a history must go back in the form it was sent.",
    ],
    run: userAfterToolResult,
  },
  {
    name: 'split-tool-results',
    question: 'Tool results split across two user messages: the same questions.',
    means: [
      'expected: all three ACCEPTED.',
      'sent back as sent REJECTED → tool results split across user messages break the thinking after them; the adapter would have to merge them before sending.',
      'merged ACCEPTED → merging them between requests is harmless; REJECTED → they must never be re-shaped once sent.',
    ],
    run: splitToolResults,
  },
  {
    name: 'clear-at-reminder',
    question: 'clearAt: is a reminder cleared once a tool-result-only user message follows?',
    means: [
      'expected: all ACCEPTED, and the reminder cleared.',
      "the turn-scoped request after the tool result REJECTED → a cleared reminder left in place breaks the thinking after it, and clearAt can't be used with thinking.",
      "cleared → as the guide says, tool results end a turn-scoped reminder; NOT cleared → only a real user message does, and the guide's clearAt section must say so.",
    ],
    run: clearAtReminder,
  },
  {
    name: 'system-after-tool-result',
    question:
      'Does the model follow a system message right after a tool result? (Sonnet 5.5, Haiku 5.5)',
    means: [
      "FOLLOWED → a 'system' event that lands mid tool loop reaches this model.",
      "IGNORED → on this model mid-loop events belong on the user channel ('last_user' state, 'user_tail' announcements), and the guide should say so.",
      'Run it with --model claude-haiku-5-5 as well.',
    ],
    run: systemAfterToolResult,
  },
  {
    name: 'on-demand-kept-turn',
    question:
      'onDemandCompaction over a chef-rendered window: does the kept reply right after the block ' +
      'keep its thinking?',
    means: [
      'expected ACCEPTED: the reply kept after the block keeps its thinking, as onDemandCompaction promises.',
      "REJECTED → the kept turns lose their thinking as after an unsigned compaction, or a reply can't follow the block directly (the message says which); onDemandCompaction must then strip them or keep no turn.",
    ],
    run: onDemandKeptTurn,
  },
  {
    name: 'on-demand-keep-none',
    question:
      'keepRecentTurns: 0 or a collapse: does the API go on from a request that ends on the ' +
      'block, and take the reply after it?',
    means: [
      'expected: all ACCEPTED.',
      'the block alone REJECTED → after keepRecentTurns: 0 or a collapse the chef must not send a request that ends on the block; it has to state the pending question again after it.',
      'the last request REJECTED → a reply may not follow the block directly.',
    ],
    run: onDemandKeepNone,
  },
  {
    name: 'compaction-after-clear-at',
    question: 'A compaction request whose window ends in a clear_at reminder.',
    means: [
      'expected: ACCEPTED, stop_reason compaction.',
      'REJECTED, or another stop_reason → onDemandCompaction must cut before a trailing clear_at reminder, or not combine with clearAt.',
    ],
    run: compactionAfterClearAt,
  },
  {
    name: 'block-with-system-change',
    question: 'A signed block landing in the same compile as a system prompt change.',
    means: [
      'expected: the first ACCEPTED, the control REJECTED.',
      "the first REJECTED → a signed block doesn't survive a system prompt change: a compaction landing with one must fall back to an unsigned summary.",
      "the control ACCEPTED → the kept reply's thinking survived the change, and the system checkpoint strips more than it has to.",
    ],
    run: blockWithSystemChange,
  },
  {
    name: 'compaction-cache-hit',
    question:
      'cache_control on the last block of a compaction request: does it read what the request ' +
      'before it wrote?',
    means: [
      "a hit → the guide's advice holds: add cache_control to the last block of payload.messages in compact.",
      'no hit → drop that advice from the guide, unless the request before wrote nothing (0 written: too short to cache, and this says nothing).',
    ],
    run: compactionCacheHit,
  },
  {
    name: 'server-block-beta',
    question: 'A resumed server-side compaction block with compact-2026-09-04 added: harmless?',
    means: [
      'expected: all ACCEPTED.',
      'the second REJECTED while the control is ACCEPTED → appendOnly must add compact-2026-09-04 only for an on-demand block, not for a server-side one.',
      'the last REJECTED → resuming a server-side block needs compact-2026-01-12 as well, even without server().',
    ],
    run: serverBlockBeta,
  },
  {
    name: 'empty-text',
    question:
      'Empty and whitespace-only text blocks next to other blocks: rejected? (the adapter no ' +
      'longer sends them)',
    means: [
      'expected: the forms the adapter sends now ACCEPTED.',
      'the 4.2 forms REJECTED → leaving that text out was a fix, not only a cleanup; ACCEPTED → it changed nothing either way.',
      'whatever the whitespace line says, the adapter needs no change: it leaves whitespace-only text out too.',
    ],
    run: emptyText,
  },
  {
    name: 'agent-loop',
    question:
      'An agent loop leaves input_transformations empty with appendOnly on, not with it off ' +
      '(the diagnostic-mode run with --diagnostic, on an account created before 2026-08-31).',
    means: [
      'expected: no entries with appendOnly on, some with it off.',
      'an entry with appendOnly on → the ledger let a sent turn change: a release blocker; its path names the block.',
      'no entry with it off → nothing in this loop changed a signed prefix, and the run proves little.',
      'With --diagnostic on an account created on or after 2026-08-31, the off run stops at its first mismatch instead.',
    ],
    run: agentLoop,
  },
];

async function main(): Promise<void> {
  if (args.list) {
    for (const { name, question } of EXPERIMENTS) console.log(`${name.padEnd(26)} ${question}`);
    return;
  }
  const selected = EXPERIMENTS.filter(({ name }) => !args.only || name === args.only);
  if (selected.length === 0) {
    console.error(`No experiment named ${args.only}; --list names them.`);
    process.exitCode = 1;
    return;
  }
  if (!dryRun && !apiKey) {
    console.error(
      'Set ANTHROPIC_API_KEY, e.g. in .env.local: ' +
        'node --env-file=.env.local examples/verify-thinking-prefix.ts (or --dry-run)',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `${model}, ${
      args.diagnostic
        ? 'diagnostic mode: the beta without block_binding'
        : 'prefix_mismatch_behavior "error"'
    }${dryRun ? ', dry run: nothing is sent' : ''}`,
  );
  for (const experiment of selected) {
    console.log(`\n${experiment.name}: ${experiment.question}`);
    try {
      await experiment.run();
    } catch (error) {
      if (!(error instanceof Skipped)) throw error;
      console.log(`  SKIPPED: ${error.message}`);
      continue;
    }
    if (experiment.means) note(...experiment.means);
  }
}

await main();
