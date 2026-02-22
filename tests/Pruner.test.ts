import { Pruner, type ToolDefinition, type ToolGroup } from '../src/modules/Pruner';

// ─── Mock Data ───

const MOCK_TOOLS: ToolDefinition[] = [
  { name: 'read_file', description: 'Reads a file from disk', tags: ['file', 'read', 'disk'] },
  { name: 'write_file', description: 'Writes content to a file', tags: ['file', 'write', 'disk'] },
  { name: 'run_bash', description: 'Executes a shell command', tags: ['shell', 'execute', 'bash'] },
  {
    name: 'search_web',
    description: 'Searches the web for information',
    tags: ['web', 'search', 'http'],
  },
  { name: 'get_current_time', description: 'Returns the current timestamp' },
];

const MOCK_NAMESPACES: ToolGroup[] = [
  {
    name: 'file_ops',
    description: 'File system operations',
    tools: [
      {
        name: 'read_file',
        description: 'Read a file',
        parameters: { path: { type: 'string', description: 'File path' } },
      },
      {
        name: 'write_file',
        description: 'Write to a file',
        parameters: { path: { type: 'string' }, content: { type: 'string' } },
      },
      {
        name: 'search_files',
        description: 'Search files by pattern',
        parameters: { query: { type: 'string' } },
      },
    ],
  },
  {
    name: 'terminal',
    description: 'Shell command execution',
    tools: [
      {
        name: 'run_bash',
        description: 'Execute a command',
        parameters: { command: { type: 'string' } },
      },
      {
        name: 'kill_process',
        description: 'Kill a process',
        parameters: { pid: { type: 'number' } },
      },
    ],
  },
];

const MOCK_TOOLKITS: ToolGroup[] = [
  {
    name: 'Weather',
    description: 'Weather forecast and climate data',
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather',
        parameters: { city: { type: 'string' } },
      },
      {
        name: 'get_forecast',
        description: 'Get 7-day forecast',
        parameters: { city: { type: 'string' } },
      },
    ],
  },
  {
    name: 'Database',
    description: 'SQL query and schema inspection',
    tools: [
      {
        name: 'run_sql',
        description: 'Execute SQL query',
        parameters: { query: { type: 'string' } },
      },
    ],
  },
];

// ─── Flat Mode (Legacy) ───

