/**
 * Phase 4c: one session, one vocabulary.
 *
 * Under `tools: 'legacy'` every string the pipeline emits is the `Prompts`
 * entry that produced it before 4.2, byte for byte — that is the whole
 * compatibility guarantee. Under `tools: 'unified'` the same slots carry
 * `context://` wording, and no legacy tool name appears anywhere in the
 * payload: the model must never read about a tool it was not given.
 */

import { describe, expect, it } from 'vitest';
import { auditAnthropicCachePlacement } from '../src/adapters/anthropicCacheAudit';
import {
  type ChefConfig,
  ContextChef,
  getContextToolDefinition,
  InMemoryBackend,
  LEGACY_VOCABULARY,
  Prompts,
  resolveVocabulary,
  UNIFIED_VOCABULARY,
} from '../src/index';
import type { AnthropicPayload, ChefLogger, Message, TargetPayload } from '../src/types';

const silent: ChefLogger = { warn: () => {} };

const TARGETS = ['openai', 'anthropic', 'gemini'] as const;

/** The three legacy tool names, as they would appear anywhere in a payload. */
const LEGACY_TOOL_NAMES = ['create_memory', 'modify_memory', 'recall_context'] as const;

const tokenizer = (messages: Message[]): number => messages.length * 10;

/** Long enough that a summary shrinks the span past the shrink guard's floor. */
const longHistory = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `turn-${i + 1}: ${'context '.repeat(200)}`,
  }));

const compressionModel = async (): Promise<string> => '<summary>COMPRESSED</summary>';

function chef(config: ChefConfig = {}): ContextChef {
  return new ContextChef({ logger: silent, store: new InMemoryBackend(), ...config })
    .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
    .setHistory([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'and now?' },
    ]);
}

/** A chef whose next compile overflows and leaves a summary behind. */
function overflowingChef(config: ChefConfig = {}): ContextChef {
  return new ContextChef({
    logger: silent,
    store: new InMemoryBackend(),
    janitor: { contextWindow: 60, triggerRatio: 1, tokenizer, compressionModel },
    ...config,
  })
    .setSystemPrompt([{ role: 'system', content: 'You are helpful.' }])
    .setHistory(longHistory(9));
}

const payloadText = (payload: TargetPayload): string => JSON.stringify(payload);

async function memoryChef(config: ChefConfig = {}): Promise<ContextChef> {
  const instance = chef({ memory: {}, ...config });
  await instance.getMemory().set('project_language', 'TypeScript');
  return instance;
}

