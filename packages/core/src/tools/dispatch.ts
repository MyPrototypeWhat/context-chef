/**
 * One dispatcher for every library-owned tool.
 *
 * The model never sees an exception for its own mistakes: an unknown path, a
 * missing argument, a write to a read-only namespace and a veto from the host
 * all come back as `Error: …` text it can read and correct. Exceptions are
 * reserved for programmer errors — a tool name that was never ours.
 */

import type { Memory } from '../modules/memory';
import type { Offloader } from '../modules/offloader';
import { renderRecalledContent } from '../modules/offloader/recallTool';
import type { NamespaceView, Store } from '../store/store';
import {
  ARCHIVE_NAMESPACE,
  MEMORY_NAMESPACE,
  StoreCapabilityError,
  type StoredEntry,
  type StoredEntryMeta,
  VFS_NAMESPACE,
} from '../store/types';
import { CONTEXT_COMMANDS, type ContextCommand } from './contextTool';
import { type ContextToolPolicy, canWrite } from './policy';

export type { ContextCommand };

/** Every tool name {@link dispatchContextTool} answers to. */
export const CONTEXT_TOOL_NAMES = Object.freeze([
  'context',
  'new_context',
  'create_memory',
  'modify_memory',
  'recall_context',
] as const);

export type ContextToolName = (typeof CONTEXT_TOOL_NAMES)[number];

const OWNED_NAMES = new Set<string>(CONTEXT_TOOL_NAMES);

/** Whether `name` is dispatched by {@link dispatchContextTool}. */
export function isContextToolName(name: string): name is ContextToolName {
  return OWNED_NAMES.has(name);
}

/**
 * One tool call, in the shape the provider SDKs hand back.
 *
 * `arguments` is accepted both as the JSON string OpenAI and Anthropic's raw
 * blocks produce and as the already-parsed object Anthropic's `input` and
 * Gemini's `args` carry.
 */
export interface ContextToolCall {
  name: string;
  arguments?: unknown;
}

/**
 * What the dispatcher needs to answer a call. `ContextChef` implements it, and
 * so can a host that holds a {@link Memory} / {@link Offloader} of its own.
 */
export interface ContextToolHost {
  /** Routes every `memory/` operation, so allowedKeys, vetoes and TTL apply. Null when unconfigured. */
  readonly memory: Memory | null;
  /** Resolves `vfs/` reads, including the LRU bookkeeping a recall implies. */
  readonly offloader: Offloader;
  /** Where `notes/` and any other namespace live. */
  readonly store: Store;
  readonly policy: ContextToolPolicy;
  /** Backs the `new_context` tool. */
  requestNewContext(): void;
}

const URI_PREFIX = 'context://';

/** Namespaces whose `view` renders like the legacy `recall_context` result. */
const RECALL_NAMESPACES = new Set<string>([VFS_NAMESPACE, ARCHIVE_NAMESPACE]);

type Args = Record<string, unknown>;

interface Target {
  ns: string;
  path: string;
}

/** A message meant for the model. Converted to `Error: …` text at the boundary. */
class ToolError extends Error {}

function fail(message: string): never {
  throw new ToolError(message);
}

/**
 * Runs one library-owned tool call and returns the text to hand back as the
 * tool result.
 *
 * @throws when `call.name` is not one of {@link CONTEXT_TOOL_NAMES} — that is a
 *   routing bug in the caller, not something the model can correct.
 */
export async function dispatchContextTool(
  host: ContextToolHost,
  call: ContextToolCall,
): Promise<string> {
  if (!isContextToolName(call.name)) {
    throw new Error(
      `[context-chef] dispatchContextTool: '${call.name}' is not a ContextChef tool. ` +
        `Guard the call with chef.ownsTool(name). Dispatched tools: ${CONTEXT_TOOL_NAMES.join(', ')}.`,
    );
  }

  try {
    return await route(host, call);
  } catch (error) {
    // A capability the backend lacks is the host's configuration, not the
    // model's mistake — but the model is the one waiting for an answer.
    if (error instanceof ToolError || error instanceof StoreCapabilityError) {
      return `Error: ${error.message}`;
    }
    throw error;
  }
}

