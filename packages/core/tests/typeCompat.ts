/**
 * Type Compatibility Verification
 *
 * This file is NOT executed — it only needs to pass `tsc` compilation.
 * It verifies that our adapter output types remain assignable to the
 * official SDK types. If an SDK update introduces breaking type changes,
 * `tsc` will fail here, alerting us to update our adapters.
 *
 * Run: pnpm typecheck:compat
 */

// ─── Helper ────────────────────────────────────────────────────────────────
type AssertAssignable<T extends U, U> = T;

// ═══════════════════════════════════════════════════════════════════════════
// 1. GEMINI — Our types are direct aliases of SDK types (via GeminiAdapter.ts),
//    so this section only verifies the re-export relationship is intact.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  Content as GeminiSDKContent,
  FunctionCallPart as GeminiSDKFunctionCallPart,
  FunctionResponsePart as GeminiSDKFunctionResponsePart,
  TextPart as GeminiSDKTextPart,
} from '@google/generative-ai';

import type {
  GeminiContent,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
  GeminiTextPart,
} from '../src/adapters/geminiAdapter';

type _G1 = AssertAssignable<GeminiTextPart, GeminiSDKTextPart>;
type _G2 = AssertAssignable<GeminiFunctionCallPart, GeminiSDKFunctionCallPart>;
type _G3 = AssertAssignable<GeminiFunctionResponsePart, GeminiSDKFunctionResponsePart>;
type _G4 = AssertAssignable<GeminiContent, GeminiSDKContent>;

// ═══════════════════════════════════════════════════════════════════════════
// 2. OPENAI — Verify our adapter uses ChatCompletionMessageParam correctly.
//    The adapter directly imports and uses SDK types internally, so this
//    validates that the import path and basic structure remain valid.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  ChatCompletionSystemMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/completions';

type OurSystemMsg = { role: 'system'; content: string; name?: string };
type OurUserMsg = { role: 'user'; content: string; name?: string };
type OurToolMsg = { role: 'tool'; content: string; tool_call_id: string };

type _O1 = AssertAssignable<OurSystemMsg, ChatCompletionSystemMessageParam>;
type _O2 = AssertAssignable<OurUserMsg, ChatCompletionUserMessageParam>;
type _O3 = AssertAssignable<OurToolMsg, ChatCompletionToolMessageParam>;

// ═══════════════════════════════════════════════════════════════════════════
// 3. ANTHROPIC — Verify our adapter output matches SDK message types.
//    The adapter directly imports and uses SDK types internally.
// ═══════════════════════════════════════════════════════════════════════════
import type {
  MessageParam as AnthropicMessageParam,
  TextBlockParam as AnthropicTextBlockParam,
  ToolResultBlockParam as AnthropicToolResultBlockParam,
  ToolUseBlockParam as AnthropicToolUseBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';

type OurTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
type OurToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
type OurToolResultBlock = { type: 'tool_result'; tool_use_id: string; content?: string };
type OurAnthropicMsg = { role: 'user' | 'assistant'; content: AnthropicTextBlockParam[] };

type _A1 = AssertAssignable<OurTextBlock, AnthropicTextBlockParam>;
type _A2 = AssertAssignable<OurToolUseBlock, AnthropicToolUseBlockParam>;
type _A3 = AssertAssignable<OurToolResultBlock, AnthropicToolResultBlockParam>;
type _A4 = AssertAssignable<OurAnthropicMsg, AnthropicMessageParam>;

// ═══════════════════════════════════════════════════════════════════════════
// 4. JANITOR CONFIG — Discriminated union: `usagePreference` value set
//    is narrowed by the presence of `tokenizer`. These checks fail to
//    compile if the narrowing regresses.
// ═══════════════════════════════════════════════════════════════════════════
import type { JanitorConfig, Message } from '../src';

// With tokenizer: all three preferences allowed.
const _jc1: JanitorConfig = {
  contextWindow: 100,
  tokenizer: (msgs: Message[]) => msgs.length,
  usagePreference: 'max',
};
const _jc2: JanitorConfig = {
  contextWindow: 100,
  tokenizer: (msgs: Message[]) => msgs.length,
  usagePreference: 'feedFirst',
};
const _jc3: JanitorConfig = {
  contextWindow: 100,
  tokenizer: (msgs: Message[]) => msgs.length,
  usagePreference: 'tokenizerFirst',
};

// Without tokenizer: 'max' and 'feedFirst' allowed, 'tokenizerFirst' rejected.
const _jc4: JanitorConfig = {
  contextWindow: 100,
  usagePreference: 'max',
};
const _jc5: JanitorConfig = {
  contextWindow: 100,
  usagePreference: 'feedFirst',
};
// @ts-expect-error — 'tokenizerFirst' requires a tokenizer
const _jc6: JanitorConfig = {
  contextWindow: 100,
  usagePreference: 'tokenizerFirst',
};

// Prevent "unused" warnings
export type TypeCompatChecks = {
  _g1: _G1;
  _g2: _G2;
  _g3: _G3;
  _g4: _G4;
  _o1: _O1;
  _o2: _O2;
  _o3: _O3;
  _a1: _A1;
  _a2: _A2;
  _a3: _A3;
  _a4: _A4;
  _jc1: typeof _jc1;
  _jc2: typeof _jc2;
  _jc3: typeof _jc3;
  _jc4: typeof _jc4;
  _jc5: typeof _jc5;
  _jc6: typeof _jc6;
};
