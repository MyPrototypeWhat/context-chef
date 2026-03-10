/**
 * Basic Chat with History Compression
 *
 * Demonstrates:
 * - Setting up ContextChef with Janitor for automatic history compression
 * - Using feedTokenUsage for simple token tracking
 * - Compiling to OpenAI format
 *
 * Usage:
 *   export OPENAI_API_KEY=your-key
 *   npx tsx examples/basic-chat.ts
 */

import { ContextChef } from 'context-chef';
import OpenAI from 'openai';
import { z } from 'zod';

const openai = new OpenAI();

const chef = new ContextChef({
  janitor: {
    contextWindow: 128000,
    preserveRecentMessages: 2,
    compressionModel: async (msgs) => {
      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Summarize the following conversation concisely, preserving key facts and decisions.',
          },
          ...msgs.map((m) => ({
            role: m.role as 'user' | 'assistant',
            content: String(m.content),
          })),
        ],
      });
      return res.choices[0].message.content ?? '';
    },
  },
});

const TaskSchema = z.object({
  currentGoal: z.string(),
});

const history: { role: 'user' | 'assistant'; content: string }[] = [];

async function chat(userMessage: string) {
  history.push({ role: 'user', content: userMessage });

  const payload = await chef
    .setTopLayer([{ role: 'system', content: 'You are a helpful coding assistant.' }])
    .useRollingHistory(history)
    .setDynamicState(TaskSchema, {
      currentGoal: 'Help user with their coding questions',
    })
    .compile({ target: 'openai' });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    ...payload,
  });

  // Feed token usage back for compression tracking
  if (response.usage) {
    chef.feedTokenUsage(response.usage.prompt_tokens);
  }

  const reply = response.choices[0].message.content ?? '';
  history.push({ role: 'assistant', content: reply });

  return reply;
}

// Example conversation
async function main() {
  console.log('=== ContextChef Basic Chat Example ===\n');

  const reply = await chat('What is the difference between map and flatMap in JavaScript?');
  console.log('Assistant:', reply);
}

main().catch(console.error);