async function route(host: ContextToolHost, call: ContextToolCall): Promise<string> {
  const args = parseArguments(call.arguments);

  switch (call.name) {
    case 'new_context':
      host.requestNewContext();
      return 'Starting a new context window.';
    case 'create_memory':
      return createMemoryEntry(
        host,
        requireString(args, 'key'),
        requireString(args, 'value'),
        optionalString(args, 'description'),
      );
    case 'modify_memory':
      return modifyMemoryEntry(host, args);
    case 'recall_context':
      return runCommand(host, 'view', requireString(args, 'uri'), args);
    default:
      return runCommand(host, requireCommand(args), requireString(args, 'path'), args);
  }
}

async function runCommand(
  host: ContextToolHost,
  command: ContextCommand,
  rawPath: string,
  args: Args,
): Promise<string> {
  const readOnly = command === 'view' || command === 'search';
  // A read may be addressed with the Offloader's own scheme; a write never is
  // (vfs holds offloaded output, which the model recalls rather than edits).
  const target = (readOnly ? offloadedTarget(host, rawPath) : null) ?? parsePath(rawPath);
  if (!readOnly && !canWrite(host.policy, target.ns)) {
    fail(
      `${uriOf(target)} is read-only. This tool may write to: ${host.policy.writable
        .map((ns) => `${URI_PREFIX}${ns}/`)
        .join(', ')}.`,
    );
  }

  if (target.ns === MEMORY_NAMESPACE) return memoryCommand(host, command, target, args);
  if (command === 'view' && RECALL_NAMESPACES.has(target.ns) && !isDirectory(target.path)) {
    return recallView(host, target, rawPath);
  }
  return storeCommand(host, command, target, args);
}

// ─── memory/ ──────────────────────────────────────────────────────────────
//
// Everything here goes through the Memory module rather than the store, so
// allowedKeys, the onMemoryUpdate veto, onMemoryChanged, TTL and updateCount
// all behave exactly as they do for a direct API call.

function requireMemory(host: ContextToolHost): Memory {
  if (!host.memory) {
    fail(
      `${URI_PREFIX}${MEMORY_NAMESPACE}/ is not available: this ContextChef was built without ` +
        'memory. The host has to pass `memory: { store }` to enable it.',
    );
  }
  return host.memory;
}

function requireAllowedKey(memory: Memory, key: string): void {
  const allowed = memory.allowedKeys;
  if (!allowed || allowed.includes(key)) return;
  fail(
    allowed.length === 0
      ? `${uriOf({ ns: MEMORY_NAMESPACE, path: key })} cannot be written: no memory keys are allowed.`
      : `${uriOf({ ns: MEMORY_NAMESPACE, path: key })} is not an allowed memory key. ` +
          `Allowed keys: ${allowed.join(', ')}.`,
  );
}

async function memoryCommand(
  host: ContextToolHost,
  command: ContextCommand,
  target: Target,
  args: Args,
): Promise<string> {
  const memory = requireMemory(host);
  const key = target.path;

  if (command === 'view') {
    if (isDirectory(key)) return memoryListing(memory, key);
    const entry = await memory.getEntry(key);
    if (!entry) fail(notFound(target));
    return entry.value;
  }

  if (command === 'search') return memorySearch(memory, key, requireString(args, 'query'));

  if (isDirectory(key)) {
    fail(`${uriOf(target)} is a directory. Name the memory key to ${command}.`);
  }

  switch (command) {
    case 'create':
      return createMemoryEntry(
        host,
        key,
        requireString(args, 'file_text'),
        optionalString(args, 'description'),
      );
    case 'str_replace': {
      const value = await requireMemoryValue(memory, target);
      await writeMemory(memory, key, applyStrReplace(value, args, uriOf(target)));
      return `Edited ${uriOf(target)}.`;
    }
    case 'insert': {
      const value = await requireMemoryValue(memory, target);
      await writeMemory(memory, key, applyInsert(value, args, uriOf(target)));
      return `Inserted into ${uriOf(target)}.`;
    }
    case 'delete': {
      requireAllowedKey(memory, key);
      if (!(await memory.getEntry(key))) fail(notFound(target));
      if (!(await memory.deleteMemory(key))) fail(rejected(uriOf(target)));
      return `Deleted ${uriOf(target)}.`;
    }
    default:
      return renameMemory(host, memory, target, args);
  }
}

