import { readdir, readFile, realpath, stat } from 'node:fs/promises';
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
  /**
   * Unknown frontmatter keys, verbatim (raw key spelling). chef NEVER reads
   * this — it is host-facing annotation, the same stance as `allowedTools`.
   * Fields like `argument-hint` / `version` / `model` land here.
   */
  metadata?: Record<string, unknown>;
}

/** Result of `loadSkillsDir`: tolerant — successful skills + per-file errors. */
export interface SkillLoadResult {
  skills: Skill[];
  errors: Array<{ path: string; message: string }>;
}

export interface LoadSkillsDirsOptions {
  /** Collision resolution on duplicate skill names. Default 'last-wins'. */
  precedence?: 'last-wins' | 'first-wins';
  /** Per-source prefix: returns the namespace for a dir, producing `${ns}:${name}`. */
  namespace?: (dir: string) => string | undefined;
}

export interface FormatSkillListingOptions {
  /** Truncation budget; if omitted, the listing is returned in full. */
  maxChars?: number;
  /** `'plain'` (default) or `'xml'`. */
  format?: 'plain' | 'xml';
  /** Append the `whenToUse` field if present. Default: true. */
  includeWhenToUse?: boolean;
}

export { type RenderSkillOptions, renderSkill } from './render';

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
 * Load skills from multiple directories and merge them. Each dir is scanned via
 * {@link loadSkillsDir}. Directories that resolve to the same realpath are scanned
 * once. Name collisions resolve by `precedence` ('last-wins' default); an optional
 * `namespace` prefixes each source's skill names as `${ns}:${name}`. Tolerant:
 * per-dir errors are aggregated, never thrown. No auto-discovery — the caller
 * passes the directory list. Merged skill order follows each name's first-seen
 * position (a last-wins overwrite updates the value in place, not the order).
 */
export async function loadSkillsDirs(
  dirs: string[],
  opts: LoadSkillsDirsOptions = {},
): Promise<SkillLoadResult> {
  const precedence = opts.precedence ?? 'last-wins';
  const errors: SkillLoadResult['errors'] = [];
  const byName = new Map<string, Skill>();
  const seenDirs = new Set<string>();

  for (const dir of dirs) {
    let realDir: string;
    try {
      realDir = await realpath(dir);
    } catch {
      realDir = dir; // let loadSkillsDir surface the read error below
    }
    if (seenDirs.has(realDir)) continue;
    seenDirs.add(realDir);

    const result = await loadSkillsDir(dir);
    errors.push(...result.errors);

    const ns = opts.namespace?.(dir);
    for (const skill of result.skills) {
      const named = ns ? { ...skill, name: `${ns}:${skill.name}` } : skill;
      if (precedence === 'first-wins' && byName.has(named.name)) continue;
      byName.set(named.name, named);
    }
  }

  return { skills: [...byName.values()], errors };
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
 *   key:                (block sequence on the following `- item` lines → string array)
 *     - a
 *     - b
 *   key: >              (folded block scalar — joined to one line)
 *   key: |              (literal block scalar — newlines preserved)
 * Comments (`#`) and blank lines are skipped. All scalars stay strings — no
 * type coercion. Indented blocks that are NOT a block scalar or a block
 * sequence (e.g. nested mappings) are skipped leniently rather than throwing,
 * so externally authored files load instead of failing.
 */
function parseYamlSubset(yaml: string, filePath: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const lines = yaml.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip blanks, comments, and stray indented lines. Stray indented lines
    // outside a recognized block (e.g. a leading indented line, or content
    // under a plain `key: value`) are skipped here.
    if (!trimmed || trimmed.startsWith('#') || line[0] === ' ' || line[0] === '\t') {
      i++;
      continue;
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
    const rest = line.slice(colonIdx + 1).trim();

    // Block scalar: `|` literal or `>` folded. Chomp/indent indicators
    // (|-, |+, >2, …) are tolerated but ignored.
    if (/^[|>][+-]?\d*\s*$/.test(rest)) {
      const style = rest[0] as '|' | '>';
      const bodyLines: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (next.trim() !== '' && next[0] !== ' ' && next[0] !== '\t') break;
        bodyLines.push(next);
        i++;
      }
      data[key] = foldBlockScalar(bodyLines, style);
      continue;
    }

    // Empty inline value: may be followed by an indented block. A block
    // sequence (`- item`) parses into a string array; any other indented block
    // (e.g. a nested mapping) is unsupported and skipped WITHOUT recording a
    // misleading empty value. A genuinely empty value stays "".
    if (rest === '') {
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j];
        if (next.trim() !== '' && next[0] !== ' ' && next[0] !== '\t') break;
        j++;
      }
      const blockBody = lines.slice(i + 1, j).filter((l) => l.trim() !== '');
      if (blockBody.length > 0 && blockBody.every((l) => /^\s*-\s+/.test(l))) {
        data[key] = blockBody.map((l) => stripQuotes(l.replace(/^\s*-\s+/, '').trim()));
        i = j;
        continue;
      }
      if (blockBody.length > 0) {
        // Indented block that is neither a block scalar nor a `- item` sequence
        // (e.g. a nested mapping). For an UNKNOWN key this is a lenient skip. For
        // a KNOWN field, silently dropping it would fail open (a malformed
        // allowed-tools would read as "no restriction"), so surface an error.
        if (KNOWN_KEYS.has(key)) {
          throw new Error(
            `SKILL frontmatter parse error in ${filePath} (line ${i + 1}): ` +
              `field "${key}" has an unsupported multi-line or nested value. ` +
              `Use a quoted string, an inline array ([a, b]), a "- item" block ` +
              `sequence, or a block scalar (| or >).`,
          );
        }
        i = j; // unknown key — skip leniently, no misleading ""
        continue;
      }
      data[key] = '';
      i++;
      continue;
    }

    data[key] = parseYamlValue(rest);
    i++;
  }

  return data;
}

