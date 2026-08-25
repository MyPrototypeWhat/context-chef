import { describe, expect, it } from 'vitest';
import { ContextChef } from '../src/index';

// Regression for the pre-4.1 bug where `_compiling` was set on the first
// compile and never reset: every later compile() took the re-entrancy bypass,
// permanently disabling the Snapshot + Serialize queue.
describe('compile() re-entrancy flag lifecycle', () => {
  const flag = (chef: ContextChef) => (chef as unknown as { _compiling: boolean })._compiling;

  it('resets after each top-level compile, so later compiles still queue', async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'q' }]);

    await chef.compile({ target: 'openai' });
    expect(flag(chef)).toBe(false);
    await chef.compile({ target: 'openai' });
    expect(flag(chef)).toBe(false);
  });

  it('resets after a compile that throws', async () => {
    const chef = new ContextChef({
      onBeforeCompile: () => {
        throw new Error('boom');
      },
    });
    chef.setHistory([{ role: 'user', content: 'q' }]);

    await expect(chef.compile({ target: 'openai' })).rejects.toThrow('boom');
    expect(flag(chef)).toBe(false);
  });

  it('stays set across a nested (re-entrant) compile so repeated inner calls never deadlock', async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'q' }]);

    let innerRuns = 0;
    let flagDuringOuter: boolean | undefined;
    const onStart = async () => {
      if (innerRuns >= 1) return; // only nest from the outer compile
      innerRuns++;
      chef.off('compile:start', onStart);
      // Two consecutive inner compiles: if the first inner call's finally
      // cleared the flag, the second would queue behind the held chain and
      // deadlock. The 5s test timeout is the failure detector.
      await chef.compile({ target: 'openai' });
      flagDuringOuter = flag(chef);
      await chef.compile({ target: 'openai' });
    };
    chef.on('compile:start', onStart);

    await chef.compile({ target: 'openai' });
    expect(innerRuns).toBe(1);
    expect(flagDuringOuter).toBe(true); // inner completion must NOT clear the outer's flag
    expect(flag(chef)).toBe(false); // outer completion does
  });

  it("restores the outer compile's signal after a nested compile finishes", async () => {
    const chef = new ContextChef();
    chef.setHistory([{ role: 'user', content: 'q' }]);
    const outerSignal = new AbortController().signal;
    const currentSignal = () =>
      (chef as unknown as { _currentSignal?: AbortSignal })._currentSignal;

    let signalAfterInner: AbortSignal | undefined;
    let nested = false;
    const onStart = async () => {
      if (nested) return;
      nested = true;
      chef.off('compile:start', onStart);
      await chef.compile({ target: 'openai' }); // inner compile, no signal of its own
      // The rest of the OUTER compile still forwards the caller's signal to
      // event-bridge handlers — the inner finally must restore, not clear.
      signalAfterInner = currentSignal();
    };
    chef.on('compile:start', onStart);

    await chef.compile({ target: 'openai', signal: outerSignal });
    expect(signalAfterInner).toBe(outerSignal);
    expect(currentSignal()).toBeUndefined(); // outer completion clears
  });
});