async function requireMemoryValue(memory: Memory, target: Target): Promise<string> {
  requireAllowedKey(memory, target.path);
  const entry = await memory.getEntry(target.path);
  if (!entry) fail(notFound(target));
  return entry.value;
}

async function writeMemory(memory: Memory, key: string, value: string): Promise<void> {
  const updated = await memory.updateMemory(key, value);
  if (!updated) fail(rejected(uriOf({ ns: MEMORY_NAMESPACE, path: key })));
}

async function createMemoryEntry(
  host: ContextToolHost,
  key: string,
  value: string,
  description?: string,
): Promise<string> {
  const memory = requireMemory(host);
  const target: Target = { ns: MEMORY_NAMESPACE, path: key };
  // The legacy tools take the key raw — nothing has parsed it as a path yet.
  assertSafePath(key, uriOf(target));
  if (!canWrite(host.policy, MEMORY_NAMESPACE)) fail(`${uriOf(target)} is read-only.`);
  requireAllowedKey(memory, key);
  if (await memory.getEntry(key)) {
    fail(`${uriOf(target)} already exists. Use str_replace to edit it, or delete it first.`);
  }
  if (!(await memory.createMemory(key, value, description))) fail(rejected(uriOf(target)));
  return `Created ${uriOf(target)}.`;
}

/** The legacy `modify_memory` tool: a whole-value update, or a delete. */
async function modifyMemoryEntry(host: ContextToolHost, args: Args): Promise<string> {
  const memory = requireMemory(host);
  const action = requireString(args, 'action');
  const key = requireString(args, 'key');
  const target: Target = { ns: MEMORY_NAMESPACE, path: key };
  assertSafePath(key, uriOf(target));
  if (!canWrite(host.policy, MEMORY_NAMESPACE)) fail(`${uriOf(target)} is read-only.`);
  requireAllowedKey(memory, key);
  if (!(await memory.getEntry(key))) fail(notFound(target));

  if (action === 'delete') {
    if (!(await memory.deleteMemory(key))) fail(rejected(uriOf(target)));
    return `Deleted ${uriOf(target)}.`;
  }
  if (action !== 'update') fail(`action must be "update" or "delete", got "${action}".`);

  const value = requireString(args, 'value');
  const updated = await memory.updateMemory(key, value, optionalString(args, 'description'));
  if (!updated) fail(rejected(uriOf(target)));
  return `Updated ${uriOf(target)}.`;
}

async function renameMemory(
  host: ContextToolHost,
  memory: Memory,
  target: Target,
  args: Args,
): Promise<string> {
  const dest = parsePath(requireString(args, 'new_path'));
  if (dest.ns !== target.ns) {
    fail(`rename cannot move ${uriOf(target)} into another namespace (${uriOf(dest)}).`);
  }
  if (isDirectory(dest.path)) fail(`new_path must name a memory key, not a directory.`);
  if (!canWrite(host.policy, dest.ns)) fail(`${uriOf(dest)} is read-only.`);

  requireAllowedKey(memory, target.path);
  requireAllowedKey(memory, dest.path);
  const entry = await memory.getEntry(target.path);
  if (!entry) fail(notFound(target));
  if (await memory.getEntry(dest.path)) fail(`${uriOf(dest)} already exists.`);

  if (!(await memory.createMemory(dest.path, entry.value, entry.description))) {
    fail(rejected(uriOf(dest)));
  }
  if (!(await memory.deleteMemory(target.path))) {
    return `Copied ${uriOf(target)} to ${uriOf(dest)}, but the original could not be removed.`;
  }
  return `Renamed ${uriOf(target)} to ${uriOf(dest)}.`;
}

