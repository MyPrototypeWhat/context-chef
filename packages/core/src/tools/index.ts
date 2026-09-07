/**
 * The retrieval axis: one model-facing tool (`context`), one access policy and
 * one dispatcher for every tool the library owns.
 *
 * `ChefConfig.tools: 'unified'` emits the tool and `chef.handleTool` dispatches
 * it. A host that holds a `Memory` / `Offloader` without a `ContextChef` can
 * call {@link dispatchContextTool} directly.
 */

export {
  CONTEXT_COMMANDS,
  type ContextCommand,
  getContextToolDefinition,
} from './contextTool';
export {
  CONTEXT_TOOL_NAMES,
  type ContextToolCall,
  type ContextToolHost,
  type ContextToolName,
  dispatchContextTool,
  isContextToolName,
} from './dispatch';
export {
  type ContextToolPolicy,
  type ContextToolPolicyConfig,
  canWrite,
  DEFAULT_WRITABLE_NAMESPACES,
  NOTES_NAMESPACE,
  resolveContextToolPolicy,
} from './policy';
