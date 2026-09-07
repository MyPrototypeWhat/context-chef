import type { Phase } from '../context';
import { escapeXmlAttribute } from '../xml';

/**
 * Skill instructions slot. Under 'after_system' (default) they are a single
 * dedicated system message between the user system prompt and the memory
 * messages — NOT appended to the user system prompt, so the cache breakpoint
 * stays clean and LLM attribution is direct. Under 'tail' they leave the
 * prefix entirely and ride the tail stitch instead.
 */
export const skillPhase: Phase = {
  name: 'skill',
  async run(ctx, host) {
    const { name, instructions, placement } = host.skill;
    const skillActive = instructions.length > 0;

    ctx.skillMessages =
      skillActive && placement === 'after_system'
        ? [{ role: 'system', content: instructions }]
        : [];
    ctx.skillTailXml =
      skillActive && placement === 'tail'
        ? `<skill_instructions skill="${escapeXmlAttribute(name ?? '')}">\n${instructions}\n</skill_instructions>`
        : '';

    // Reported for any active skill, including one whose instructions are empty.
    if (name !== undefined) ctx.meta.activeSkillName = name;
  },
};