async function memoryListing(memory: Memory, prefix: string): Promise<string> {
  const entries = (await memory.getAll())
    .filter((entry) => entry.key.startsWith(prefix))
    .sort((a, b) => a.key.localeCompare(b.key));
  const root = `${URI_PREFIX}${MEMORY_NAMESPACE}/${prefix}`;
  if (entries.length === 0) return `${root} is empty.`;
  const lines = entries.map((entry) => {
    const uri = uriOf({ ns: MEMORY_NAMESPACE, path: entry.key });
    return entry.description ? `- ${uri} — ${entry.description}` : `- ${uri}`;
  });
  return [`${root} (${countLabel(entries.length)}):`, ...lines].join('\n');
}

async function memorySearch(memory: Memory, prefix: string, query: string): Promise<string> {
  const needle = requireQuery(query);
  const hits: Hit[] = [];
  for (const entry of await memory.getAll()) {
    if (!entry.key.startsWith(prefix)) continue;
    const haystack = entry.description ? `${entry.value}\n${entry.description}` : entry.value;
    if (!haystack.toLowerCase().includes(needle)) continue;
    hits.push({
      uri: uriOf({ ns: MEMORY_NAMESPACE, path: entry.key }),
      snippet: snippet(haystack, needle),
    });
  }
  return renderHits(hits, query, `${URI_PREFIX}${MEMORY_NAMESPACE}/${prefix}`);
}

// ─── notes/ and every other namespace ─────────────────────────────────────

function namespaceFor(host: ContextToolHost, ns: string): NamespaceView {
  // vfs and archive belong to the Offloader's store, which is only the same
  // object as `host.store` when one backend serves everything.
  return RECALL_NAMESPACES.has(ns) ? host.offloader.store.namespace(ns) : host.store.namespace(ns);
}

async function storeCommand(
  host: ContextToolHost,
  command: ContextCommand,
  target: Target,
  args: Args,
): Promise<string> {
  const view = namespaceFor(host, target.ns);
  const uri = uriOf(target);

  if (command === 'view') return storeView(view, target);
  if (command === 'search') return storeSearch(view, target, requireString(args, 'query'));
  if (isDirectory(target.path)) {
    fail(`${uri} is a directory. Name an entry to ${command}.`);
  }

  switch (command) {
    case 'create': {
      const text = requireString(args, 'file_text');
      if (await view.get(target.path)) {
        fail(`${uri} already exists. Use str_replace to edit it, or delete it first.`);
      }
      await view.put(target.path, text);
      return `Created ${uri}.`;
    }
    case 'str_replace': {
      const entry = await requireEntry(view, target);
      await rewrite(view, target.path, applyStrReplace(entry.content, args, uri), entry);
      return `Edited ${uri}.`;
    }
    case 'insert': {
      const entry = await requireEntry(view, target);
      await rewrite(view, target.path, applyInsert(entry.content, args, uri), entry);
      return `Inserted into ${uri}.`;
    }
    case 'delete': {
      if (!(await view.delete(target.path))) fail(notFound(target));
      return `Deleted ${uri}.`;
    }
    default: {
      const dest = parsePath(requireString(args, 'new_path'));
      if (dest.ns !== target.ns) {
        fail(`rename cannot move ${uri} into another namespace (${uriOf(dest)}).`);
      }
      if (isDirectory(dest.path)) fail('new_path must name an entry, not a directory.');
      if (!canWrite(host.policy, dest.ns)) fail(`${uriOf(dest)} is read-only.`);
      const entry = await requireEntry(view, target);
      if (await view.get(dest.path)) fail(`${uriOf(dest)} already exists.`);
      await view.put(dest.path, entry.content, carryMeta(entry, entry.content));
      await view.delete(target.path);
      return `Renamed ${uri} to ${uriOf(dest)}.`;
    }
  }
}

