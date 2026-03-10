/**
 * Tool Pruning — Flat Mode & Namespace + Lazy Loading
 *
 * Demonstrates:
 * - Flat mode: register tools with tags, prune by task
 * - Two-layer architecture: stable namespaces + on-demand toolkits
 *
 * Usage:
 *   npx tsx examples/tool-pruning.ts
 */

import { ContextChef } from 'context-chef';

// ============================================
// Example 1: Flat Mode (tag-based pruning)
// ============================================

function flatModeExample() {
  console.log('=== Flat Mode: Tag-Based Pruning ===\n');

  const chef = new ContextChef();

  chef.registerTools([
    { name: 'read_file', description: 'Read a file from disk', tags: ['file', 'read'] },
    { name: 'write_file', description: 'Write content to a file', tags: ['file', 'write'] },
    { name: 'run_bash', description: 'Execute a shell command', tags: ['shell', 'exec'] },
    { name: 'search_web', description: 'Search the web', tags: ['web', 'search'] },
    { name: 'get_time', description: 'Get current timestamp' /* no tags = always kept */ },
  ]);

  // Prune for a file-reading task
  const result = chef.tools().pruneByTask('Read the auth.ts file and check for bugs');
  console.log(
    'Task: "Read the auth.ts file"',
    '\nKept:',
    result.tools.map((t) => t.name),
    '\nRemoved:',
    result.removed.map((t) => t.name),
    '\n',
  );
}

// ============================================
// Example 2: Namespace + Lazy Loading
// ============================================

function namespaceModeExample() {
  console.log('=== Namespace + Lazy Loading ===\n');

  const chef = new ContextChef();

  // Layer 1: Stable namespace tools (always present)
  chef.registerNamespaces([
    {
      name: 'file_ops',
      description: 'File system operations',
      tools: [
        {
          name: 'read_file',
          description: 'Read a file',
          parameters: { path: { type: 'string' } },
        },
        {
          name: 'write_file',
          description: 'Write to a file',
          parameters: { path: { type: 'string' }, content: { type: 'string' } },
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
      ],
    },
  ]);

  // Layer 2: On-demand toolkits
  chef.registerToolkits([
    {
      name: 'Weather',
      description: 'Weather forecast APIs',
      tools: [
        { name: 'get_forecast', description: 'Get weather forecast for a city' },
        { name: 'get_alerts', description: 'Get weather alerts for a region' },
      ],
    },
    {
      name: 'Database',
      description: 'SQL query and schema inspection',
      tools: [
        { name: 'run_query', description: 'Execute a SQL query' },
        { name: 'list_tables', description: 'List all tables in the database' },
      ],
    },
  ]);

  const { tools, directoryXml } = chef.tools().compile();

  console.log(
    'Compiled tools (always stable):',
    tools.map((t) => t.name),
  );
  console.log('\nToolkit directory XML (injected into system prompt):');
  console.log(directoryXml);
}

// Run both examples
flatModeExample();
namespaceModeExample();
