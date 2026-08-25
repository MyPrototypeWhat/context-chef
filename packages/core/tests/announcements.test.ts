import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChefSnapshot } from '../src/chef';
import { ContextChef, type ITargetAdapter } from '../src/index';
import type { Message, TargetPayload } from '../src/types';

const ANCHOR = 'Above is the current system state. Use it to guide your next action.';

/** Echoes the assembled IR back so tests can assert on structure, not provider shape. */
class CaptureAdapter implements ITargetAdapter {
  public messages: Message[] = [];
  public compile(messages: Message[]): TargetPayload {
    this.messages = messages;
    return { messages };
  }
}

interface PlainMessage {
  role: string;
  content: string;
  _positional?: boolean;
}

function plain(payload: { messages: unknown }): PlainMessage[] {
  return JSON.parse(JSON.stringify(payload.messages));
}

const history = (): Message[] => [
  { role: 'user', content: 'q1' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'q2' },
];

describe('announce / retractAnnouncement / getAnnouncements', () => {
  it('upserts by id, keeping the original insertion position', () => {
    const chef = new ContextChef();
    chef.announce('a', 'first').announce('b', 'second').announce('a', 'first (updated)');

    expect(chef.getAnnouncements()).toEqual([
      { id: 'a', content: 'first (updated)', channel: 'auto' },
      { id: 'b', content: 'second', channel: 'auto' },
    ]);
  });

  it('lets an upsert change the channel', () => {
    const chef = new ContextChef();
    chef.announce('a', 'x', { channel: 'system' }).announce('a', 'x', { channel: 'user_tail' });
    expect(chef.getAnnouncements()[0].channel).toBe('user_tail');
  });

  it('returns copies, not live internals', () => {
    const chef = new ContextChef();
    chef.announce('a', 'x');
    const list = chef.getAnnouncements() as unknown as Array<{ content: string }>;
    list[0].content = 'mutated';
    expect(chef.getAnnouncements()[0].content).toBe('x');
  });

  it('reports whether a retraction removed anything', () => {
    const chef = new ContextChef();
    chef.announce('a', 'x');
    expect(chef.retractAnnouncement('a')).toBe(true);
    expect(chef.retractAnnouncement('a')).toBe(false);
    expect(chef.getAnnouncements()).toEqual([]);
  });
});

describe("announcements — 'user_tail' channel", () => {
  it('renders after implicit context and before the anchor', async () => {
    const chef = new ContextChef({ onBeforeCompile: () => 'rag snippet' });
    chef.setHistory(history());
    chef.setDynamicState(z.object({ step: z.number() }), { step: 1 });
    chef.announce('tools', 'Tools newly available: read_file', { channel: 'user_tail' });

    const tail = plain(await chef.compile({ target: 'openai' })).at(-1)?.content ?? '';

    const stateAt = tail.indexOf('<dynamic_state>');
    const implicitAt = tail.indexOf('<implicit_context>');
    const announceAt = tail.indexOf('<announcements>');
    const anchorAt = tail.indexOf(ANCHOR);

    expect(stateAt).toBeLessThan(implicitAt);
    expect(implicitAt).toBeLessThan(announceAt);
    expect(announceAt).toBeLessThan(anchorAt);
    expect(tail).toContain('<announcement id="tools">');
    expect(tail).toContain('Tools newly available: read_file');
  });

  it('renders every announcement in insertion order inside one wrapper', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'first', { channel: 'user_tail' });
    chef.announce('b', 'second', { channel: 'user_tail' });

    const tail = plain(await chef.compile({ target: 'openai' })).at(-1)?.content ?? '';
    expect(tail.match(/<announcements>/g)).toHaveLength(1);
    expect(tail.indexOf('first')).toBeLessThan(tail.indexOf('second'));
  });

  it('triggers the state anchor on its own (announcements are system state)', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'web_search has been withdrawn; calls will be rejected', {
      channel: 'user_tail',
    });

    const tail = plain(await chef.compile({ target: 'openai' })).at(-1)?.content ?? '';
    expect(tail).toContain(ANCHOR);
    expect(tail.indexOf('<announcements>')).toBeLessThan(tail.indexOf(ANCHOR));
  });

  it('escapes the id attribute', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a "quoted" & <angled>', 'x', { channel: 'user_tail' });

    const tail = plain(await chef.compile({ target: 'openai' })).at(-1)?.content ?? '';
    expect(tail).toContain('<announcement id="a &quot;quoted&quot; &amp; &lt;angled>">');
  });

  it('disappears from the next compile once retracted', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'temporary', { channel: 'user_tail' });

    expect(JSON.stringify(await chef.compile({ target: 'openai' }))).toContain('temporary');

    chef.retractAnnouncement('a');
    const after = plain(await chef.compile({ target: 'openai' }));
    expect(JSON.stringify(after)).not.toContain('temporary');
    expect(after.at(-1)?.content).toBe('q2');
  });
});