describe('vocabulary: legacy is byte-identical', () => {
  it('emits the legacy memory instruction and memory block on every target', async () => {
    for (const target of TARGETS) {
      const instance = await memoryChef();
      const text = payloadText(await instance.compile({ target }));

      expect(text).toContain(JSON.stringify(Prompts.MEMORY_INSTRUCTION).slice(1, -1));
      expect(text).toContain(Prompts.MEMORY_BLOCK_HEADER);
      expect(text).toContain(
        'Existing memory keys: project_language. Prefer updating these keys over creating new ones to maintain consistency.',
      );
      expect(text).not.toContain('context://memory/');
    }
  });

  it('emits the legacy key guidance under allowedKeys', async () => {
    const instance = chef({ memory: { allowedKeys: ['tone'] } });
    await instance.getMemory().set('tone', 'terse');
    const text = payloadText(await instance.compile({ target: 'openai' }));

    expect(text).toContain(
      'Allowed memory keys: tone. You may ONLY update or delete these keys. Any other key will be rejected.',
    );
  });

  it('emits the legacy offload marker', () => {
    const marker = chef().offload('x'.repeat(9000), {
      threshold: 100,
      headChars: 0,
      tailChars: 40,
    });

    expect(marker).toContain('<persisted-output>');
    expect(marker).toContain('Full output: context://vfs/');
    expect(marker).not.toContain('read it with the context tool');
  });

  it('emits the legacy summary wrapper, with no lineage line', async () => {
    const payload = await overflowingChef().compile({ target: 'openai' });
    const summary = payload.messages.find((m) => JSON.stringify(m).includes('COMPRESSED'));

    expect(JSON.stringify(summary)).toContain(
      JSON.stringify(Prompts.getCompactSummaryWrapper('COMPRESSED')).slice(1, -1),
    );
    expect(JSON.stringify(summary)).not.toContain('Context window:');
  });

  it('renders the archive citation into the legacy wrapper unchanged', async () => {
    const instance = overflowingChef({ overflow: { archive: 'vfs' } });
    const payload = await instance.compile({ target: 'openai' });
    const summary = JSON.stringify(
      payload.messages.find((m) => JSON.stringify(m).includes('COMPRESSED')),
    );

    expect(summary).toContain('are archived in full at context://vfs/');
    expect(summary).not.toContain('Context window:');
  });

  it('defaults the handoff notice to the legacy template', async () => {
    const instance = overflowingChef({
      janitor: { contextWindow: 100, triggerRatio: 1, tokenizer, compressionModel },
      overflow: { handoff: { budgetTokens: 30 } },
    }).setHistory(longHistory(8));

    const text = payloadText(await instance.compile({ target: 'openai' }));
    expect(text).toContain('worth persisting now with the tools you have for it');
    expect(text).not.toContain('context://notes/');
  });

  it('is the vocabulary a default chef resolves', () => {
    expect(resolveVocabulary('legacy')).toBe(LEGACY_VOCABULARY);
    expect(LEGACY_VOCABULARY.memoryInstruction).toBe(Prompts.MEMORY_INSTRUCTION);
    expect(LEGACY_VOCABULARY.memoryBlockHeader).toBe(Prompts.MEMORY_BLOCK_HEADER);
    expect(LEGACY_VOCABULARY.handoffNotice).toBe(Prompts.HANDOFF_NOTICE_TEMPLATE);
    // The legacy wrapper never states a lineage, whatever it is handed.
    expect(LEGACY_VOCABULARY.summaryWrapper('S', { current: 'w_2', previous: 'w_1' })).toBe(
      Prompts.getCompactSummaryWrapper('S'),
    );
  });

  it('renders the on-disk handle exactly as 4.x did', () => {
    const args = {
      uri: 'context://vfs/vfs_abc.txt',
      totalLines: 10,
      totalChars: 500,
      head: 'HEAD',
      tail: 'TAIL',
      physicalPath: '/tmp/vfs_abc.txt',
    };

    expect(LEGACY_VOCABULARY.offloadPlaceholder(args)).toBe(
      Prompts.getVFSOffloadReminder(
        args.uri,
        args.totalLines,
        args.totalChars,
        args.head,
        args.tail,
        args.physicalPath,
      ),
    );
    expect(LEGACY_VOCABULARY.offloadPlaceholder(args)).toContain(
      'Full output saved to: /tmp/vfs_abc.txt',
    );
    // The unified marker keeps the path, but leads with the store address.
    expect(UNIFIED_VOCABULARY.offloadPlaceholder(args)).toContain(
      'Full output: context://vfs/vfs_abc.txt — read it with the context tool: view context://vfs/vfs_abc.txt',
    );
    expect(UNIFIED_VOCABULARY.offloadPlaceholder(args)).toContain('On disk: /tmp/vfs_abc.txt');
  });
});

