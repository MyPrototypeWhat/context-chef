/**
 * `appendOnly` golden suite.
 *
 * Every sequence in `appendOnly.fixtures.ts` is compiled request by request on
 * each golden target, and what each compile produced — its wire payload and
 * its `meta.prefix` — is compared, in order, against a committed snapshot in
 * `__snapshots__/appendOnly/`. A separate suite with its own snapshots: the
 * 4.x golden suite never turns `appendOnly` on, and must not change.
 *
 * A snapshot keeps the first payload in full and every later one as what it
 * changed: the messages from the first one that differs on, and any other
 * field (system, tools, betas, …) only when it changed. The test rebuilds
 * each full payload from those and compares it with the one compiled, so
 * every byte of every payload is still checked.
 *
 * Every sequence runs with `pipelineChecks`, and none may report a
 * `pipeline:invariant`: each payload starts with what the one before it sent,
 * unless the compile reported a checkpoint.
 *
 * Regenerate deliberately (and review the diff) with:
 *   UPDATE_GOLDEN=1 pnpm --filter @context-chef/core test golden && pnpm lint:fix
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChefEvents, PrefixMeta } from '../../src/index';
import { Assembler } from '../../src/modules/assembler';
import type { TargetPayload } from '../../src/types';
import { appendOnlySequences } from './appendOnly.fixtures';
import { GOLDEN_NOW, GOLDEN_TARGETS } from './fixtures';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'appendOnly');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** What reaches the provider: the payload without `meta`. Every golden target sends `messages`. */
type Wire = Record<string, unknown> & { messages: unknown[] };

interface Compiled {
  prefix?: PrefixMeta;
  wire: Wire;
}

/** One compile as the snapshot keeps it: the first in full, every later one as what changed. */
type Kept =
  | { prefix?: PrefixMeta; payload: Wire }
  | {
      prefix?: PrefixMeta;
      /** Index of the first message that differs from the payload before. */
      from: number;
      /** The messages from `from` on. */
      messages: unknown[];
      /** Fields besides `messages` that changed, with their new value. */
      changed?: Record<string, unknown>;
      /** Fields besides `messages` the payload no longer has. */
      removed?: string[];
    };

const same = (a: unknown, b: unknown): boolean =>
  Assembler.stringifyPayload(a) === Assembler.stringifyPayload(b);

function compiled(payload: TargetPayload): Compiled {
  const { meta, ...wire } = payload;
  return { prefix: meta?.prefix, wire: wire as Wire };
}

/** `next` as what it changed of `prev`. */
function delta(prev: Wire, { prefix, wire: next }: Compiled): Kept {
  let from = 0;
  while (from < prev.messages.length && same(prev.messages[from], next.messages[from])) from++;
  const changed: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const field of new Set([...Object.keys(prev), ...Object.keys(next)])) {
    if (field === 'messages') continue;
    if (!(field in next)) removed.push(field);
    else if (!same(prev[field], next[field])) changed[field] = next[field];
  }
  return {
    prefix,
    from,
    messages: next.messages.slice(from),
    ...(Object.keys(changed).length > 0 ? { changed } : {}),
    ...(removed.length > 0 ? { removed } : {}),
  };
}

/** The payload a kept entry stands for, given the one before it. */
function rebuild(prev: Wire | undefined, kept: Kept): Wire {
  if ('payload' in kept) return kept.payload;
  if (!prev) throw new Error('a delta needs the payload before it');
  const { messages: _messages, ...rest } = prev;
  const fields: Record<string, unknown> = { ...rest, ...kept.changed };
  for (const field of kept.removed ?? []) delete fields[field];
  return { ...fields, messages: [...prev.messages.slice(0, kept.from), ...kept.messages] };
}

/** Writes the snapshot under UPDATE_GOLDEN=1, otherwise rebuilds every payload and compares. */
function assertGolden(sequence: string, target: string, compiles: Compiled[]): void {
  const file = join(SNAPSHOT_DIR, `${sequence}.${target}.json`);

  if (UPDATE) {
    const kept: Kept[] = compiles.map((compile, i) =>
      i === 0
        ? { prefix: compile.prefix, payload: compile.wire }
        : delta(compiles[i - 1].wire, compile),
    );
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    // Compact: `pnpm lint:fix` lays it out, keeping what fits on a line on one line.
    writeFileSync(file, `${JSON.stringify(Assembler.orderKeysDeterministically(kept))}\n`, 'utf8');
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Missing golden snapshot ${file}. Generate it with UPDATE_GOLDEN=1 and review the result.`,
    );
  }

  const stored = JSON.parse(readFileSync(file, 'utf8')) as Kept[];
  expect(stored).toHaveLength(compiles.length);
  let payload: Wire | undefined;
  for (const [i, kept] of stored.entries()) {
    payload = rebuild(payload, kept);
    expect(
      Assembler.stringifyPayload({ prefix: kept.prefix, payload }),
      `${sequence} → ${target}, compile ${i}`,
    ).toBe(Assembler.stringifyPayload({ prefix: compiles[i].prefix, payload: compiles[i].wire }));
  }
}

describe('appendOnly golden sequences', () => {
  // As in the 4.x suite: only Date is faked, for memory's `updated_at`.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  for (const sequence of appendOnlySequences) {
    for (const target of GOLDEN_TARGETS) {
      it(`${sequence.name} → ${target}`, async () => {
        const chef = await sequence.build();
        const invariants: ChefEvents['pipeline:invariant'][] = [];
        chef.on('pipeline:invariant', (event) => {
          invariants.push(event);
        });

        const compiles: Compiled[] = [];
        for (const step of sequence.steps) {
          await step.before?.(chef);
          compiles.push(compiled(await chef.setHistory(step.history).compile({ target })));
          if (step.settle) await new Promise((resolve) => setTimeout(resolve, 0));
        }

        expect(invariants).toEqual([]);
        assertGolden(sequence.name, target, compiles);
      });
    }
  }
});
