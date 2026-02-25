import { Governor } from '../src/modules/Governor';
import type { Message } from '../src/types';

describe('Governor', () => {
  let governor: Governor;

  beforeEach(() => {
    governor = new Governor();
  });

  // ─── enforceXML ───

  describe('enforceXML', () => {
    it('empty state: adds a system message with XML guardrail', () => {
      const result = governor.applyGovernance([], { enforceXML: { outputTag: 'response' } });

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toContain('<response>');
    });

    it('appends guardrail to existing system message instead of creating a new one', () => {
      const state: Message[] = [{ role: 'system', content: 'CURRENT TASK STATE:\n<task/>' }];
      const result = governor.applyGovernance(state, {
        enforceXML: { outputTag: 'task_response' },
      });

      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('CURRENT TASK STATE:');
      expect(result[0].content).toContain('task_response');
    });

    it('creates new system message when no system message exists', () => {
      const state: Message[] = [{ role: 'user', content: 'Hello' }];
      const result = governor.applyGovernance(state, { enforceXML: { outputTag: 'reply' } });

      expect(result).toHaveLength(2);
      const sysMsg = result.find((m) => m.role === 'system');
      expect(sysMsg).toBeDefined();
      expect(sysMsg!.content).toContain('reply');
    });

    it('guardrail does not include <thinking> tag instructions', () => {
      const result = governor.applyGovernance([], { enforceXML: { outputTag: 'out' } });

      expect(result[0].content).not.toContain('<thinking>');
    });

    it('guardrail content contains EPHEMERAL_MESSAGE wrapper', () => {
      const result = governor.applyGovernance([], { enforceXML: { outputTag: 'final_code' } });

      expect(result[0].content).toContain('EPHEMERAL_MESSAGE');
    });
  });

  // ─── prefill ───

  describe('prefill', () => {
    it('empty state: adds an assistant message', () => {
      const result = governor.applyGovernance([], { prefill: '<thinking>\nAnalyzing...' });

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');
      expect(result[0].content).toBe('<thinking>\nAnalyzing...');
    });

    it('appends prefill after existing state messages', () => {
      const state: Message[] = [{ role: 'system', content: 'base rules' }];
      const result = governor.applyGovernance(state, { prefill: '<thinking>' });

      expect(result).toHaveLength(2);
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toBe('<thinking>');
    });
  });

  // ─── enforceXML + prefill combined ───

  describe('enforceXML + prefill combined', () => {
    it('both options: applies XML guardrail then prefill assistant message', () => {
      const result = governor.applyGovernance([], {
        enforceXML: { outputTag: 'final_answer' },
        prefill: '<thinking>\nLet me think...',
      });

      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
      expect(result[0].content).toContain('final_answer');
      expect(result[1].role).toBe('assistant');
      expect(result[1].content).toBe('<thinking>\nLet me think...');
    });
  });

  // ─── edge cases ───

  describe('edge cases', () => {
    it('empty options object: returns a copy of state without modification', () => {
      const state: Message[] = [{ role: 'system', content: 'base' }];
      const result = governor.applyGovernance(state, {});

      expect(result).toEqual(state);
      expect(result).not.toBe(state); // must return a new array
    });

    it('does not mutate the original state array', () => {
      const state: Message[] = [{ role: 'system', content: 'original' }];
      const originalLength = state.length;

      governor.applyGovernance(state, {
        enforceXML: { outputTag: 'out' },
        prefill: '<thinking>',
      });

      expect(state).toHaveLength(originalLength);
      expect(state[0].content).toBe('original');
    });

    it('consecutive calls accumulate state correctly', () => {
      const afterXml = governor.applyGovernance([], { enforceXML: { outputTag: 'step1' } });
      expect(afterXml).toHaveLength(1);

      const afterPrefill = governor.applyGovernance(afterXml, { prefill: '<thinking>' });
      expect(afterPrefill).toHaveLength(2);
      expect(afterPrefill[0].role).toBe('system');
      expect(afterPrefill[1].role).toBe('assistant');
    });

    it('different outputTags produce different guardrail content', () => {
      const result1 = governor.applyGovernance([], { enforceXML: { outputTag: 'alpha' } });
      const result2 = governor.applyGovernance([], { enforceXML: { outputTag: 'beta' } });

      expect(result1[0].content).toContain('alpha');
      expect(result2[0].content).toContain('beta');
      expect(result1[0].content).not.toContain('beta');
    });
  });
});
