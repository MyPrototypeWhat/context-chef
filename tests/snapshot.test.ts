import { describe, expect, it } from 'vitest';
import { ContextChef } from '../src/index';
import type { Message } from '../src/types';

const userMsg = (content: string): Message => ({ role: 'user', content });
const assistantMsg = (content: string): Message => ({ role: 'assistant', content });

describe('E3: Snapshot & Restore', () => {
  it('snapshot captures current state', () => {
    const chef = new ContextChef();
    chef.useRollingHistory([userMsg('hello'), assistantMsg('hi')]);

    const snap = chef.snapshot('test label');

    expect(snap.rollingHistory).toHaveLength(2);
    expect(snap.rollingHistory[0].content).toBe('hello');
    expect(snap.label).toBe('test label');
    expect(snap.createdAt).toBeGreaterThan(0);
  });

  it('restore rolls back rollingHistory', () => {
    const chef = new ContextChef();
    chef.useRollingHistory([userMsg('turn 1')]);

    const snap = chef.snapshot();

    chef.useRollingHistory([userMsg('turn 1'), assistantMsg('reply'), userMsg('turn 2')]);
    expect(chef['rollingHistory']).toHaveLength(3);

    chef.restore(snap);
    expect(chef['rollingHistory']).toHaveLength(1);
    expect(chef['rollingHistory'][0].content).toBe('turn 1');
  });

  it('restore rolls back topLayer', () => {
    const chef = new ContextChef();
    chef.setTopLayer([{ role: 'system', content: 'original system' }]);
    const snap = chef.snapshot();

    chef.setTopLayer([{ role: 'system', content: 'modified system' }]);
    chef.restore(snap);

    expect(chef['topLayer'][0].content).toBe('original system');
  });

  it('restore rolls back dynamicStatePlacement and rawDynamicXml', () => {
    const chef = new ContextChef();
    chef['dynamicStatePlacement'] = 'system';
    chef['rawDynamicXml'] = '<dynamic_state><key>value</key></dynamic_state>';

    const snap = chef.snapshot();

    chef['dynamicStatePlacement'] = 'last_user';
    chef['rawDynamicXml'] = '';
    chef.restore(snap);

    expect(chef['dynamicStatePlacement']).toBe('system');
    expect(chef['rawDynamicXml']).toBe('<dynamic_state><key>value</key></dynamic_state>');
  });

  it('snapshot is a deep copy — mutating original does not affect snapshot', () => {
    const chef = new ContextChef();
    const history = [userMsg('original')];
    chef.useRollingHistory(history);

    const snap = chef.snapshot();

    // Mutate the chef's history after snapshot
    chef.useRollingHistory([userMsg('original'), assistantMsg('new message')]);

    expect(snap.rollingHistory).toHaveLength(1);
    expect(snap.rollingHistory[0].content).toBe('original');
  });

  it('restore is a deep copy — mutating snapshot after restore does not affect chef', () => {
    const chef = new ContextChef();
    chef.useRollingHistory([userMsg('original')]);
    const snap = chef.snapshot();

    chef.restore(snap);

    // Mutate the snapshot object after restore
    (snap.rollingHistory[0] as Message).content = 'mutated';

    expect(chef['rollingHistory'][0].content).toBe('original');
  });

  it('supports multiple snapshots and restores to any of them', () => {
    const chef = new ContextChef();

    chef.useRollingHistory([userMsg('step 1')]);
    const snap1 = chef.snapshot('step 1');

    chef.useRollingHistory([userMsg('step 1'), assistantMsg('reply 1'), userMsg('step 2')]);
    const snap2 = chef.snapshot('step 2');

    chef.useRollingHistory([...chef['rollingHistory'], assistantMsg('reply 2'), userMsg('step 3')]);

    // Restore to snap1
    chef.restore(snap1);
    expect(chef['rollingHistory']).toHaveLength(1);

    // Restore to snap2
    chef.restore(snap2);
    expect(chef['rollingHistory']).toHaveLength(3);
  });

  it('restore() returns this for chaining', () => {
    const chef = new ContextChef();
    const snap = chef.snapshot();
    const result = chef.restore(snap);
    expect(result).toBe(chef);
  });

  it('Janitor state is captured and restored', () => {
    const chef = new ContextChef({ janitor: { maxHistoryTokens: 1000 } });

    // Manually set Janitor internal state
    chef['janitor'].feedTokenUsage(999);
    chef['janitor']['_suppressNextCompression'] = true;

    const snap = chef.snapshot();

    // Reset Janitor state
    chef['janitor']['_externalTokenUsage'] = null;
    chef['janitor']['_suppressNextCompression'] = false;

    chef.restore(snap);

    expect(chef['janitor']['_externalTokenUsage']).toBe(999);
    expect(chef['janitor']['_suppressNextCompression']).toBe(true);
  });

  it('agent branching pattern: snapshot before fork, restore on failure', async () => {
    const chef = new ContextChef();
    chef.useRollingHistory([userMsg('task: do something risky')]);

    const beforeFork = chef.snapshot('before risky tool call');

    // Simulate a failed branch
    chef.useRollingHistory([
      ...chef['rollingHistory'],
      assistantMsg('attempting risky action...'),
      { role: 'tool', content: 'ERROR: action failed', tool_call_id: 't1' },
    ]);
    expect(chef['rollingHistory']).toHaveLength(3);

    // Roll back to before the fork
    chef.restore(beforeFork);
    expect(chef['rollingHistory']).toHaveLength(1);
    expect(chef['rollingHistory'][0].content).toBe('task: do something risky');
  });
});