/** Dedent a block-scalar body and fold (`>`) or keep (`|`) newlines. Returns a string. */
function foldBlockScalar(rawLines: string[], style: '|' | '>'): string {
  const body = [...rawLines];
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  if (body.length === 0) return '';

  const indents = body
    .filter((l) => l.trim() !== '')
    .map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
  const minIndent = indents.length > 0 ? Math.min(...indents) : 0;
  const dedented = body.map((l) => l.slice(minIndent));

  if (style === '|') return dedented.join('\n');

  let out = '';
  for (const l of dedented) {
    if (l.trim() === '') {
      out += '\n';
    } else {
      out += out === '' || out.endsWith('\n') ? l.trim() : ` ${l.trim()}`;
    }
  }
  return out;
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

/** Frontmatter keys chef understands natively (canonical + kebab aliases). */
const KNOWN_KEYS = new Set([
  'name',
  'description',
  'whenToUse',
  'when-to-use',
  'allowedTools',
  'allowed-tools',
]);

function buildSkill(
  data: Record<string, unknown>,
  body: string,
  filePath: string,
  baseDir?: string,
): Skill {
  const name = data.name;
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(
      `SKILL parse error in ${filePath}: missing required field "name". ` +
        `Add it to the frontmatter, e.g.:\n---\nname: my-skill\ndescription: ...\n---`,
    );
  }

  const description = data.description;
  if (typeof description !== 'string' || !description.trim()) {
    // Sanitize `name` for the example snippet: a literal `---` would close the
    // frontmatter prematurely and produce a malformed example, and very long
    // names dwarf the actionable hint.
    const safeName = name.length > 40 || name.includes('---') ? 'my-skill' : name;
    throw new Error(
      `SKILL parse error in ${filePath}: missing required field "description". ` +
        `Add it to the frontmatter, e.g.:\n---\nname: ${safeName}\ndescription: One-line summary of what this skill does.\n---`,
    );
  }

  const skill: Skill = {
    name: name.trim(),
    description: description.trim(),
    instructions: body.trim(),
  };

  const whenToUse = data.whenToUse ?? data['when-to-use'];
  if (whenToUse !== undefined) {
    if (typeof whenToUse !== 'string') {
      throw new Error(`SKILL parse error in ${filePath}: "whenToUse" must be a string.`);
    }
    skill.whenToUse = whenToUse.trim();
  }

  const allowedTools = data.allowedTools ?? data['allowed-tools'];
  if (allowedTools !== undefined) {
    if (!Array.isArray(allowedTools) || !allowedTools.every((v) => typeof v === 'string')) {
      throw new Error(
        `SKILL parse error in ${filePath}: "allowedTools" must be an array of strings.`,
      );
    }
    skill.allowedTools = allowedTools.map((s) => s.trim()).filter(Boolean);
  }

  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!KNOWN_KEYS.has(key)) metadata[key] = value;
  }
  if (Object.keys(metadata).length > 0) skill.metadata = metadata;

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