async function requireEntry(view: NamespaceView, target: Target): Promise<StoredEntry> {
  const entry = await view.get(target.path);
  if (!entry) fail(notFound(target));
  return entry;
}

/** Rewrites an entry's content, keeping the metadata it was created with. */
async function rewrite(
  view: NamespaceView,
  path: string,
  content: string,
  previous: StoredEntry,
): Promise<void> {
  await view.put(path, content, carryMeta(previous, content));
}

/** Previous metadata with the fields an edit invalidates brought up to date. */
function carryMeta(previous: StoredEntry, content: string): StoredEntryMeta {
  return {
    ...previous.meta,
    updatedAt: Date.now(),
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}

async function storeView(view: NamespaceView, target: Target): Promise<string> {
  if (!isDirectory(target.path)) {
    const entry = await view.get(target.path);
    if (entry) return withLineNumbers(entry.content);
    // A path with no entry may still be a directory of nested ones.
    const nested = await safeList(view, `${target.path}/`);
    if (nested.length > 0) return renderListing(target.ns, `${target.path}/`, nested);
    fail(notFound(target));
  }
  return renderListing(target.ns, target.path, await safeList(view, target.path));
}

async function storeSearch(view: NamespaceView, target: Target, query: string): Promise<string> {
  const needle = requireQuery(query);
  const root = `${URI_PREFIX}${target.ns}/${target.path}`;
  const hits: Hit[] = [];

  if (view.supports('search')) {
    for (const hit of await view.search(query)) {
      if (!hit.path.startsWith(target.path)) continue;
      hits.push({ uri: uriOf({ ns: target.ns, path: hit.path }), snippet: hit.snippet });
    }
    return renderHits(hits, query, root);
  }

  // No native search: scan the namespace instead of handing the model a
  // capability error it can do nothing about.
  for (const listed of await safeList(view, target.path)) {
    const entry = await view.get(listed.path);
    if (!entry?.content.toLowerCase().includes(needle)) continue;
    hits.push({
      uri: uriOf({ ns: target.ns, path: listed.path }),
      snippet: snippet(entry.content, needle),
    });
  }
  return renderHits(hits, query, root);
}

/** Lists a prefix, treating "this backend cannot list" as an empty directory. */
async function safeList(view: NamespaceView, prefix: string): Promise<{ path: string }[]> {
  if (!view.supports('list')) return [];
  try {
    return await view.list(prefix || undefined);
  } catch (error) {
    if (error instanceof StoreCapabilityError) return [];
    throw error;
  }
}

function renderListing(ns: string, prefix: string, entries: { path: string }[]): string {
  const root = `${URI_PREFIX}${ns}/${prefix}`;
  if (entries.length === 0) return `${root} is empty.`;
  const lines = [...entries]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((entry) => `- ${uriOf({ ns, path: entry.path })}`);
  return [`${root} (${countLabel(entries.length)}):`, ...lines].join('\n');
}

// ─── vfs/ and archive/ ────────────────────────────────────────────────────

/**
 * The same rendering the legacy `recall_context` path produces: an archived
 * span comes back as a transcript, an offloaded tool output verbatim.
 */
async function recallView(host: ContextToolHost, target: Target, rawPath: string): Promise<string> {
  const stored = await readRecalled(host, target, rawPath);
  if (stored === null) fail(notFound(target));
  return renderRecalledContent(stored);
}

async function readRecalled(
  host: ContextToolHost,
  target: Target,
  rawPath: string,
): Promise<string | null> {
  if (target.ns === VFS_NAMESPACE) {
    // Through the Offloader so the read refreshes LRU recency and adopts
    // files written before this process started.
    const resolved = await host.offloader.resolveAsync(host.offloader.uri(target.path));
    if (resolved !== null) return resolved;
  }
  const entry = await namespaceFor(host, target.ns).get(target.path);
  if (entry) return entry.content;
  // Last resort: the raw argument may be a URI under a custom `vfs.uriScheme`.
  if (rawPath.startsWith(URI_PREFIX)) return host.offloader.resolveAsync(rawPath);
  return null;
}

// ─── argument and path handling ───────────────────────────────────────────

function parseArguments(raw: unknown): Args {
  if (raw == null) return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      fail('the tool arguments were not valid JSON.');
    }
    return asArgs(parsed);
  }
  return asArgs(raw);
}

