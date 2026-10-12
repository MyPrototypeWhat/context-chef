import type { PrefixCandidate, PrefixEntry } from './types';

/** A memory entry as the `<memory>` block lists it. */
export interface MemoryEntryXml {
  readonly key: string;
  /** `<entry key="…">…</entry>`, as `renderMemoryEntry` renders it. */
  readonly xml: string;
}

/** Memory as one compile reads it. */
export interface MemoryNow {
  /** The entries the selector picked, in its order. */
  readonly selected: readonly MemoryEntryXml[];
  /** Every key memory holds, picked or not. */
  readonly live: ReadonlySet<string>;
  /**
   * The model's own last write to a key through `handleTool`: the `<entry>`
   * it left, or `null` when it deleted the key. Its tool result told the
   * model, and nothing the window says of that key is newer: an event that
   * states the key again supersedes the write.
   */
  readonly written: ReadonlyMap<string, string | null>;
}

/** The words of a memory event, in the session's vocabulary. */
export interface MemoryWords {
  /** The line every snapshot opens with (`Vocabulary.memoryBlockHeader`). */
  readonly header: string;
  /** The snapshot of what the selector picked (`Vocabulary.memoryBlock`). */
  readonly snapshot: string;
  /** A delta around its `<memory>` block (`Vocabulary.memoryDelta`). */
  delta(memoryXml: string): string;
}

const entryTag = (key: string): string => `<entry key="${key}">`;
/** How a delta says a key is gone, deleted or expired. */
const removedEntry = (key: string): string => `<entry key="${key}" removed="true"/>`;
const MENTION = /<entry key="([^"]*)"/g;

/**
 * Concept two for memory. The window states memory once, with a snapshot of
 * what the selector picks; after that only what the model was not told is
 * appended, as a delta: an entry picked now that the window shows otherwise
 * or not at all, and the removal of one it shows. An entry the selector
 * does not pick is left alone while memory holds it, changed or not; once it
 * is removed, that is said if the model saw it — in the window, or because
 * it wrote the entry itself — whatever the selector picks.
 *
 * What the model was told is read back from the memory entries still in the
 * window, `told` — each mention of a key, an `<entry>` or its removal,
 * replaces the one before — and from the writes it made itself. A snapshot
 * is appended only when the window holds none and something picked is news;
 * a checkpoint that dropped the snapshot is how a window comes to hold none.
 * A key a snapshot leaves out is not taken as gone: one the window showed
 * earlier and memory no longer holds is said to be removed.
 *
 * `keys` are the keys this compile's events speak for.
 */
export function memoryEvents(
  told: readonly PrefixEntry[],
  now: MemoryNow,
  words: MemoryWords,
): { events: PrefixCandidate[]; keys: string[] } {
  /** The text that tells the model what `key` holds; `null` when it knows of no such entry. */
  const believed = (key: string): string | null => {
    const written = now.written.get(key);
    if (written !== undefined) return written;
    for (let i = told.length - 1; i >= 0; i--) {
      const { content } = told[i];
      if (content.includes(removedEntry(key))) return null;
      if (content.includes(entryTag(key))) return content;
    }
    return null;
  };

  const news = now.selected.filter(({ key, xml }) => !believed(key)?.includes(xml));
  const shown = new Set<string>();
  for (const { content } of told) {
    for (const [, key] of content.matchAll(MENTION)) shown.add(key);
  }
  for (const [key, xml] of now.written) if (xml !== null) shown.add(key);
  const gone = [...shown].filter((key) => !now.live.has(key) && believed(key) !== null);

  const events: PrefixCandidate[] = [];
  const keys: string[] = [];
  const snapshot = news.length > 0 && !told.some((entry) => entry.content.startsWith(words.header));
  if (snapshot) {
    events.push({ channel: 'user', content: words.snapshot, sources: ['memory'] });
    keys.push(...now.selected.map((entry) => entry.key));
  }
  const changed = snapshot ? [] : news;
  if (changed.length > 0 || gone.length > 0) {
    const entries = [...changed.map((entry) => entry.xml), ...gone.map(removedEntry)];
    events.push({
      channel: 'user',
      content: words.delta(`<memory>\n${entries.join('\n\n')}\n</memory>`),
      sources: ['memory'],
    });
    keys.push(...changed.map((entry) => entry.key), ...gone);
  }
  return { events, keys };
}