describe("vocabulary: tools 'unified'", () => {
  it('replaces the memory instruction with the context-store one', async () => {
    for (const target of TARGETS) {
      const instance = await memoryChef({ tools: 'unified' });
      const text = payloadText(await instance.compile({ target }));

      expect(text).toContain('The context store holds addressed content');
      expect(text).toContain(Prompts.CONTEXT_MEMORY_BLOCK_HEADER);
      expect(text).toContain('editable at context://memory/<key> with the context tool');
      expect(text).not.toContain('You recall the following');
    }
  });

  it('names the address in the allowedKeys guidance', async () => {
    const instance = chef({ tools: 'unified', memory: { allowedKeys: ['tone'] } });
    await instance.getMemory().set('tone', 'terse');
    const text = payloadText(await instance.compile({ target: 'openai' }));

    expect(text).toContain(
      'Writable memory keys: tone. Only these may be created, updated or deleted at context://memory/<key>.',
    );
  });

  it('points the offload marker at the context tool', () => {
    const marker = chef({ tools: 'unified' }).offload('x'.repeat(9000), {
      threshold: 100,
      headChars: 0,
      tailChars: 40,
    });

    expect(marker).toContain('<persisted-output>');
    expect(marker).toContain('read it with the context tool: view context://vfs/');
    expect(marker).not.toContain('Full output saved to:');
  });

  it('states the window lineage in the summary wrapper', async () => {
    const instance = overflowingChef({ tools: 'unified' });
    const payload = await instance.compile({ target: 'openai' });
    const window = instance.snapshot().modules.janitor.window;
    const summary = JSON.stringify(
      payload.messages.find((m) => JSON.stringify(m).includes('COMPRESSED')),
    );

    expect(window?.previous).toBeDefined();
    expect(summary).toContain(`Context window: ${window?.current} (previous: ${window?.previous})`);
    // The continuation framing itself is unchanged.
    expect(summary).toContain('This session is being continued from a previous conversation');
  });

  it('keeps the archive citation alongside the lineage line', async () => {
    const instance = overflowingChef({ tools: 'unified', overflow: { archive: 'vfs' } });
    const payload = await instance.compile({ target: 'openai' });
    const summary = JSON.stringify(
      payload.messages.find((m) => JSON.stringify(m).includes('COMPRESSED')),
    );

    expect(summary).toContain('Context window: ');
    expect(summary).toContain('are archived in full at context://vfs/');
  });

  it('defaults the handoff notice to the context-tool wording', async () => {
    const instance = overflowingChef({
      tools: 'unified',
      janitor: { contextWindow: 100, triggerRatio: 1, tokenizer, compressionModel },
      overflow: { handoff: { budgetTokens: 30 } },
    }).setHistory(longHistory(8));

    const text = payloadText(await instance.compile({ target: 'openai' }));
    expect(text).toContain('context tool under context://notes/ or context://memory/');
    expect(text).not.toContain('the tools you have for it');
  });

  it('honours an explicit handoff prompt over the vocabulary default', async () => {
    const instance = overflowingChef({
      tools: 'unified',
      janitor: { contextWindow: 100, triggerRatio: 1, tokenizer, compressionModel },
      overflow: { handoff: { budgetTokens: 30, prompt: 'MINE — {n_remaining}' } },
    }).setHistory(longHistory(8));

    const text = payloadText(await instance.compile({ target: 'openai' }));
    expect(text).toContain('MINE — 20');
    expect(text).not.toContain('context tool under context://notes/');
  });

  it('mentions no legacy tool name anywhere in the payload', async () => {
    for (const target of TARGETS) {
      const instance = await memoryChef({
        tools: 'unified',
        overflow: { handoff: { budgetTokens: 500 } },
      });
      instance.announce('note', 'stay on task');
      const payload = await instance.compile({ target });
      const text = payloadText(payload);

      for (const name of LEGACY_TOOL_NAMES) {
        expect(text).not.toContain(name);
      }
      expect((payload.tools ?? []).map((tool) => tool.name)).toEqual(['context', 'new_context']);
    }
  });

  it('mentions no legacy tool name once a summary and an offload marker are in the window', async () => {
    const instance = overflowingChef({
      tools: 'unified',
      memory: {},
      overflow: { archive: 'vfs' },
    });
    await instance.getMemory().set('project_language', 'TypeScript');
    const offloaded = instance.offload('y'.repeat(9000), { threshold: 100, tailChars: 40 });
    instance.setHistory([...longHistory(9), { role: 'user', content: offloaded }]);

    const text = payloadText(await instance.compile({ target: 'anthropic' }));
    expect(text).toContain('read it with the context tool');
    expect(text).toContain('Context window: ');
    for (const name of LEGACY_TOOL_NAMES) {
      expect(text).not.toContain(name);
    }
  });

  it('is the vocabulary the unified mode resolves', () => {
    expect(resolveVocabulary('unified')).toBe(UNIFIED_VOCABULARY);
    expect(UNIFIED_VOCABULARY.mode).toBe('unified');
    expect(UNIFIED_VOCABULARY.memoryInstruction).toBe(Prompts.CONTEXT_STORE_INSTRUCTION);
    expect(UNIFIED_VOCABULARY.memoryBlockHeader).toBe(Prompts.CONTEXT_MEMORY_BLOCK_HEADER);
    // No lineage, no line — a standalone summary has no window to name.
    expect(UNIFIED_VOCABULARY.summaryWrapper('S')).toBe(Prompts.getCompactSummaryWrapper('S'));
    expect(UNIFIED_VOCABULARY.summaryWrapper('S', { current: 'w_2' })).toContain(
      'Context window: w_2',
    );
    expect(UNIFIED_VOCABULARY.summaryWrapper('S', { current: 'w_2' })).not.toContain('previous:');
  });

  it('keeps the store instruction inside its byte budget', () => {
    expect(new TextEncoder().encode(Prompts.CONTEXT_STORE_INSTRUCTION).length).toBeLessThan(900);
  });

  it('never points the model at a namespace 4.x does not write', async () => {
    // The 4.x archive writes into `vfs` (byte-identical URIs, architecture-v5
    // §4); `context://archive/` is a 5.0 switch. Both strings sit in the
    // cached prefix, so a model told otherwise cannot be corrected per session.
    expect(Prompts.CONTEXT_STORE_INSTRUCTION).not.toContain('archive/');
    expect(getContextToolDefinition().description).not.toContain('archive/');

    const instance = overflowingChef({ tools: 'unified', overflow: { archive: 'vfs' } });
    const text = payloadText(await instance.compile({ target: 'openai' }));
    expect(text).toContain('archived in full at context://vfs/');
    expect(text).not.toContain('context://archive/');
  });
});