describe("announcements — 'system' channel", () => {
  it('emits one positional system message after the last user message', async () => {
    const adapter = new CaptureAdapter();
    const chef = new ContextChef();
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]).setHistory(history());
    chef.announce('a', 'first', { channel: 'system' });
    chef.announce('b', 'second', { channel: 'system' });

    const messages = plain(await chef.compile({ target: adapter }));

    expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'system']);
    const announcement = messages[4];
    expect(announcement._positional).toBe(true);
    expect(announcement.content.match(/<announcements>/g)).toHaveLength(1);
    expect(announcement.content).toContain('<announcement id="a">');
    expect(announcement.content).toContain('<announcement id="b">');
    // Nothing leaked into the conversational tail.
    expect(messages[3].content).toBe('q2');
  });

  it('follows the appended tail-stitch user message when history ends in a tool result', async () => {
    const adapter = new CaptureAdapter();
    const chef = new ContextChef();
    chef.setHistory([
      { role: 'user', content: 'q1' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: 'file body' },
    ]);
    chef.setDynamicState(z.object({ step: z.number() }), { step: 2 });
    chef.announce('a', 'Tools newly available: grep', { channel: 'system' });

    const messages = plain(await chef.compile({ target: adapter }));

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'system']);
    // The stitch went into the appended user message; the announcement follows it.
    expect(messages[3].content).toContain('<dynamic_state>');
    expect(messages[4].content).toContain('<announcements>');
  });

  it('stays in front of a trailing assistant prefill', async () => {
    const adapter = new CaptureAdapter();
    const chef = new ContextChef();
    chef.setHistory(history()).withGuardrails({ prefill: '<thinking>' });
    chef.announce('a', 'Tools newly available: grep', { channel: 'system' });

    const messages = plain(await chef.compile({ target: adapter }));
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
      'assistant',
    ]);
    expect(messages[4].content).toContain('<thinking>');
  });

  it('no conversational tail + Anthropic target: degrades to a user message with a warn-once', async () => {
    const warn = vi.fn();
    const chef = new ContextChef({ logger: { warn } });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]); // no history at all
    chef.announce('a', 'Tools newly available: grep', { channel: 'system' });

    const payload = await chef.compile({ target: 'anthropic' });

    // A leading positional system message is invalid on the Anthropic API and
    // the adapter's hoist fallback would land the volatile text back in the
    // cacheable prefix — the exact failure the channel exists to avoid.
    expect(JSON.stringify(payload.system ?? [])).not.toContain('announcements');
    const messages = payload.messages as Array<{ role: string }>;
    expect(messages[0].role).toBe('user');
    expect(JSON.stringify(messages[0])).toContain('announcements');

    await chef.compile({ target: 'anthropic' });
    const announceWarns = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('conversational tail'),
    );
    expect(announceWarns).toHaveLength(1); // warn-once across compiles
  });

  it('no conversational tail + non-Anthropic target: keeps the positional system shape, no warning', async () => {
    const warn = vi.fn();
    const adapter = new CaptureAdapter();
    const chef = new ContextChef({ logger: { warn } });
    chef.setSystemPrompt([{ role: 'system', content: 'sys' }]);
    chef.announce('a', 'Tools newly available: grep', { channel: 'system' });

    const messages = plain(await chef.compile({ target: adapter }));

    // A leading inline system message is perfectly valid on OpenAI (and the
    // Gemini adapter degrades it itself) — the Anthropic-only constraint must
    // not rewrite the shape or warn on other targets.
    const announcement = messages.find((m) => m.content.includes('<announcements>'));
    expect(announcement?.role).toBe('system');
    expect(announcement?._positional).toBe(true);
    expect(
      warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('conversational tail')),
    ).toHaveLength(0);
  });

  it('does not warn when a hand-written positional message is adjacent across a plain system message', async () => {
    const warn = vi.fn();
    const chef = new ContextChef({ logger: { warn } });
    chef.setHistory([
      { role: 'user', content: 'q' },
      // A non-positional system message gets HOISTED out of the wire stream,
      // so the positional one still sits immediately after the user turn on
      // the wire — the adapter keeps it inline and no warning is warranted.
      { role: 'system', content: 'plain note' },
      { role: 'system', content: 'positional note', _positional: true },
    ]);

    await chef.compile({ target: 'anthropic' });

    expect(
      warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('positional system message')),
    ).toHaveLength(0);
  });

  it('warns through ChefConfig.logger when a hand-written positional system message would be hoisted on Anthropic', async () => {
    const warn = vi.fn();
    const chef = new ContextChef({ logger: { warn } });
    chef.setHistory([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      // After a plain assistant turn — the API rejects it there, the adapter
      // hoists it, and the chef pre-flight surfaces the diagnostic on THIS
      // instance's logger (the registry adapter singleton's own warn-once
      // may have been consumed by another chef in the process).
      { role: 'system', content: 'hand-written note', _positional: true },
    ]);

    await chef.compile({ target: 'anthropic' });
    await chef.compile({ target: 'anthropic' });

    const hoistWarns = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes('positional system message'),
    );
    expect(hoistWarns).toHaveLength(1); // once per chef instance
  });
});

