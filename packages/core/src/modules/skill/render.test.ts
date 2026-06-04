import { describe, expect, it } from 'vitest';
import { renderSkill, type Skill } from '.';

const base: Skill = { name: 's', description: 'd', instructions: '' };

describe('renderSkill', () => {
  it('replaces $ARGUMENTS with the full raw args string', () => {
    const out = renderSkill(
      { ...base, instructions: 'Triage $ARGUMENTS now' },
      { args: 'p0 fire' },
    );
    expect(out.instructions).toBe('Triage p0 fire now');
  });

  it('replaces 0-based shorthand and indexed args; missing → empty', () => {
    const out = renderSkill(
      { ...base, instructions: 'first=$0 second=$1 third=$ARGUMENTS[2]' },
      { args: 'a b' },
    );
    expect(out.instructions).toBe('first=a second=b third=');
  });

  it('respects quoted args when splitting', () => {
    const out = renderSkill({ ...base, instructions: '$0|$1' }, { args: '"hello world" x' });
    expect(out.instructions).toBe('hello world|x');
  });

  it('replaces named args via argumentNames positionally', () => {
    const out = renderSkill(
      { ...base, instructions: 'Hi $who, do $what' },
      { args: 'alice deploy', argumentNames: ['who', 'what'] },
    );
    expect(out.instructions).toBe('Hi alice, do deploy');
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder under test
  it('substitutes provided ${VARS} and leaves unknown ones untouched', () => {
    const out = renderSkill(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder under test
      { ...base, instructions: 'dir=${SKILL_DIR} miss=${NOPE}' },
      { vars: { SKILL_DIR: '/skills/pdf' } },
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder under test
    expect(out.instructions).toBe('dir=/skills/pdf miss=${NOPE}');
  });

  it('prepends the base directory header when includeBaseDir is set', () => {
    const out = renderSkill(
      { ...base, baseDir: '/skills/pdf', instructions: 'body' },
      {
        includeBaseDir: true,
      },
    );
    expect(out.instructions).toBe('Base directory for this skill: /skills/pdf\n\nbody');
  });

  it('appends ARGUMENTS when args are given but no placeholder is present', () => {
    const out = renderSkill({ ...base, instructions: 'no placeholders' }, { args: 'x y' });
    expect(out.instructions).toBe('no placeholders\n\nARGUMENTS: x y');
  });

  it('does not append when args is empty or appendArgsIfNoPlaceholder is false', () => {
    expect(renderSkill({ ...base, instructions: 'body' }, { args: '' }).instructions).toBe('body');
    expect(
      renderSkill(
        { ...base, instructions: 'body' },
        {
          args: 'x',
          appendArgsIfNoPlaceholder: false,
        },
      ).instructions,
    ).toBe('body');
  });

  it('does not append for whitespace-only args', () => {
    const out = renderSkill({ ...base, instructions: 'body' }, { args: '   ' });
    expect(out.instructions).toBe('body');
  });

  it('leaves the $-family untouched when args is undefined', () => {
    const out = renderSkill({ ...base, instructions: 'keep $ARGUMENTS and $0' }, {});
    expect(out.instructions).toBe('keep $ARGUMENTS and $0');
  });

  it('returns a new object and does not mutate the input', () => {
    const input = { ...base, instructions: '$ARGUMENTS' };
    const out = renderSkill(input, { args: 'z' });
    expect(input.instructions).toBe('$ARGUMENTS');
    expect(out).not.toBe(input);
  });
});
