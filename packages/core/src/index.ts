/**
 * @context-chef/core public barrel. The ContextChef facade lives in ./chef;
 * modules, adapters, and utilities re-export from their homes below.
 */

export {
  AdapterRegistry,
  adapterRegistry,
  getAdapter,
  type ITargetAdapter,
} from './adapters/adapterFactory';
export {
  AnthropicAdapter,
  type AnthropicAdapterOptions,
  type AnthropicServerContextManagement,
  anthropicServerContextManagement,
  fromAnthropic,
} from './adapters/anthropicAdapter';
export {
  auditAnthropicCachePlacement,
  type CacheAuditIssue,
} from './adapters/anthropicCacheAudit';
export { fromGemini, GeminiAdapter, type GeminiAdapterOptions } from './adapters/geminiAdapter';
export { fromOpenAI, OpenAIAdapter, type OpenAIAdapterOptions } from './adapters/openAIAdapter';
export {
  fromOpenAIResponses,
  OpenAIResponsesAdapter,
  type OpenAIResponsesPayload,
} from './adapters/openAIResponsesAdapter';
export {
  type Announcement,
  type AnnouncementChannel,
  type BeforeCompileContext,
  type ChefConfig,
  type ChefEvents,
  type ChefSnapshot,
  ContextChef,
  type SkillPlacement,
  type ToolCallCheckResult,
} from './chef';
export {
  createJanitorPool,
  type IntegrationCompressOptions,
  type JanitorPoolConfig,
} from './integrations/janitorPool';
export { Assembler } from './modules/assembler';
export { Guardrail } from './modules/guardrail';
export {
  type CompressionArchiveConfig,
  type CompressionDetails,
  compactMessages,
  flattenForCompression,
  groupIntoTurns,
  Janitor,
  type JanitorConfig,
  type JanitorConfigWithoutTokenizer,
  type JanitorConfigWithTokenizer,
  type JanitorSnapshot,
  type SummarizeHistoryOptions,
  summarizeHistory,
  type Turn,
  type UsagePreferenceWithoutTokenizer,
  type UsagePreferenceWithTokenizer,
} from './modules/janitor';
export {
  type CompactionPlan,
  compactHistory,
  type PlanCompactionOptions,
  planCompaction,
} from './modules/janitor/durableCompaction';
export {
  Memory,
  type MemoryChangeEvent,
  type MemoryConfig,
  type MemoryEntry,
  type MemoryPlacement,
  type MemorySetOptions,
  type MemorySnapshot,
  type TTLValue,
} from './modules/memory';
export { InMemoryStore } from './modules/memory/inMemoryStore';
export type { MemoryStore, MemoryStoreEntry } from './modules/memory/memoryStore';
export { VFSMemoryStore } from './modules/memory/vfsMemoryStore';
export {
  type CleanupOptions,
  FileSystemAdapter,
  Offloader,
  type OffloadOptions,
  VFSCleanupNotSupportedError,
  type VFSCleanupResult,
  type VFSConfig,
  type VFSEntryMeta,
  type VFSEvictionReason,
  type VFSResult,
  type VFSStorageAdapter,
} from './modules/offloader';
export {
  getRecallToolDefinition,
  type RecallFormat,
  type ResolveRecallOptions,
  renderRecalledContent,
} from './modules/offloader/recallTool';
export {
  Pruner,
  type PrunerConfig,
  type PrunerResult,
  type PrunerSnapshot,
} from './modules/pruner';
export {
  type FormatSkillListingOptions,
  formatSkillListing,
  type LoadSkillsDirsOptions,
  loadSkill,
  loadSkillsDir,
  loadSkillsDirs,
  type RenderSkillOptions,
  renderSkill,
  type Skill,
  type SkillLoadResult,
} from './modules/skill';
export * from './prompts';
export * from './types';
export { ensureValidHistory } from './utils/ensureValidHistory';
export { type EventHandler, TypedEventEmitter } from './utils/eventEmitter';
export {
  DEFAULT_SESSION_KEY,
  dedupeConstructionWarnings,
  normalizeSessionKey,
  SessionPool,
} from './utils/sessionPool';
export { createTokenizerAdapter } from './utils/tokenizerAdapter';
export { estimate, estimateObject } from './utils/tokenUtils';
export { objectToXml } from './utils/xmlGenerator';
