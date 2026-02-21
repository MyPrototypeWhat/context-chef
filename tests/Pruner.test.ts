import { Pruner, ToolDefinition } from '../src/modules/Pruner';

const MOCK_TOOLS: ToolDefinition[] = [
  {
    name: 'read_file',
    description: 'Reads a file from disk',
    tags: ['file', 'read', 'disk'],
  },
  {
    name: 'write_file',
    description: 'Writes content to a file',
    tags: ['file', 'write', 'disk'],
  },
  {
    name: 'run_bash',
    description: 'Executes a shell command',
    tags: ['shell', 'execute', 'bash'],
  },
  {
    name: 'search_web',
    description: 'Searches the web for information',
    tags: ['web', 'search', 'http'],
  },
  {
    name: 'get_current_time',
    description: 'Returns the current timestamp',
    // No tags — treated as a universal utility
  },
];

describe('Pruner', () => {
  let pruner: Pruner;

  beforeEach(() => {
    pruner = new Pruner();
    pruner.registerTools(MOCK_TOOLS);
  });

  describe('registerTools', () => {
    it('should return all registered tools via getAllTools()', () => {
      expect(pruner.getAllTools()).toHaveLength(MOCK_TOOLS.length);
    });

    it('should support chaining', () => {
      const p = new Pruner();
      expect(p.registerTools(MOCK_TOOLS)).toBe(p);
    });
  });

  describe('allowOnly', () => {
    it('should return only the requested tools', () => {
      const result = pruner.allowOnly(['read_file', 'run_bash']);
      expect(result.tools).toHaveLength(2);
      expect(result.tools.map(t => t.name)).toEqual(
        expect.arrayContaining(['read_file', 'run_bash'])
      );
    });

    it('should report the correct removed list', () => {
      const result = pruner.allowOnly(['read_file']);
      expect(result.removed).toHaveLength(4);
      expect(result.removed).not.toContain('read_file');
    });

    it('should be case-insensitive', () => {
      const result = pruner.allowOnly(['READ_FILE', 'SEARCH_WEB']);
      expect(result.kept).toBe(2);
    });

    it('should return empty if no matches', () => {
      const result = pruner.allowOnly(['non_existent_tool']);
      expect(result.tools).toHaveLength(0);
      expect(result.removed).toHaveLength(MOCK_TOOLS.length);
    });
  });

  describe('pruneByTask', () => {
    it('should keep tools whose tags match the task description', () => {
      const result = pruner.pruneByTask('I need to read a file from disk');
      const names = result.tools.map(t => t.name);
      expect(names).toContain('read_file');
    });

    it('should keep tools whose name appears in the task description', () => {
      const result = pruner.pruneByTask('Please use run_bash to execute the command');
      const names = result.tools.map(t => t.name);
      expect(names).toContain('run_bash');
    });

    it('should always keep tools with no tags (universal utilities)', () => {
      // "paint a picture" matches nothing, but get_current_time has no tags
      const result = pruner.pruneByTask('paint a picture');
      const names = result.tools.map(t => t.name);
      expect(names).toContain('get_current_time');
    });

    it('should exclude irrelevant tools', () => {
      const result = pruner.pruneByTask('search the web for news');
      const names = result.tools.map(t => t.name);
      expect(names).toContain('search_web');
      expect(names).not.toContain('run_bash');
      expect(names).not.toContain('write_file');
    });
  });

  describe('pruneByTaskAndAllowlist', () => {
    it('should union: keep tools matching EITHER allowlist OR task (default)', () => {
      // run_bash matches task via 'bash' tag; read_file is in allowlist but not in task description
      const result = pruner.pruneByTaskAndAllowlist('execute a bash script', ['read_file']);
      const names = result.tools.map(t => t.name);
      expect(names).toContain('run_bash');    // task match
      expect(names).toContain('read_file');   // allowlist match
      expect(names).toContain('get_current_time'); // no tags → always kept
    });

    it('should intersection: keep tools matching BOTH allowlist AND task', () => {
      const prunerIntersect = new Pruner({ strategy: 'intersection' });
      prunerIntersect.registerTools(MOCK_TOOLS);

      // read_file is in allowlist; task mentions 'file' (matches read_file AND write_file)
      // Only read_file satisfies both
      const result = prunerIntersect.pruneByTaskAndAllowlist('read a file', ['read_file']);
      const names = result.tools.map(t => t.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('run_bash');
      // get_current_time has no tags → always kept by task filter, but NOT in allowlist
      expect(names).not.toContain('get_current_time');
    });
  });

  describe('PrunerResult metadata', () => {
    it('should report accurate kept, removed, and total counts', () => {
      const result = pruner.allowOnly(['read_file', 'write_file']);
      expect(result.total).toBe(MOCK_TOOLS.length);
      expect(result.kept).toBe(2);
      expect(result.removed).toHaveLength(3);
    });
  });
});
