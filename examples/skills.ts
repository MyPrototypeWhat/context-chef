/**
 * Skills — portable behavior bundles (SKILL.md compatible)
 *
 * Demonstrates:
 * - Constructing Skill objects directly and loading one from a SKILL.md file
 * - registerSkills + activateSkill by name (and clearing with null)
 * - renderSkill: $ARGUMENTS / $name / ${VAR} placeholder substitution
 * - formatSkillListing for a system-prompt skill directory
 * - meta.activeSkillName on the compiled payload
 *
 * Runs fully offline — no API key required.
 *
 * Usage:
 *   npx tsx examples/skills.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ContextChef,
  formatSkillListing,
  loadSkill,
  renderSkill,
  type Skill,
} from '@context-chef/core';

// ─── Skills as plain objects ────────────────────────────────────────────────
// A Skill is just data — no loader required. `allowedTools` is annotation
// only: chef never enforces it (wire it to the Pruner yourself if you want
// hard restriction).

const codeReview: Skill = {
  name: 'code-review',
  description: 'Structured review of a diff or file',
  whenToUse: 'When the user asks for a review of code they wrote',
  instructions: [
    'You are in code-review mode.',
    '1. Read the code fully before commenting.',
    '2. Report issues ordered by severity; include a fix suggestion for each.',
    '3. Never rewrite code the user did not ask you to change.',
  ].join('\n'),
  allowedTools: ['read_file', 'grep'],
};

const bugTriage: Skill = {
  name: 'bug-triage',
  description: 'Reproduce, isolate, and rank incoming bug reports',
  whenToUse: 'When the user pastes a stack trace or error log',
  instructions: 'You are in bug-triage mode. Reproduce first, speculate never.',
};

// ─── Loading a SKILL.md from disk ───────────────────────────────────────────
// Convention: <dir>/<skill-name>/SKILL.md with YAML frontmatter. `loadSkill`
// reads one file; `loadSkillsDir(dir)` scans a directory of them tolerantly.

const SKILL_MD = `---
name: release-notes
description: Draft release notes from merged PR titles
when-to-use: When the user asks to summarize a release
---
Draft release notes for version $version.

Group changes as Features / Fixes / Chores. Base directory files
(templates, prior notes) live next to this skill.

ARGS RECEIVED: $ARGUMENTS
`;

async function loadFromDisk(): Promise<{ skill: Skill; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'chef-skill-'));
  const file = join(dir, 'SKILL.md');
  await writeFile(file, SKILL_MD, 'utf8');
  const skill = await loadSkill(file); // throws on parse errors; baseDir auto-set
  return { skill, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function main() {
  console.log('=== ContextChef Skills Example ===\n');

  const { skill: releaseNotes, cleanup } = await loadFromDisk();
  console.log('--- Loaded from SKILL.md ---');
  console.log('name:', releaseNotes.name);
  console.log('description:', releaseNotes.description);
  console.log('whenToUse:', releaseNotes.whenToUse);
  console.log('baseDir:', releaseNotes.baseDir, '\n');

  // renderSkill substitutes $-placeholders into a COPY of the instructions.
  // `argumentNames` maps positional args to $name placeholders; `vars` fills
  // ${NAME} templates. Pure function — the original skill is untouched.
  const rendered = renderSkill(releaseNotes, {
    args: '2.4.0 --draft',
    argumentNames: ['version'],
  });
  console.log('--- renderSkill output ---');
  console.log(`${rendered.instructions}\n`);

  // A skill directory listing for the system prompt, so the LLM can decide
  // which skill to request. Plain or XML, with an optional character budget.
  const allSkills = [codeReview, bugTriage, releaseNotes];
  console.log('--- formatSkillListing (plain) ---');
  console.log(formatSkillListing(allSkills));
  console.log('\n--- formatSkillListing (xml, truncated to 240 chars) ---');
  console.log(formatSkillListing(allSkills, { format: 'xml', maxChars: 240 }));

  // ─── Activation ───────────────────────────────────────────────────────────
  // registerSkills stores the set; activateSkill('name') resolves from it
  // (throws on unknown names). Passing a Skill object directly also works
  // without registration. On the next compile() the active skill's
  // instructions land as a dedicated system message between your system
  // prompt and the history.
  const chef = new ContextChef();
  chef.registerSkills(allSkills);
  chef.activateSkill('code-review');

  const payload = await chef
    .setSystemPrompt([{ role: 'system', content: 'You are a helpful engineering assistant.' }])
    .setHistory([{ role: 'user', content: 'Please review my parser changes.' }])
    .compile({ target: 'openai' });

  console.log('\n--- Compiled with active skill ---');
  console.log('meta.activeSkillName:', payload.meta?.activeSkillName);
  const injected = (payload.messages as Array<{ role: string; content?: unknown }>).find(
    (m) => m.role === 'system' && String(m.content).includes('code-review mode'),
  );
  console.log('skill instructions injected as system message:', injected !== undefined);

  // Deactivate: activateSkill(null) clears the instructions slot.
  chef.activateSkill(null);
  const cleared = await chef.compile({ target: 'openai' });
  console.log('after activateSkill(null):', cleared.meta?.activeSkillName ?? '(none)');

  await cleanup();
}

main().catch(console.error);