describe('Pruner — Flat Mode (Legacy)', () => {
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
      expect(result.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['read_file', 'run_bash']),
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
      expect(result.tools.map((t) => t.name)).toContain('read_file');
    });

    it('should keep tools whose name appears in the task description', () => {
      const result = pruner.pruneByTask('Please use run_bash to execute the command');
      expect(result.tools.map((t) => t.name)).toContain('run_bash');
    });

    it('should always keep tools with no tags (universal utilities)', () => {
      const result = pruner.pruneByTask('paint a picture');
      expect(result.tools.map((t) => t.name)).toContain('get_current_time');
    });

    it('should exclude irrelevant tools', () => {
      const result = pruner.pruneByTask('search the web for news');
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('search_web');
      expect(names).not.toContain('run_bash');
      expect(names).not.toContain('write_file');
    });
  });

  describe('pruneByTaskAndAllowlist', () => {
    it('should union: keep tools matching EITHER allowlist OR task (default)', () => {
      const result = pruner.pruneByTaskAndAllowlist('execute a bash script', ['read_file']);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('run_bash');
      expect(names).toContain('read_file');
      expect(names).toContain('get_current_time');
    });

    it('should intersection: keep tools matching BOTH allowlist AND task', () => {
      const prunerIntersect = new Pruner({ strategy: 'intersection' });
      prunerIntersect.registerTools(MOCK_TOOLS);
      const result = prunerIntersect.pruneByTaskAndAllowlist('read a file', ['read_file']);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('write_file');
      expect(names).not.toContain('run_bash');
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

// ─── Namespace Mode (Layer 1) ───

describe('Pruner — Namespace Mode (Layer 1)', () => {
  let pruner: Pruner;

  beforeEach(() => {
    pruner = new Pruner();
    pruner.registerNamespaces(MOCK_NAMESPACES);
  });

  describe('compile()', () => {
    it('should produce one tool per namespace group', () => {
      const { tools } = pruner.compile();
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('file_ops');
      expect(tools[1].name).toBe('terminal');
    });

    it('should include action enum with all sub-tool names', () => {
      const { tools } = pruner.compile();
      const fileOps = tools[0];
      const params = fileOps.parameters as {
        properties?: Record<string, { enum?: string[] }>;
      };
      expect(params.properties?.action?.enum).toEqual(['read_file', 'write_file', 'search_files']);
    });

    it('should include sub-tool documentation in the description', () => {
      const { tools } = pruner.compile();
      const fileOps = tools[0];
      expect(fileOps.description).toContain('read_file: Read a file');
      expect(fileOps.description).toContain('write_file: Write to a file');
      expect(fileOps.description).toContain('path (string)');
    });

    it('should have required action and args', () => {
      const { tools } = pruner.compile();
      const params = tools[0].parameters as { required?: string[] };
      expect(params.required).toEqual(['action', 'args']);
    });

    it('should produce empty directoryXml when no lazy toolkits', () => {
      const { directoryXml } = pruner.compile();
      expect(directoryXml).toBe('');
    });
  });

  describe('isNamespaceCall()', () => {
    it('should return true for registered namespace names', () => {
      expect(pruner.isNamespaceCall({ name: 'file_ops' })).toBe(true);
      expect(pruner.isNamespaceCall({ name: 'terminal' })).toBe(true);
    });

    it('should return false for unknown names', () => {
      expect(pruner.isNamespaceCall({ name: 'unknown_tool' })).toBe(false);
      expect(pruner.isNamespaceCall({ name: 'load_toolkit' })).toBe(false);
    });
  });

  describe('resolveNamespace()', () => {
    it('should resolve a valid namespace call with string arguments', () => {
      const resolved = pruner.resolveNamespace({
        name: 'file_ops',
        arguments: JSON.stringify({ action: 'read_file', args: { path: 'auth.ts' } }),
      });
      expect(resolved.group).toBe('file_ops');
      expect(resolved.toolName).toBe('read_file');
      expect(resolved.args).toEqual({ path: 'auth.ts' });
    });

    it('should resolve with object arguments', () => {
      const resolved = pruner.resolveNamespace({
        name: 'terminal',
        arguments: { action: 'run_bash', args: { command: 'ls -la' } },
      });
      expect(resolved.group).toBe('terminal');
      expect(resolved.toolName).toBe('run_bash');
      expect(resolved.args).toEqual({ command: 'ls -la' });
    });

    it('should default args to empty object if not provided', () => {
      const resolved = pruner.resolveNamespace({
        name: 'terminal',
        arguments: { action: 'kill_process' },
      });
      expect(resolved.args).toEqual({});
    });

    it('should throw for unknown namespace', () => {
      expect(() =>
        pruner.resolveNamespace({
          name: 'unknown',
          arguments: { action: 'foo' },
        }),
      ).toThrow('not a registered namespace');
    });

    it('should throw for unknown action within a namespace', () => {
      expect(() =>
        pruner.resolveNamespace({
          name: 'file_ops',
          arguments: { action: 'delete_file' },
        }),
      ).toThrow('Unknown action "delete_file"');
    });
  });
});

// ─── Lazy Loading Mode (Layer 2) ───

describe('Pruner — Lazy Loading (Layer 2)', () => {
  let pruner: Pruner;

  beforeEach(() => {
    pruner = new Pruner();
    pruner.registerToolkits(MOCK_TOOLKITS);
  });

  describe('compile()', () => {
    it('should include the load_toolkit virtual tool', () => {
      const { tools } = pruner.compile();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('load_toolkit');
    });

    it('should have toolkit_name enum listing all available toolkits', () => {
      const { tools } = pruner.compile();
      const params = tools[0].parameters as {
        properties?: Record<string, { enum?: string[] }>;
      };
      expect(params.properties?.toolkit_name?.enum).toEqual(['Weather', 'Database']);
    });

    it('should generate a directory XML with toolkit names and descriptions', () => {
      const { directoryXml } = pruner.compile();
      expect(directoryXml).toContain('<available_toolkits>');
      expect(directoryXml).toContain('name="Weather"');
      expect(directoryXml).toContain('Weather forecast and climate data');
      expect(directoryXml).toContain('name="Database"');
      expect(directoryXml).toContain('tools="get_weather, get_forecast"');
      expect(directoryXml).toContain('tools="run_sql"');
    });
  });

  describe('isToolkitLoader()', () => {
    it('should return true for load_toolkit', () => {
      expect(pruner.isToolkitLoader({ name: 'load_toolkit' })).toBe(true);
    });

    it('should return false for other tools', () => {
      expect(pruner.isToolkitLoader({ name: 'read_file' })).toBe(false);
    });
  });

  describe('extractToolkit()', () => {
    it('should return the full tool definitions for a valid toolkit', () => {
      const tools = pruner.extractToolkit('Weather');
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('get_weather');
      expect(tools[1].name).toBe('get_forecast');
    });

    it('should be case-insensitive', () => {
      const tools = pruner.extractToolkit('weather');
      expect(tools).toHaveLength(2);
    });

    it('should throw for unknown toolkit', () => {
      expect(() => pruner.extractToolkit('NonExistent')).toThrow('Unknown toolkit');
    });

    it('should return copies (not references) of tool definitions', () => {
      const tools1 = pruner.extractToolkit('Weather');
      const tools2 = pruner.extractToolkit('Weather');
      expect(tools1).not.toBe(tools2);
    });
  });

  describe('getDirectoryXml()', () => {
    it('should return the same XML as compile().directoryXml', () => {
      const { directoryXml } = pruner.compile();
      expect(pruner.getDirectoryXml()).toBe(directoryXml);
    });

    it('should return empty string if no toolkits registered', () => {
      const emptyPruner = new Pruner();
      expect(emptyPruner.getDirectoryXml()).toBe('');
    });
  });
});

// ─── Combined: Namespace + Lazy Loading ───

describe('Pruner — Combined Namespace + Lazy Loading', () => {
  let pruner: Pruner;

  beforeEach(() => {
    pruner = new Pruner();
    pruner.registerNamespaces(MOCK_NAMESPACES);
    pruner.registerToolkits(MOCK_TOOLKITS);
  });

  it('should compile namespace tools + load_toolkit in one array', () => {
    const { tools } = pruner.compile();
    // 2 namespaces + 1 load_toolkit = 3
    expect(tools).toHaveLength(3);
    expect(tools.map((t) => t.name)).toEqual(['file_ops', 'terminal', 'load_toolkit']);
  });

  it('should generate directoryXml for lazy toolkits only', () => {
    const { directoryXml } = pruner.compile();
    expect(directoryXml).toContain('Weather');
    expect(directoryXml).toContain('Database');
    // Namespaces should NOT appear in the lazy directory
    expect(directoryXml).not.toContain('file_ops');
    expect(directoryXml).not.toContain('terminal');
  });

  it('should correctly route namespace calls and toolkit loads', () => {
    const nsCall = { name: 'file_ops' };
    const loaderCall = { name: 'load_toolkit' };
    const unknownCall = { name: 'random_tool' };

    expect(pruner.isNamespaceCall(nsCall)).toBe(true);
    expect(pruner.isToolkitLoader(nsCall)).toBe(false);

    expect(pruner.isToolkitLoader(loaderCall)).toBe(true);
    expect(pruner.isNamespaceCall(loaderCall)).toBe(false);

    expect(pruner.isNamespaceCall(unknownCall)).toBe(false);
    expect(pruner.isToolkitLoader(unknownCall)).toBe(false);
  });

  it('should support the full two-layer workflow', () => {
    // Step 1: Compile tools for LLM
    const { tools, directoryXml } = pruner.compile();
    expect(tools.length).toBe(3);
    expect(directoryXml).toContain('<available_toolkits>');

    // Step 2: LLM calls a namespace tool
    const nsResult = pruner.resolveNamespace({
      name: 'file_ops',
      arguments: { action: 'read_file', args: { path: 'src/index.ts' } },
    });
    expect(nsResult.toolName).toBe('read_file');
    expect(nsResult.args.path).toBe('src/index.ts');

    // Step 3: LLM calls load_toolkit
    const weatherTools = pruner.extractToolkit('Weather');
    expect(weatherTools).toHaveLength(2);
    expect(weatherTools[0].name).toBe('get_weather');

    // Step 4: After loading, the new tools would be merged by the agent loop
    const expandedTools = [...tools, ...weatherTools];
    expect(expandedTools).toHaveLength(5);
  });
});
