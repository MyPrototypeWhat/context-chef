/**
 * Guardrails — enforced XML output and assistant prefill
 *
 * Demonstrates:
 * - withGuardrails: enforce-XML instruction + assistant prefill
 * - Provider-aware degradation: Anthropic keeps the trailing assistant
 *   prefill natively; OpenAI cannot end on an assistant message, so the
 *   adapter folds a prefill-enforcement instruction into the prompt instead
 * - withGuardrails(null) clearing
 * - v4 order-independence: options are STORED and applied at compile(), so
 *   calling setDynamicState after withGuardrails no longer discards them
 *
 * Runs fully offline — no API key required.
 *
 * Usage:
 *   npx tsx examples/guardrail.ts
 */

import { ContextChef } from '@context-chef/core';
import { z } from 'zod';

const StateSchema = z.object({ ticketId: z.string(), severity: z.string() });

const chef = new ContextChef();

async function main() {
  console.log('=== ContextChef Guardrail Example ===\n');

  chef
    .setSystemPrompt([{ role: 'system', content: 'You are an incident triage bot.' }])
    .setHistory([{ role: 'user', content: 'Prod API is returning 502s since 09:40.' }])
    // v4: guardrail options are stored and applied during compile(), so this
    // call can happen BEFORE setDynamicState. Pre-4.0, setDynamicState after
    // withGuardrails silently discarded the guardrail — order mattered.
    .withGuardrails({
      enforceXML: { outputTag: 'triage_result' },
      prefill: '<triage_result>\n<severity>',
    })
    .setDynamicState(StateSchema, { ticketId: 'INC-2210', severity: 'unknown' });

  // ─── Anthropic: native prefill ────────────────────────────────────────────
  // The Messages API allows a trailing assistant message; whatever it contains
  // is treated as the forced start of the model's reply.
  const anthropic = await chef.compile({ target: 'anthropic' });
  const lastAnthropic = anthropic.messages[anthropic.messages.length - 1];
  console.log('--- anthropic ---');
  console.log('last message role:', lastAnthropic.role); // 'assistant'
  console.log('prefill content:  ', JSON.stringify(lastAnthropic.content), '\n');

  // ─── OpenAI: graceful degradation ─────────────────────────────────────────
  // Chat Completions rejects a trailing assistant message as a prefill, so the
  // adapter pops it and injects an ephemeral "your response MUST start with"
  // instruction into the last user (or system) message instead.
  const openaiPayload = await chef.compile({ target: 'openai' });
  const messages = openaiPayload.messages as Array<{ role: string; content?: unknown }>;
  const lastOpenAI = messages[messages.length - 1];
  const enforcement = messages.find(
    (m) => typeof m.content === 'string' && m.content.includes('prefill_enforcement'),
  );
  console.log('--- openai ---');
  console.log('last message role:            ', lastOpenAI.role); // never 'assistant'
  console.log('prefill folded into a prompt: ', enforcement !== undefined);
  console.log(
    'enforce-XML instruction present:',
    messages.some((m) => typeof m.content === 'string' && m.content.includes('<triage_result>')),
    '\n',
  );

  // ─── Clearing ─────────────────────────────────────────────────────────────
  // Replace semantics: every withGuardrails call replaces the previous
  // options; null clears them entirely.
  chef.withGuardrails(null);
  const cleared = await chef.compile({ target: 'anthropic' });
  const lastCleared = cleared.messages[cleared.messages.length - 1];
  console.log('--- after withGuardrails(null) ---');
  console.log('last message role:', lastCleared.role); // back to 'user'
}

main().catch(console.error);
