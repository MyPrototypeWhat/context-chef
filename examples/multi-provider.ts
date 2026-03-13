/**
 * Multi-Provider Compilation
 *
 * Demonstrates:
 * - Same prompt compiling to OpenAI, Anthropic, and Gemini formats
 * - Cache breakpoints for Anthropic
 * - Prefill degradation across providers
 *
 * Usage:
 *   npx tsx examples/multi-provider.ts
 */

import { ContextChef } from 'context-chef';
import { z } from 'zod';

const TaskSchema = z.object({
  activeFile: z.string(),
  todo: z.array(z.string()),
});

const chef = new ContextChef();

const history = [
  { role: 'user' as const, content: 'Please review auth.ts for security issues.' },
  {
    role: 'assistant' as const,
    content: "I'll review auth.ts for security issues. Let me read the file first.",
  },
  {
    role: 'user' as const,
    content: 'Here is the file content:\n```\nfunction login(user, pass) { ... }\n```',
  },
];

async function main() {
  console.log('=== ContextChef Multi-Provider Example ===\n');

  chef
    .setSystemPrompt([
      {
        role: 'system',
        content: 'You are a senior security engineer performing code review.',
        _cache_breakpoint: true,
      },
    ])
    .setHistory(history)
    .setDynamicState(TaskSchema, {
      activeFile: 'src/auth.ts',
      todo: ['Check for SQL injection', 'Verify password hashing', 'Review session management'],
    })
    .withGuardrails({
      enforceXML: { outputTag: 'security_review' },
      prefill: '<thinking>\n1.',
    });

  // Compile for each provider
  const openaiPayload = await chef.compile({ target: 'openai' });
  const anthropicPayload = await chef.compile({ target: 'anthropic' });
  const geminiPayload = await chef.compile({ target: 'gemini' });

  console.log('--- OpenAI Payload ---');
  console.log(`Messages: ${openaiPayload.messages.length}`);
  console.log(`First message role: ${openaiPayload.messages[0].role}\n`);

  console.log('--- Anthropic Payload ---');
  console.log(`Messages: ${anthropicPayload.messages.length}`);
  console.log(`System: ${anthropicPayload.system ? 'present' : 'absent'}`);
  console.log(`Has cache_control: ${JSON.stringify(anthropicPayload).includes('cache_control')}\n`);

  console.log('--- Gemini Payload ---');
  console.log(`Contents: ${geminiPayload.contents.length}`);
  console.log(`System instruction: ${geminiPayload.systemInstruction ? 'present' : 'absent'}\n`);

  console.log('Same prompt, three formats. Zero rewrite.');
}

main().catch(console.error);
