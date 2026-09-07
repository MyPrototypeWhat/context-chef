/**
 * Golden payload suite.
 *
 * Every (fixture, target) pair compiles to a payload that is serialized with
 * ContextChef's own deterministic-JSON convention and compared against a
 * committed snapshot. A diff here means the wire output changed — which is a
 * bug for any change that is supposed to be behavior-preserving.
 *
 * Regenerate deliberately (and review the diff) with:
 *   UPDATE_GOLDEN=1 pnpm --filter @context-chef/core test golden && pnpm lint:fix
 *
 * The snapshots are committed `.json`, so Biome formats them; the comparison
 * parses the file rather than diffing bytes, which keeps whitespace out of the
 * contract. `pnpm lint:fix` after a regeneration just re-applies that format.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Assembler } from '../../src/modules/assembler';
import type { TargetPayload } from '../../src/types';
import { GOLDEN_NOW, GOLDEN_TARGETS, goldenFixtures } from './fixtures';

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '__snapshots__');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

/**
 * `meta` is compile-time observability, not wire output — it carries no
 * provider semantics and is dropped before the payload is sent. Comparing it
 * would turn every metadata addition into a golden diff.
 */
function wireOnly(payload: TargetPayload): unknown {
  const { meta: _meta, ...wire } = payload;
  return wire;
}

/**
 * On-disk form: the same key ordering `Assembler.stringifyPayload` produces,
 * pretty-printed so a diff is reviewable line by line.
 */
function render(payload: unknown): string {
  return `${JSON.stringify(Assembler.orderKeysDeterministically(payload), null, 2)}\n`;
}

function snapshotPath(fixture: string, target: string): string {
  return join(SNAPSHOT_DIR, `${fixture}.${target}.json`);
}

/** Writes the snapshot under UPDATE_GOLDEN=1, otherwise asserts equality. */
function assertGolden(fixture: string, target: string, payload: TargetPayload): void {
  const wire = wireOnly(payload);
  const file = snapshotPath(fixture, target);

  if (UPDATE) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, render(wire), 'utf8');
    return;
  }

  if (!existsSync(file)) {
    throw new Error(
      `Missing golden snapshot ${file}. Generate it with UPDATE_GOLDEN=1 and review the result.`,
    );
  }

  const stored = JSON.parse(readFileSync(file, 'utf8'));
  expect(Assembler.stringifyPayload(wire)).toBe(Assembler.stringifyPayload(stored));
}

describe('golden payloads', () => {
  // Only Date is faked: memory metadata renders `updatedAt` as an ISO string,
  // and a real clock would make every memory fixture flaky. Timers stay real
  // so nothing in the compile path can hang on a frozen scheduler.
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(GOLDEN_NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  for (const fixture of goldenFixtures) {
    for (const target of GOLDEN_TARGETS) {
      it(`${fixture.name} → ${target}`, async () => {
        const chef = await fixture.build();
        const payload = await chef.compile({ target });
        assertGolden(fixture.name, target, payload);
      });
    }
  }
});
