import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as chef from '../../index';
import { formatSkillListing, loadSkill, loadSkillsDir, loadSkillsDirs, type Skill } from '.';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '__fixtures__');

describe('loadSkill', () => {
  it('parses a SKILL.md with all optional fields', async () => {
    const skill = await loadSkill(join(FIXTURES, 'valid-full', 'SKILL.md'));

    expect(skill.name).toBe('db-debug');
    expect(skill.description).toBe('Diagnose database query and connection issues');
    expect(skill.whenToUse).toBe(
      'When the user reports slow SQL, connection errors, or ORM exceptions',
    );
    expect(skill.allowedTools).toEqual(['query_db', 'tail_logs', 'read_file', 'grep']);
    expect(skill.instructions).toContain('Diagnostic steps:');
    expect(skill.instructions).toContain('References:');
    // Body should be trimmed (no leading/trailing whitespace).
    expect(skill.instructions.startsWith('Diagnostic')).toBe(true);
    expect(skill.instructions.endsWith('common-issues.md')).toBe(true);
  });

  it('parses a minimal SKILL.md with only required fields', async () => {
    const skill = await loadSkill(join(FIXTURES, 'valid-minimal', 'SKILL.md'));

    expect(skill.name).toBe('planning');
    expect(skill.description).toBe('Plan changes before editing');
    expect(skill.whenToUse).toBeUndefined();
    expect(skill.allowedTools).toBeUndefined();
    expect(skill.instructions).toBe('Read code, list affected files, write plan to scratchpad.');
  });

  it('sets baseDir to the directory containing the SKILL.md file', async () => {
    const filePath = join(FIXTURES, 'valid-full', 'SKILL.md');
    const skill = await loadSkill(filePath);
    expect(skill.baseDir).toBe(dirname(filePath));
  });

  it('throws when the file does not exist', async () => {
    await expect(loadSkill(join(FIXTURES, 'does-not-exist', 'SKILL.md'))).rejects.toThrow();
  });

  it('throws when the frontmatter is unterminated', async () => {
    await expect(loadSkill(join(FIXTURES, 'invalid-frontmatter', 'SKILL.md'))).rejects.toThrow(
      /unterminated frontmatter/,
    );
  });

  it('throws when required fields are missing', async () => {
    const tmp = join(FIXTURES, '__tmp_missing_name__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(filePath, '---\ndescription: only desc\n---\nbody');
    try {
      // Locks both the original problem-statement phrase AND the actionable
      // example snippet added in the error-message audit.
      await expect(loadSkill(filePath)).rejects.toThrow(/missing required field "name"/);
      await expect(loadSkill(filePath)).rejects.toThrow(/Add it to the frontmatter/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('embeds the parsed name into the missing-description example snippet', async () => {
    const tmp = join(FIXTURES, '__tmp_missing_desc__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(filePath, '---\nname: my-cool-skill\n---\nbody');
    try {
      await expect(loadSkill(filePath)).rejects.toThrow(/missing required field "description"/);
      // The example snippet should reuse the user's own name so the suggested
      // fix slots cleanly into their existing file.
      await expect(loadSkill(filePath)).rejects.toThrow(/name: my-cool-skill/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to "my-skill" in the missing-description snippet when name would produce a malformed example', async () => {
    // A name of `---` would close the frontmatter mid-example; a 100-char
    // name would dwarf the actionable info. Verify the sanitizer kicks in.
    const tmp = join(FIXTURES, '__tmp_missing_desc_unsafe__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(filePath, '---\nname: ---\n---\nbody');
    try {
      await expect(loadSkill(filePath)).rejects.toThrow(/name: my-skill/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when allowedTools is not an array of strings', async () => {
    const tmp = join(FIXTURES, '__tmp_bad_allowed_tools__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: bad\ndescription: bad\nallowedTools: not-an-array\n---\nbody',
    );
    try {
      await expect(loadSkill(filePath)).rejects.toThrow(/"allowedTools" must be an array/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('handles CRLF line endings', async () => {
    const tmp = join(FIXTURES, '__tmp_crlf__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\r\nname: crlf-skill\r\ndescription: handles windows line endings\r\n---\r\nbody line\r\n',
    );
    try {
      const skill = await loadSkill(filePath);
      expect(skill.name).toBe('crlf-skill');
      expect(skill.description).toBe('handles windows line endings');
      expect(skill.instructions).toBe('body line');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('strips quotes from quoted scalar values', async () => {
    const tmp = join(FIXTURES, '__tmp_quoted__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: "quoted-name"\ndescription: \'a single-quoted desc\'\n---\nbody',
    );
    try {
      const skill = await loadSkill(filePath);
      expect(skill.name).toBe('quoted-name');
      expect(skill.description).toBe('a single-quoted desc');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('parses an externally-authored SKILL.md with folded description, kebab aliases, and extra fields', async () => {
    const skill = await loadSkill(join(FIXTURES, 'external-frontmatter', 'SKILL.md'));

    expect(skill.name).toBe('pdf');
    expect(skill.description).toContain('Folded multi-line description');
    expect(skill.description).not.toContain('\n');
    expect(skill.whenToUse).toBe('When the user wants to read or edit a PDF.');
    expect(skill.allowedTools).toEqual(['Read', 'Bash']);
    expect(skill.metadata).toEqual({ 'argument-hint': '[file]', version: '2.1.0' });
    expect(skill.instructions.startsWith('Use pdfplumber')).toBe(true);
  });

  it('leaves metadata undefined when there are no extra keys', async () => {
    const skill = await loadSkill(join(FIXTURES, 'valid-minimal', 'SKILL.md'));
    expect(skill.metadata).toBeUndefined();
  });

  it('parses a block-sequence allowed-tools into an array', async () => {
    const tmp = join(FIXTURES, '__tmp_block_seq__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: bseq\ndescription: block seq\nallowed-tools:\n  - Read\n  - Bash\n---\nbody',
    );
    try {
      const skill = await loadSkill(filePath);
      expect(skill.allowedTools).toEqual(['Read', 'Bash']);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('preserves newlines in a literal block scalar', async () => {
    const tmp = join(FIXTURES, '__tmp_literal__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(filePath, '---\nname: lit\ndescription: |\n  line one\n  line two\n---\nbody');
    try {
      const skill = await loadSkill(filePath);
      expect(skill.description).toBe('line one\nline two');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('skips an unsupported nested mapping rather than recording an empty value', async () => {
    const tmp = join(FIXTURES, '__tmp_nested__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: nest\ndescription: nested\nextra:\n  child: x\n---\nbody',
    );
    try {
      const skill = await loadSkill(filePath);
      expect(skill.metadata).toBeUndefined();
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when a known field has an unsupported nested-mapping shape', async () => {
    const tmp = join(FIXTURES, '__tmp_known_nested__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: k\ndescription: d\nallowed-tools:\n  Read: yes\n---\nbody',
    );
    try {
      await expect(loadSkill(filePath)).rejects.toThrow(/unsupported multi-line or nested value/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('throws when a known field is a block sequence with a malformed item', async () => {
    const tmp = join(FIXTURES, '__tmp_known_badseq__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: k\ndescription: d\nallowed-tools:\n  - Read\n  -Bad\n---\nbody',
    );
    try {
      await expect(loadSkill(filePath)).rejects.toThrow(/unsupported multi-line or nested value/);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('keeps paragraph breaks in a folded block scalar', async () => {
    const tmp = join(FIXTURES, '__tmp_folded_para__');
    await mkdir(tmp, { recursive: true });
    const filePath = join(tmp, 'SKILL.md');
    await writeFile(
      filePath,
      '---\nname: fp\ndescription: >\n  para one a\n  para one b\n\n  para two\n---\nbody',
    );
    try {
      const skill = await loadSkill(filePath);
      expect(skill.description).toBe('para one a para one b\npara two');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('loadSkillsDir', () => {
  // Build a fresh sandbox directory each time so we control the contents
  // (and don't pollute __fixtures__ which is the test corpus for other cases).
  const sandbox = resolve(__dirname, '__fixtures__', '__tmp_dir__');

  beforeAll(async () => {
    await mkdir(sandbox, { recursive: true });
    // Copy three fixtures into the sandbox
    await mkdir(join(sandbox, 'valid-full'), { recursive: true });
    await writeFile(
      join(sandbox, 'valid-full', 'SKILL.md'),
      '---\nname: db-debug\ndescription: Diagnose database query and connection issues\nwhenToUse: When the user reports slow SQL, connection errors, or ORM exceptions\nallowedTools: [query_db, tail_logs, read_file, grep]\n---\n\nbody.\n',
    );
    await mkdir(join(sandbox, 'valid-minimal'), { recursive: true });
    await writeFile(
      join(sandbox, 'valid-minimal', 'SKILL.md'),
      '---\nname: planning\ndescription: Plan changes before editing\n---\n\nminimal body.\n',
    );
    await mkdir(join(sandbox, 'valid2'), { recursive: true });
    await writeFile(
      join(sandbox, 'valid2', 'SKILL.md'),
      '---\nname: editing\ndescription: Apply planned changes\nwhenToUse: When the plan exists\nallowedTools: [edit_file, run_tests]\n---\n\neditor body.\n',
    );
    // Sub-directory whose SKILL.md is two levels deep (must NOT be loaded)
    await mkdir(join(sandbox, 'nested-not-loaded', 'inner'), { recursive: true });
    await writeFile(
      join(sandbox, 'nested-not-loaded', 'inner', 'SKILL.md'),
      '---\nname: nested-should-not-load\ndescription: nested\n---\nbody\n',
    );
    // Sub-directory with no SKILL.md (silently skipped)
    await mkdir(join(sandbox, 'no-skill-md'), { recursive: true });
    await writeFile(join(sandbox, 'no-skill-md', 'README.md'), '# not a skill');
  });

  afterAll(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it('loads multiple top-level skills successfully', async () => {
    const result = await loadSkillsDir(sandbox);

    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(['db-debug', 'editing', 'planning']);
    expect(result.errors).toEqual([]);
  });

  it('does NOT recurse into nested sub-directories', async () => {
    const result = await loadSkillsDir(sandbox);
    const names = result.skills.map((s) => s.name);
    expect(names).not.toContain('nested-should-not-load');
  });

  it('is tolerant — collects errors instead of throwing on bad skill', async () => {
    // Add a broken skill into the sandbox without disturbing the existing fixtures.
    const broken = join(sandbox, 'broken-one');
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, 'SKILL.md'),
      '---\nname: still-going\nthis frontmatter never closes\n',
    );

    try {
      const result = await loadSkillsDir(sandbox);
      // Successful skills still come through.
      expect(result.skills.map((s) => s.name).sort()).toEqual(['db-debug', 'editing', 'planning']);
      // The bad one is captured in errors.
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe(join(broken, 'SKILL.md'));
      expect(result.errors[0].message).toMatch(/SKILL parse error|unterminated frontmatter/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('returns an error entry when the root directory does not exist', async () => {
    const result = await loadSkillsDir(join(sandbox, '__definitely_missing__'));
    expect(result.skills).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/Failed to read skills directory/);
  });
});

describe('formatSkillListing', () => {
  const skills: Skill[] = [
    {
      name: 'db-debug',
      description: 'Diagnose database query and connection issues',
      whenToUse: 'When the user reports slow SQL, connection errors, or ORM exceptions',
      instructions: '...',
    },
    {
      name: 'frontend-refactor',
      description: 'Reshape React components without changing behavior',
      instructions: '...',
    },
  ];

  it('renders plain format with whenToUse by default', () => {
    const out = formatSkillListing(skills);
    expect(out).toContain('- db-debug: Diagnose database query and connection issues');
    expect(out).toContain('(when: When the user reports slow SQL');
    expect(out).toContain(
      '- frontend-refactor: Reshape React components without changing behavior',
    );
    // No whenToUse on second skill — no parenthetical
    const lines = out.split('\n');
    expect(lines[1]).not.toContain('(when:');
  });

  it('renders xml format with attributes and child elements', () => {
    const out = formatSkillListing(skills, { format: 'xml' });
    expect(out.startsWith('<skills>')).toBe(true);
    expect(out.endsWith('</skills>')).toBe(true);
    expect(out).toContain('<skill name="db-debug">');
    expect(out).toContain(
      '<description>Diagnose database query and connection issues</description>',
    );
    expect(out).toContain('<whenToUse>When the user reports slow SQL');
  });

  it('omits whenToUse when includeWhenToUse=false in plain format', () => {
    const out = formatSkillListing(skills, { includeWhenToUse: false });
    expect(out).not.toContain('(when:');
  });

  it('omits whenToUse when includeWhenToUse=false in xml format', () => {
    const out = formatSkillListing(skills, { format: 'xml', includeWhenToUse: false });
    expect(out).not.toContain('<whenToUse>');
  });

  it('truncates output to maxChars with an ellipsis', () => {
    const out = formatSkillListing(skills, { maxChars: 30 });
    expect(out.length).toBe(30);
    expect(out.endsWith('...')).toBe(true);
  });

  it('returns the full output when maxChars exceeds the listing length', () => {
    const out = formatSkillListing(skills);
    const padded = formatSkillListing(skills, { maxChars: out.length + 100 });
    expect(padded).toBe(out);
  });

  it('escapes XML special characters', () => {
    const tricky: Skill[] = [
      {
        name: 'with-amp & lt',
        description: 'reads <input> & "json"',
        instructions: '',
      },
    ];
    const out = formatSkillListing(tricky, { format: 'xml' });
    expect(out).toContain('with-amp &amp; lt');
    expect(out).toContain('reads &lt;input&gt; &amp; &quot;json&quot;');
  });

  it('handles an empty skills array gracefully', () => {
    expect(formatSkillListing([])).toBe('');
    expect(formatSkillListing([], { format: 'xml' })).toBe('<skills></skills>');
  });
});

describe('loadSkillsDirs', () => {
  const ROOT = resolve(__dirname, '__fixtures__', '__tmp_dirs__');
  const A = join(ROOT, 'a');
  const B = join(ROOT, 'b');

  const writeSkill = async (dir: string, name: string, desc: string) => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(
      join(dir, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${desc}\n---\nbody`,
    );
  };

  beforeAll(async () => {
    await writeSkill(A, 'alpha', 'from A');
    await writeSkill(A, 'shared', 'A version');
    await writeSkill(B, 'beta', 'from B');
    await writeSkill(B, 'shared', 'B version');
  });
  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('merges skills from multiple dirs with last-wins precedence by default', async () => {
    const { skills, errors } = await loadSkillsDirs([A, B]);
    expect(errors).toEqual([]);
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
    expect(byName.alpha).toBe('from A');
    expect(byName.beta).toBe('from B');
    expect(byName.shared).toBe('B version'); // last wins
  });

  it('honors first-wins precedence', async () => {
    const { skills } = await loadSkillsDirs([A, B], { precedence: 'first-wins' });
    const shared = skills.find((s) => s.name === 'shared');
    expect(shared?.description).toBe('A version');
  });

  it('namespaces skill names per source when a namespace fn is given', async () => {
    const { skills } = await loadSkillsDirs([A, B], {
      namespace: (dir) => (dir === A ? 'a' : 'b'),
    });
    const names = skills.map((s) => s.name).sort();
    expect(names).toContain('a:alpha');
    expect(names).toContain('b:shared');
    expect(names).toContain('a:shared'); // namespacing prevents the collision
  });

  it('dedups the same dir passed twice (realpath)', async () => {
    const { skills } = await loadSkillsDirs([A, A]);
    expect(skills.filter((s) => s.name === 'alpha')).toHaveLength(1);
  });

  it('aggregates errors from a bad dir while still returning good skills', async () => {
    const { skills, errors } = await loadSkillsDirs([A, join(ROOT, 'does-not-exist')]);
    expect(skills.map((s) => s.name).sort()).toEqual(['alpha', 'shared']);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/Failed to read skills directory/);
  });

  // Every fixture description above is under 20 chars, so each loaded skill
  // carries a rule-1 warning — which makes precedence filtering observable.
  it('reports warnings only for skills that survive precedence (last-wins)', async () => {
    const { warnings } = await loadSkillsDirs([A, B]);
    const warnedPaths = warnings.map((w) => w.path);
    expect(warnedPaths).toContain(join(B, 'shared', 'SKILL.md'));
    // The shadowed A copy of `shared` is not in `skills`; its warnings would
    // point at content the caller cannot act on from this result.
    expect(warnedPaths).not.toContain(join(A, 'shared', 'SKILL.md'));
    expect(warnedPaths).toContain(join(A, 'alpha', 'SKILL.md'));
  });

  it('reports warnings only for skills that survive precedence (first-wins)', async () => {
    const { warnings } = await loadSkillsDirs([A, B], { precedence: 'first-wins' });
    const warnedPaths = warnings.map((w) => w.path);
    expect(warnedPaths).toContain(join(A, 'shared', 'SKILL.md'));
    expect(warnedPaths).not.toContain(join(B, 'shared', 'SKILL.md'));
  });

  it('SkillLoadResult literals without warnings keep compiling (pre-4.1 compat)', () => {
    // Type-level regression: `warnings` is optional in SkillLoadResult so 4.0
    // code constructing result literals stays source-compatible, while the
    // loaders return Required<SkillLoadResult> and always populate it.
    const legacy: import('.').SkillLoadResult = { skills: [], errors: [] };
    expect(legacy.warnings).toBeUndefined();
  });
});

describe('public exports', () => {
  it('exposes the new skill API from the package root', () => {
    expect(typeof chef.renderSkill).toBe('function');
    expect(typeof chef.loadSkillsDirs).toBe('function');
  });
});

describe('skill validation warnings', () => {
  const ROOT = resolve(__dirname, '__fixtures__', '__tmp_warnings__');
  let seq = 0;

  // Each case gets its own scan dir containing one skill folder, plus optional
  // extra files (link targets) inside that skill folder.
  const makeCase = async (skillMd: string, extraFiles: Record<string, string> = {}) => {
    const scanDir = join(ROOT, `case-${seq++}`);
    const skillDir = join(scanDir, 'the-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), skillMd);
    for (const [rel, content] of Object.entries(extraFiles)) {
      const target = join(skillDir, rel);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    return { scanDir, skillFile: join(skillDir, 'SKILL.md') };
  };

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
  });

  it('reports zero warnings for a well-formed skill (links resolving included)', async () => {
    const { scanDir } = await makeCase(
      '---\nname: clean\ndescription: A description comfortably long enough for routing\nallowedTools: [Read, Bash]\n---\nSee [notes](references/notes.md) and [schema](./docs/schema.md).',
      { 'references/notes.md': 'n', 'docs/schema.md': 's' },
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.skills).toHaveLength(1);
  });

  it('warns when the description is too short for routing', async () => {
    const { scanDir, skillFile } = await makeCase(
      '---\nname: thin\ndescription: tiny desc\n---\nA perfectly reasonable body.',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].path).toBe(skillFile);
    expect(result.warnings[0].message).toMatch(/too thin for routing/);
  });

  it('warning does not prevent the skill from loading', async () => {
    const { scanDir } = await makeCase(
      '---\nname: thin-but-loads\ndescription: tiny desc\n---\nBody.',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.errors).toEqual([]);
    expect(result.skills.map((s) => s.name)).toEqual(['thin-but-loads']);
    expect(result.warnings).toHaveLength(1);
  });

  it('warns when instructions exceed ~4000 estimated tokens', async () => {
    // 20000 ASCII chars -> ~6000 estimated tokens
    const { scanDir } = await makeCase(
      `---\nname: huge\ndescription: A description comfortably long enough for routing\n---\n${'x'.repeat(20000)}`,
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/progressive disclosure/);
  });

  it('warns when allowedTools contains empty strings', async () => {
    const { scanDir } = await makeCase(
      '---\nname: gaps\ndescription: A description comfortably long enough for routing\nallowedTools: [Read, "", Bash]\n---\nBody.',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/empty/);
    // buildSkill still strips the empty entry from the loaded skill
    expect(result.skills[0].allowedTools).toEqual(['Read', 'Bash']);
  });

  it('warns when allowedTools contains duplicates', async () => {
    const { scanDir } = await makeCase(
      '---\nname: dupes\ndescription: A description comfortably long enough for routing\nallowedTools: [Read, Read]\n---\nBody.',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toMatch(/duplicate/);
  });

  it('warns on a ./ relative link whose target does not exist', async () => {
    const { scanDir } = await makeCase(
      '---\nname: rot1\ndescription: A description comfortably long enough for routing\n---\nSee [schema](./docs/missing.md).',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('./docs/missing.md');
  });

  it('warns on a references/ link whose target does not exist', async () => {
    const { scanDir } = await makeCase(
      '---\nname: rot2\ndescription: A description comfortably long enough for routing\n---\nSee [notes](references/nope.md).',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].message).toContain('references/nope.md');
  });

  it('ignores absolute and external links (conservative matcher)', async () => {
    const { scanDir } = await makeCase(
      '---\nname: external\ndescription: A description comfortably long enough for routing\n---\nSee [site](https://example.com/doc.md) and [abs](/etc/hosts) and [other](docs/x.md).',
    );
    const result = await loadSkillsDir(scanDir);
    expect(result.warnings).toEqual([]);
  });

  it('initializes warnings even when the scan dir cannot be read', async () => {
    const result = await loadSkillsDir(join(ROOT, '__definitely_missing__'));
    expect(result.warnings).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it('loadSkillsDirs aggregates warnings across dirs', async () => {
    const a = await makeCase('---\nname: warn-a\ndescription: tiny desc\n---\nBody.');
    const b = await makeCase('---\nname: warn-b\ndescription: tiny desc\n---\nBody.');
    const { skills, warnings } = await loadSkillsDirs([a.scanDir, b.scanDir]);
    expect(skills.map((s) => s.name).sort()).toEqual(['warn-a', 'warn-b']);
    expect(warnings).toHaveLength(2);
    expect(warnings.map((w) => w.path).sort()).toEqual([a.skillFile, b.skillFile].sort());
  });
});
