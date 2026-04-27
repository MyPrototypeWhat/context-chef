import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * A Skill is a portable bundle of `(name + description + instructions + ...)` that
 * scopes agent behavior for a specific phase or domain.
 *
 * Skill is fully decoupled from Pruner: `allowedTools` is annotation only — chef
 * does NOT enforce it. Developers wire the annotation to Pruner explicitly if they
 * want hard tool restriction.
 */
export interface Skill {
  /** Unique identifier within a registered set. */
  name: string;
  /** Short summary; surfaces in `formatSkillListing`. */
  description: string;
  /** Optional longer guidance for LLM activation decisions. */
  whenToUse?: string;
  /** Markdown body with frontmatter stripped. Injected into the message sandwich on activation. */
  instructions: string;
  /**
   * ANNOTATION ONLY. ContextChef does NOT consult this field.
   * Present so `SKILL.md` files stay portable across ecosystems (Claude Code, OpenCode, etc.).
   * To enforce: wire `chef.getPruner().setBlockedTools(allTools.filter(n => !skill.allowedTools?.includes(n)))`.
   */
  allowedTools?: string[];
  /**
   * Absolute directory of the SKILL.md file when loaded from disk.
   * Use this to resolve reference paths in user code (chef does NOT auto-load references).
   */
  baseDir?: string;
}

/** Result of `loadSkillsDir`: tolerant — successful skills + per-file errors. */
export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
}

export interface FormatSkillListingOptions {
  /** Truncation budget; if omitted, the listing is returned in full. */
  maxChars?: number;
  /** `'plain'` (default) or `'xml'`. */
  format?: 'plain' | 'xml';
  /** Append the `whenToUse` field if present. Default: true. */
  includeWhenToUse?: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Load a single SKILL.md file. Throws on parse error. `baseDir` is auto-set to
 * the directory containing the file.
 */
export async function loadSkill(filePath: string): Promise<Skill> {
  const source = await readFile(filePath, 'utf8');
  const { data, body } = parseFrontmatter(source, filePath);
  return buildSkill(data, body, filePath, dirname(filePath));
}

/**
 * Scan a directory for skills. Convention: `dirPath/<skill-name>/SKILL.md`
 * (one level deep, NOT recursive). Tolerant: collects errors instead of
 * aborting on the first bad skill. Sub-directories without a `SKILL.md` are
 * silently skipped.
 */
export async function loadSkillsDir(dirPath: string): Promise<SkillLoadResult> {
  const result: SkillLoadResult = { skills: [], errors: [] };

  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch (err) {
    result.errors.push({
      path: dirPath,
      message: `Failed to read skills directory: ${formatError(err)}`,
    });
    return result;
  }

  for (const entry of [...entries].sort()) {
    const subdir = join(dirPath, entry);
    let dirInfo: Awaited<ReturnType<typeof stat>>;
    try {
      dirInfo = await stat(subdir);
    } catch (err) {
      // Genuine "not there" entries (race with rm) are silently skipped;
      // any other failure (EACCES, EIO, ELOOP, EPERM, …) is surfaced rather
      // than silently dropping the skill from the result.
      if (isENOENT(err)) continue;
      result.errors.push({
        path: subdir,
        message: `Failed to stat sub-directory: ${formatError(err)}`,
      });
      continue;
    }
    if (!dirInfo.isDirectory()) continue;

    const skillFile = join(subdir, 'SKILL.md');
    let fileInfo: Awaited<ReturnType<typeof stat>>;
    try {
      fileInfo = await stat(skillFile);
    } catch (err) {
      // ENOENT here means "directory has no SKILL.md" — the documented
      // silent-skip case. Anything else (permissions, IO) is a real error.
      if (isENOENT(err)) continue;
      result.errors.push({
        path: skillFile,
        message: `Failed to stat SKILL.md: ${formatError(err)}`,
      });
      continue;
    }
    if (!fileInfo.isFile()) continue;

    try {
      const skill = await loadSkill(skillFile);
      result.skills.push(skill);
    } catch (err) {
      result.errors.push({ path: skillFile, message: formatError(err) });
    }
  }

  return result;
}

/**
 * Render a list of skills as a system-prompt-friendly listing.
 * No default character budget — the developer knows their context window.
 */
export function formatSkillListing(
  skills: Skill[],
  options: FormatSkillListingOptions = {},
): string {
  const format = options.format ?? 'plain';
  const includeWhenToUse = options.includeWhenToUse ?? true;

  const output =
    format === 'xml' ? renderXml(skills, includeWhenToUse) : renderPlain(skills, includeWhenToUse);

  return options.maxChars !== undefined ? truncate(output, options.maxChars) : output;
}

// ─── Frontmatter parsing (minimal, dependency-free) ─────────────────────────

interface ParsedFrontmatter {
  data: Record<string, unknown>;
  body: string;
}

/**
 * Parse `---\n<yaml>\n---\n<body>`. Tolerates CRLF and optional trailing
 * whitespace on the delimiter lines. Throws on missing or unterminated
 * frontmatter.
 */
function parseFrontmatter(source: string, filePath: string): ParsedFrontmatter {
  const normalized = source.replace(/\r\n?/g, '\n');

  const firstNewline = normalized.indexOf('\n');
  if (firstNewline === -1 || normalized.slice(0, firstNewline).trim() !== '---') {
    throw new Error(
      `SKILL parse error in ${filePath}: file must begin with a "---" frontmatter delimiter.`,
    );
  }

  const after = normalized.slice(firstNewline + 1);
  const lines = after.split('\n');

  let closeLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeLineIdx = i;
      break;
    }
  }
  if (closeLineIdx === -1) {
    throw new Error(
      `SKILL parse error in ${filePath}: unterminated frontmatter (missing closing "---" line).`,
    );
  }

  const yaml = lines.slice(0, closeLineIdx).join('\n');
  const body = lines.slice(closeLineIdx + 1).join('\n');

  return { data: parseYamlSubset(yaml, filePath), body };
}