function asArgs(value: unknown): Args {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('the tool arguments must be a JSON object.');
  }
  return value as Args;
}

function requireCommand(args: Args): ContextCommand {
  const command = requireString(args, 'command');
  if (!(CONTEXT_COMMANDS as readonly string[]).includes(command)) {
    fail(`unknown command "${command}". Use one of: ${CONTEXT_COMMANDS.join(', ')}.`);
  }
  return command as ContextCommand;
}

function requireString(args: Args, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value === '') {
    fail(`the "${name}" argument is required and must be a non-empty string.`);
  }
  return value;
}

function optionalString(args: Args, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`the "${name}" argument must be a string.`);
  return value;
}

function requireInteger(args: Args, name: string): number {
  const value = args[name];
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    fail(`the "${name}" argument is required and must be an integer.`);
  }
  return parsed;
}

function requireQuery(query: string): string {
  const needle = query.toLowerCase();
  if (needle.trim() === '') fail('the "query" argument must not be blank.');
  return needle;
}

/**
 * The `vfs` entry an address names under the Offloader's own `uriScheme`, or
 * null when the Offloader does not recognise it.
 *
 * Every truncation marker cites `offloader.uri(filename)`. With the default
 * scheme that address is `context://vfs/<filename>` and {@link parsePath}
 * reads it correctly; with a custom scheme (`mem://<filename>`) it parses as a
 * namespace called `mem:`, and the library's own dispatcher could not resolve
 * the URI the library itself handed the model.
 */
function offloadedTarget(host: ContextToolHost, rawPath: string): Target | null {
  const raw = rawPath.trim();
  const filename = host.offloader.parseUri(raw);
  if (filename === null) return null;
  assertSafePath(filename, rawPath);
  return { ns: VFS_NAMESPACE, path: filename };
}

/**
 * `context://<ns>/<path>`, `<ns>/<path>` and a bare `<ns>` all parse. A
 * trailing slash (or nothing after the namespace) addresses a directory.
 */
function parsePath(raw: string): Target {
  let rest = raw.trim();
  if (rest.startsWith(URI_PREFIX)) rest = rest.slice(URI_PREFIX.length);
  while (rest.startsWith('/')) rest = rest.slice(1);

  const slash = rest.indexOf('/');
  const ns = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  if (ns === '') {
    fail(`"${raw}" is not a context path. Use ${URI_PREFIX}<namespace>/<path>.`);
  }
  assertSafeNamespace(ns, raw);
  assertSafePath(path, raw);
  return { ns, path };
}

/**
 * The namespace names a store namespace and, on a filesystem backend, one
 * directory under the store root — so it is a single plain segment. `..` here
 * used to reach the parent of the store root.
 */
function assertSafeNamespace(ns: string, raw: string): void {
  const badNamespace = (problem: string): never =>
    fail(`"${raw}" is not a context path: ${problem}. Use ${URI_PREFIX}<namespace>/<path>.`);

  if (ns === '.' || ns === '..') badNamespace(`"${ns}" is not a namespace`);
  if (ns.includes('\\')) badNamespace('a namespace cannot contain a backslash');
  if (ns.includes(':')) badNamespace(`"${ns}" is not a namespace — check the scheme`);
  if (hasControlCharacter(ns)) badNamespace('a namespace cannot contain control characters');
}

