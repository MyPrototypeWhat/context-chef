/**
 * `contextManagement` is a projection of the resolved overflow strategy: all
 * three spellings of "the server manages this window" must compile to the same
 * Anthropic payload, and an explicit non-server strategy must win over a
 * leftover `contextManagement` block in either spelling.
 */

import { describe, expect, it, vi } from 'vitest';
import { type ChefConfig, ContextChef, server, summarize } from '../src/index';
import type { AnthropicPayload, ChefLogger, Message } from '../src/types';

const silent: ChefLogger = { warn: () => {} };
const serverConfig = { edits: [{ type: 'compact_20260112' as const }] };
/** A second, distinguishable payload, for the case where two spellings disagree. */
const otherConfig = {
  edits: [{ type: 'compact_20260112' as const, trigger: { type: 'input_tokens', value: 1000 } }],
};
const history: Message[] = [{ role: 'user', content: 'a' }];

function chefWith(config: ChefConfig): ContextChef {
  const chef = new ContextChef({ logger: silent, ...config });
  chef.setHistory(history);
  return chef;
}

interface Spelling {
  name: string;
  config: ChefConfig;
  /** The `context_management` block expected on the Anthropic payload. */
  managed: unknown;
}

const serverManaged: Spelling[] = [
  {
    name: "contextManagement: { strategy: 'server', server }",
    config: { contextManagement: { strategy: 'server', server: serverConfig } },
    managed: serverConfig,
  },
  {
    name: 'overflow.strategy = server(config)',
    config: { overflow: { strategy: server(serverConfig) } },
    managed: serverConfig,
  },
  {
    name: 'janitor.strategy = server(config)',
    config: { janitor: { contextWindow: Infinity, strategy: server(serverConfig) } },
    managed: serverConfig,
  },
  {
    name: "contextManagement: { strategy: 'server' } with no edits config",
    config: { contextManagement: { strategy: 'server' } },
    managed: { edits: [{ type: 'compact_20260112' }] },
  },
  {
    // The only configuration where the two server spellings can disagree about
    // the payload: the strategy is the resolved answer, so its config is the
    // one that must reach the wire. `otherConfig` differs from both the other
    // block and the adapter's default, so this row fails either way round.
    name: 'overflow.strategy = server(A) beats a leftover contextManagement server block',
    config: {
      contextManagement: { strategy: 'server', server: serverConfig },
      overflow: { strategy: server(otherConfig) },
    },
    managed: otherConfig,
  },
];

const clientManaged: Spelling[] = [
  { name: 'no configuration at all', config: {}, managed: undefined },
  {
    name: "contextManagement: { strategy: 'client' }",
    config: { contextManagement: { strategy: 'client' } },
    managed: undefined,
  },
  {
    name: "overflow.strategy = summarize() next to a leftover 'server' block",
    config: {
      contextManagement: { strategy: 'server' },
      overflow: { strategy: summarize() },
    },
    managed: undefined,
  },
  {
    name: "janitor.strategy = summarize() next to a leftover 'server' block",
    config: {
      contextManagement: { strategy: 'server' },
      janitor: { contextWindow: Infinity, strategy: summarize() },
    },
    managed: undefined,
  },
];

describe('contextManagement resolution', () => {
  describe('server-managed spellings compile identically', () => {
    for (const { name, config, managed } of serverManaged) {
      it(name, async () => {
        const payload = (await chefWith(config).compile({
          target: 'anthropic',
        })) as AnthropicPayload;

        expect(payload.context_management).toEqual(managed);
        expect(payload.betas).toEqual(['compact-2026-01-12']);
      });

      it(`${name} — warns once on a non-anthropic target`, async () => {
        const warn = vi.fn();
        const chef = new ContextChef({ logger: { warn }, ...config });
        chef.setHistory(history);

        const payload = await chef.compile({ target: 'openai' });
        await chef.compile({ target: 'openai' });

        expect((payload as unknown as Record<string, unknown>).context_management).toBeUndefined();
        // The `server-fallback` warnOnce key: a per-compile decision must not
        // turn into a per-compile log line.
        expect(
          warn.mock.calls.filter((call) =>
            String(call[0]).includes('no server-side context management implementation'),
          ),
        ).toHaveLength(1);
      });
    }
  });

  describe('client-managed spellings attach nothing', () => {
    for (const { name, config } of clientManaged) {
      it(name, async () => {
        const payload = (await chefWith(config).compile({
          target: 'anthropic',
        })) as AnthropicPayload;

        expect(payload.context_management).toBeUndefined();
        expect(payload.betas).toBeUndefined();
      });

      it(`${name} — stays quiet on a non-anthropic target`, async () => {
        const warn = vi.fn();
        const chef = new ContextChef({ logger: { warn }, ...config });
        chef.setHistory(history);

        const payload = await chef.compile({ target: 'openai' });

        expect((payload as unknown as Record<string, unknown>).context_management).toBeUndefined();
        expect(
          warn.mock.calls.filter((call) =>
            String(call[0]).includes('no server-side context management implementation'),
          ),
        ).toEqual([]);
      });
    }
  });
});
