import type { Skill } from './index';

export interface RenderSkillOptions {
  /** Raw argument string. Drives the $-family. Parsed quote-aware (whitespace fallback). */
  args?: string;
  /** Positional→name map for `$name` placeholders. Host-supplied. */
  argumentNames?: string[];
  /** Key→value map for `${NAME}` template placeholders (e.g. SKILL_DIR, SESSION_ID).
   *  Applied before the $-argument family, so a value here that itself contains
   *  `$N` / `$ARGUMENTS` will then be processed by that pass. */
  vars?: Record<string, string>;
  /** Prepend `Base directory for this skill: {baseDir}\n\n` (common base-directory convention). */
  includeBaseDir?: boolean;
  /** When `args` is non-empty and no $-placeholder matched, append `\n\nARGUMENTS: {args}`. Default true. */
  appendArgsIfNoPlaceholder?: boolean;
}

/** Split a raw argument string into tokens, honoring single/double quotes. */
function parseArgs(raw: string): string[] {
  if (!raw.trim()) return [];
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '');
  }
  return tokens;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Return a copy of `skill` with `instructions` rendered. Pure: no filesystem,
 * no shell, no slash parsing. Placeholder semantics follow the de-facto
 * `$ARGUMENTS` convention (0-based positional, no `$` escaping).
 */
export function renderSkill(skill: Skill, opts: RenderSkillOptions = {}): Skill {
  const {
    args,
    argumentNames = [],
    vars = {},
    includeBaseDir = false,
    appendArgsIfNoPlaceholder = true,
  } = opts;

  let text = skill.instructions;

  if (includeBaseDir && skill.baseDir) {
    text = `Base directory for this skill: ${skill.baseDir}\n\n${text}`;
  }

  // ${NAME} templating — only keys present in `vars`; others left untouched.
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) =>
    Object.hasOwn(vars, name) ? vars[name] : match,
  );

  if (args !== undefined) {
    const beforeArgs = text;
    const parsed = parseArgs(args);

    // Named args ($name) — positional via argumentNames; word-boundary match.
    argumentNames.forEach((name, i) => {
      if (!name) return;
      text = text.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'), parsed[i] ?? '');
    });

    // Indexed $ARGUMENTS[i] (0-based).
    text = text.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, idx: string) => parsed[Number(idx)] ?? '');

    // Shorthand $i (0-based).
    text = text.replace(/\$(\d+)(?!\w)/g, (_m, idx: string) => parsed[Number(idx)] ?? '');

    // Full $ARGUMENTS — the raw string.
    text = text.replaceAll('$ARGUMENTS', args);

    if (text === beforeArgs && appendArgsIfNoPlaceholder && args.trim()) {
      text = `${text}\n\nARGUMENTS: ${args}`;
    }
  }

  return { ...skill, instructions: text };
}