describe('cacheAudit sees both memory headers', () => {
  const sys = (text: string, breakpoint = false) => ({
    type: 'text' as const,
    text,
    ...(breakpoint ? { cache_control: { type: 'ephemeral' as const } } : {}),
  });

  it('flags the unified memory block inside the cached prefix', () => {
    const payload = {
      system: [
        sys(`${Prompts.CONTEXT_MEMORY_BLOCK_HEADER}\n<memory>...</memory>`),
        sys('stable instructions', true),
      ],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    const issues = auditAnthropicCachePlacement(payload);

    expect(issues).toHaveLength(1);
    expect(issues[0].location).toBe('system[0]');
    expect(issues[0].dedupeKey).toBe('memory data block@prefix');
    expect(issues[0].message).toContain('before_history_tail');
  });

  it('is clean when the unified block sits after the last breakpoint', () => {
    const payload = {
      system: [
        sys('stable instructions', true),
        sys(`${Prompts.CONTEXT_MEMORY_BLOCK_HEADER}\n<memory>...</memory>`),
      ],
      messages: [{ role: 'user' as const, content: 'hi' }],
    } as unknown as AnthropicPayload;

    expect(auditAnthropicCachePlacement(payload)).toHaveLength(0);
  });

  it('flags a real unified compile that keeps memory in the prefix', async () => {
    const instance = await memoryChef({ tools: 'unified' });
    instance.setHistory([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'go on', _cache_breakpoint: true },
    ]);

    const payload = (await instance.compile({ target: 'anthropic' })) as AnthropicPayload;
    const issues = auditAnthropicCachePlacement(payload);

    expect(issues.map((issue) => issue.dedupeKey)).toContain('memory data block@prefix');
  });
});