describe("announcements — 'auto' routing", () => {
  it('uses the system channel on the Anthropic target', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'Tools newly available: grep');

    const payload = await chef.compile({ target: 'anthropic' });
    const messages = plain(payload);
    const lastUser = messages.filter((m) => m.role === 'user').at(-1);
    expect(lastUser?.content).not.toContain('<announcements>');
    expect(JSON.stringify(payload)).toContain('<announcements>');
  });

  it('uses the user tail on every other target', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'Tools newly available: grep');

    const messages = plain(await chef.compile({ target: 'openai' }));
    expect(messages.at(-1)?.role).toBe('user');
    expect(messages.at(-1)?.content).toContain('<announcements>');
    expect(messages.some((m) => m.role === 'system')).toBe(false);
  });

  it('honors an explicit channel regardless of target', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'Tools newly available: grep', { channel: 'user_tail' });

    const messages = plain(await chef.compile({ target: 'anthropic' }));
    expect(JSON.stringify(messages.at(-1))).toContain('<announcements>');
  });

  it('splits mixed channels across both delivery paths in one compile', async () => {
    const adapter = new CaptureAdapter();
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('tail', 'tail-side fact', { channel: 'user_tail' });
    chef.announce('sys', 'system-side fact', { channel: 'system' });

    const messages = plain(await chef.compile({ target: adapter }));
    expect(messages.at(-2)?.content).toContain('tail-side fact');
    expect(messages.at(-2)?.content).not.toContain('system-side fact');
    expect(messages.at(-1)?.content).toContain('system-side fact');
  });
});

describe('announcements — lifecycle state', () => {
  it('survives clearHistory', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'Tools newly available: grep', { channel: 'user_tail' });
    chef.clearHistory();

    expect(chef.getAnnouncements()).toHaveLength(1);
    const messages = plain(await chef.compile({ target: 'openai' }));
    expect(JSON.stringify(messages)).toContain('Tools newly available: grep');
  });

  it('round-trips through snapshot / restore', async () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    chef.announce('a', 'first', { channel: 'user_tail' });
    chef.announce('b', 'second', { channel: 'system' });
    const snap = chef.snapshot('with announcements');

    chef.retractAnnouncement('a');
    chef.announce('c', 'third');
    chef.restore(snap);

    expect(chef.getAnnouncements()).toEqual([
      { id: 'a', content: 'first', channel: 'user_tail' },
      { id: 'b', content: 'second', channel: 'system' },
    ]);
  });

  it('does not retain references to the snapshot after restore', () => {
    const chef = new ContextChef();
    chef.announce('a', 'first');
    const snap = chef.snapshot();

    chef.restore(snap);
    chef.announce('a', 'mutated');

    expect(snap.announcements?.[0].content).toBe('first');
  });

  it('restoring a pre-announcement snapshot yields an empty set', () => {
    const chef = new ContextChef();
    chef.setHistory(history());
    const snap = chef.snapshot();
    const legacy = { ...snap } as { announcements?: unknown };
    legacy.announcements = undefined;

    chef.announce('a', 'live announcement');
    chef.restore(legacy as ChefSnapshot);

    expect(chef.getAnnouncements()).toEqual([]);
  });
});