/**
 * Minimal YAML subset sufficient for SKILL.md frontmatter:
 *   key: value          (string)
 *   key: "value"        (quoted string, single or double)
 *   key: [a, b, c]      (inline string array)
 * Comments (`#`) and blank lines are skipped. Block scalars and nested mappings
 * are not supported — they would silently swallow content, so we throw instead.
 */
function parseYamlSubset(yaml: string, filePath: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (line[0] === ' ' || line[0] === '\t') {
      throw new Error(
        `SKILL frontmatter parse error in ${filePath} (line ${i + 1}): indented values are not supported.`,
      );
    }

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(
        `SKILL frontmatter parse error in ${filePath} (line ${i + 1}): expected "key: value", got "${line}".`,
      );
    }

    const key = line.slice(0, colonIdx).trim();
    if (!key) {
      throw new Error(`SKILL frontmatter parse error in ${filePath} (line ${i + 1}): empty key.`);
    }

    data[key] = parseYamlValue(line.slice(colonIdx + 1).trim());
  }

  return data;
}

function parseYamlValue(raw: string): unknown {
  if (raw === '') return '';

  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => stripQuotes(item.trim()));
  }

  return stripQuotes(raw);
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ─── Skill construction ─────────────────────────────────────────────────────

function buildSkill(
  data: Record<string, unknown>,
  body: string,
  filePath: string,
  baseDir?: string,
): Skill {
  const name = data.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`SKILL parse error in ${filePath}: missing required field "name".`);
  }

  const description = data.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`SKILL parse error in ${filePath}: missing required field "description".`);
  }

  const skill: Skill = {
    name: name.trim(),
    description: description.trim(),
    instructions: body.trim(),
  };

  if (data.whenToUse !== undefined) {
    if (typeof data.whenToUse !== 'string') {
      throw new Error(`SKILL parse error in ${filePath}: "whenToUse" must be a string.`);
    }
    skill.whenToUse = data.whenToUse.trim();
  }

  if (data.allowedTools !== undefined) {
    if (
      !Array.isArray(data.allowedTools) ||
      !data.allowedTools.every((v) => typeof v === 'string')
    ) {
      throw new Error(
        `SKILL parse error in ${filePath}: "allowedTools" must be an array of strings.`,
      );
    }
    skill.allowedTools = data.allowedTools.map((s) => s.trim()).filter(Boolean);
  }

  if (baseDir) skill.baseDir = baseDir;

  return skill;
}

// ─── Listing renderers ──────────────────────────────────────────────────────

function renderPlain(skills: Skill[], includeWhenToUse: boolean): string {
  return skills
    .map((s) => {
      let line = `- ${s.name}: ${s.description}`;
      if (includeWhenToUse && s.whenToUse) {
        line += ` (when: ${s.whenToUse})`;
      }
      return line;
    })
    .join('\n');
}

function renderXml(skills: Skill[], includeWhenToUse: boolean): string {
  if (skills.length === 0) return '<skills></skills>';
  const items = skills.map((s) => {
    const parts: string[] = [`  <skill name="${escapeXml(s.name)}">`];
    parts.push(`    <description>${escapeXml(s.description)}</description>`);
    if (includeWhenToUse && s.whenToUse) {
      parts.push(`    <whenToUse>${escapeXml(s.whenToUse)}</whenToUse>`);
    }
    parts.push('  </skill>');
    return parts.join('\n');
  });
  return `<skills>\n${items.join('\n')}\n</skills>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const ellipsis = '...';
  if (maxChars <= ellipsis.length) return text.slice(0, maxChars);
  return text.slice(0, maxChars - ellipsis.length) + ellipsis;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
