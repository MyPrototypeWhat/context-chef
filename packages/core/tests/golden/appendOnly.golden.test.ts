/**
 * `appendOnly` golden suite.
 *
 * Every sequence in `appendOnly.fixtures.ts` is compiled request by request on
 * each golden target, and what each compile produced — its wire payload and
 * its `meta.prefix` — is compared, in order, against a committed snapshot in
 * `__snapshots__/appendOnly/`. A separate suite with its own snapshots: the
 * 4.x golden suite never turns `appendOnly` on, and must not change.
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
import type { ChefEvents } from '../../src/index';
import { Assembler } from '../../src/modules/assembler';
import type { TargetPayload } from '../../src/types';
import { appendOnlySequences } from './appendOnly.fixtures';
import { GOLDEN_NOW, GOLDEN_TARGETS } from './fixtures';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__', 'appendOnly');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/** One compile as the snapshot keeps it: what was sent, and what the ledger reported. */
function compiled(payload: TargetPayload): unknown {
  const { meta, ...wire } = payload;
  return { prefix: meta?.prefix, payload: wire };
}

/** Writes the snapshot under UPDATE_GOLDEN=1, otherwise asserts equality. */
function assertGolden(sequence: string, target: string, compiles: unknown[]): void {
  const file = join(SNAPSHOT_DIR, `${sequence}.${target}.json`);

  if (UPDATE) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(Assembler.orderKeysDeterministically(compiles), null, 2)}\n`,
      'utf8',
    );
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Missing golden snapshot ${file}. Generate it with UPDATE_GOLDEN=1 and review the result.`,
    );
  }

  const stored = JSON.parse(readFileSync(file, 'utf8'));
  expect(Assembler.stringifyPayload(compiles)).toBe(Assembler.stringifyPayload(stored));
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

        const compiles: unknown[] = [];
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
