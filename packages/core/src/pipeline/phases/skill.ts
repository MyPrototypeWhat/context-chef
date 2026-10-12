import { sourceEvents } from '../../prefix';
import { Prompts } from '../../prompts';
import type { Phase } from '../context';
import { escapeXmlAttribute } from '../xml';

/**
 * Skill instructions slot. Under 'after_system' (default) they are a single
 * dedicated system message between the user system prompt and the memory
 * messages — NOT appended to the user system prompt, so the cache breakpoint
 * stays clean and LLM attribution is direct. Under 'tail' they leave the
 * prefix entirely and ride the tail stitch instead.
 *
 * Under `appendOnly`, 'tail' (its default there) makes them an event on the
 * system channel: appended once when a skill is activated or switched, with
 * a tombstone once none is active. An explicit 'after_system' keeps the
 * system message, and each change to it is a `system` checkpoint.
 */
export const skillPhase: Phase = {
  name: 'skill',
  async run(ctx, host) {
    const { name, instructions, placement } = host.skill;
    const skillActive = instructions.length > 0;

    if (ctx.prefix && placement === 'tail') {
      const skill = escapeXmlAttribute(name ?? '');
      ctx.skillEvents = sourceEvents(ctx.prefix.ledger, [
        {
          source: 'skill',
          current: skillActive
            ? {
                channel: 'system',
                render: (rev) => Prompts.getSkillEvent(skill, instructions, rev),
              }
            : undefined,
          tombstone: (rev) =>
            Prompts.getWithdrawnBlock('skill_instructions', rev, Prompts.SKILL_WITHDRAWN),
        },
      ]);
    } else {
      ctx.skillMessages =
        skillActive && placement === 'after_system'
          ? [{ role: 'system', content: instructions }]
          : [];
      ctx.skillTailXml =
        skillActive && placement === 'tail'
          ? `<skill_instructions skill="${escapeXmlAttribute(name ?? '')}">\n${instructions}\n</skill_instructions>`
          : '';
    }

    // Reported for any active skill, including one whose instructions are empty.
    if (name !== undefined) ctx.meta.activeSkillName = name;
  },
};