/**
 * The path is a storage key, and some backends map keys onto the filesystem —
 * where `.` and `..` climb, and a backslash is a separator on Windows. A single
 * trailing empty segment is the directory form (`notes/sub/`).
 */
function assertSafePath(path: string, raw: string): void {
  if (path === '') return;
  if (path.includes('\\')) {
    fail(`"${raw}" is not a context path: a backslash is not allowed in a path.`);
  }
  if (hasControlCharacter(path)) {
    fail(`"${raw}" is not a context path: control characters are not allowed in a path.`);
  }
  const segments = path.split('/');
  segments.forEach((segment, index) => {
    if (segment === '.' || segment === '..') {
      fail(`"${raw}" is not a context path: "${segment}" is not allowed in a path.`);
    }
    if (segment === '' && index !== segments.length - 1) {
      fail(`"${raw}" is not a context path: it has an empty path segment.`);
    }
  });
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function hasControlCharacter(value: string): boolean {
  return CONTROL_CHARACTERS.test(value);
}

function isDirectory(path: string): boolean {
  return path === '' || path.endsWith('/');
}

function uriOf(target: Target): string {
  return `${URI_PREFIX}${target.ns}/${target.path}`;
}

function notFound(target: Target): string {
  return `nothing is stored at ${uriOf(target)}.`;
}

function rejected(uri: string): string {
  return `the write to ${uri} was rejected by the host.`;
}

// ─── content edits ────────────────────────────────────────────────────────

function applyStrReplace(content: string, args: Args, uri: string): string {
  const oldStr = requireString(args, 'old_str');
  const newStr = optionalString(args, 'new_str') ?? '';
  const first = content.indexOf(oldStr);
  if (first === -1) {
    fail(
      `old_str was not found in ${uri}. It has to match the stored text exactly, ` +
        'including whitespace.',
    );
  }
  if (content.indexOf(oldStr, first + oldStr.length) !== -1) {
    fail(
      `old_str appears more than once in ${uri}. Include enough surrounding text for it to ` +
        'match exactly one place.',
    );
  }
  // Index splice, not String.replace: `$&` and friends in new_str are literal text.
  return content.slice(0, first) + newStr + content.slice(first + oldStr.length);
}

function applyInsert(content: string, args: Args, uri: string): string {
  const at = requireInteger(args, 'insert_line');
  const text = requireString(args, 'insert_text');
  const lines = content === '' ? [] : content.split('\n');
  if (at < 0 || at > lines.length) {
    fail(
      `insert_line ${at} is out of range for ${uri}, which has ${countLabel(lines.length, 'line', 'lines')}. ` +
        `Use 0 to ${lines.length}.`,
    );
  }
  lines.splice(at, 0, ...text.split('\n'));
  return lines.join('\n');
}

function withLineNumbers(content: string): string {
  return content
    .split('\n')
    .map((line, index) => `${String(index + 1).padStart(6, ' ')}\t${line}`)
    .join('\n');
}

// ─── search rendering ─────────────────────────────────────────────────────

interface Hit {
  uri: string;
  snippet?: string;
}

const SNIPPET_MARGIN = 40;

function snippet(content: string, needle: string): string {
  const at = content.toLowerCase().indexOf(needle);
  if (at === -1) return '';
  const start = Math.max(0, at - SNIPPET_MARGIN);
  const end = Math.min(content.length, at + needle.length + SNIPPET_MARGIN);
  const body = content.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < content.length ? '…' : ''}`;
}

function renderHits(hits: Hit[], query: string, root: string): string {
  if (hits.length === 0) return `No matches for "${query}" under ${root}.`;
  const lines = hits.map((hit) => (hit.snippet ? `- ${hit.uri}: ${hit.snippet}` : `- ${hit.uri}`));
  return [
    `${countLabel(hits.length, 'match', 'matches')} for "${query}" under ${root}:`,
    ...lines,
  ].join('\n');
}

function countLabel(count: number, singular = 'entry', plural = 'entries'): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
