/**
 * The handoff budget's own units: config validation, notice rendering, and the
 * `new_context` definition. The pipeline behaviour they feed is covered in
 * `tests/handoff.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { Prompts } from '../prompts';
import {
  HANDOFF_REMAINING_PLACEHOLDER,
  renderHandoffNotice,
  validateHandoffConfig,
} from './handoff';
import { getNewContextToolDefinition } from './newContextTool';

describe('validateHandoffConfig()', () => {
  it('fills in the built-in prompt', () => {
    expect(validateHandoffConfig({ budgetTokens: 2000 })).toEqual({
      budgetTokens: 2000,
      prompt: Prompts.HANDOFF_NOTICE_TEMPLATE,
    });
  });

  it('trims the caller prompt and keeps it', () => {
    expect(validateHandoffConfig({ budgetTokens: 1, prompt: '  persist now  ' })).toEqual({
      budgetTokens: 1,
      prompt: 'persist now',
    });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 12.5],
    ['not a number', Number.NaN],
  ])('rejects a %s budget', (_label, budgetTokens) => {
    expect(() => validateHandoffConfig({ budgetTokens })).toThrow(/positive integer/);
  });

  it('rejects a prompt that is empty after trimming', () => {
    expect(() => validateHandoffConfig({ budgetTokens: 100, prompt: '   \n ' })).toThrow(
      /prompt is empty/,
    );
  });

  it('rejects a prompt over the 2000-byte cap, counting UTF-8 bytes', () => {
    // 1000 three-byte characters: under the cap by length, over it by bytes.
    const wide = '窗'.repeat(1000);
    expect(wide.length).toBeLessThan(2000);
    expect(() => validateHandoffConfig({ budgetTokens: 100, prompt: wide })).toThrow(
      /3000 UTF-8 bytes, over the 2000-byte cap/,
    );
    expect(() =>
      validateHandoffConfig({ budgetTokens: 100, prompt: 'a'.repeat(2000) }),
    ).not.toThrow();
  });

  it('keeps the built-in template inside the cap', () => {
    expect(new TextEncoder().encode(Prompts.HANDOFF_NOTICE_TEMPLATE).length).toBeLessThan(2000);
    expect(Prompts.HANDOFF_NOTICE_TEMPLATE).toContain(HANDOFF_REMAINING_PLACEHOLDER);
  });
});

describe('renderHandoffNotice()', () => {
  it('substitutes every occurrence', () => {
    expect(renderHandoffNotice('{n_remaining} left, really {n_remaining}', 1200)).toBe(
      '1200 left, really 1200',
    );
  });

  it('rounds a fractional budget and clamps a negative one', () => {
    expect(renderHandoffNotice('{n_remaining}', 1999.6)).toBe('2000');
    expect(renderHandoffNotice('{n_remaining}', -400)).toBe('0');
  });

  it('passes a prompt without the placeholder through unchanged', () => {
    expect(renderHandoffNotice('wrap it up', 10)).toBe('wrap it up');
  });
});

describe('getNewContextToolDefinition()', () => {
  it('is parameterless and reference-stable', () => {
    const first = getNewContextToolDefinition();
    const second = getNewContextToolDefinition();

    expect(first).toBe(second);
    expect(first).toEqual(second);
    expect(first.name).toBe('new_context');
    expect(first.parameters).toBeUndefined();
    expect(Object.isFrozen(first)).toBe(true);
  });
});
