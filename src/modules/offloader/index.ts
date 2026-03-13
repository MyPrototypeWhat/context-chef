import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prompts } from '../../prompts';

export interface VFSStorageAdapter {
  write(filename: string, content: string): void | Promise<void>;
  read(filename: string): string | null | Promise<string | null>;
}

export class FileSystemAdapter implements VFSStorageAdapter {
  private storageDir: string;

  constructor(storageDir: string) {
    this.storageDir = storageDir;
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  write(filename: string, content: string): void {
    const filepath = path.join(this.storageDir, filename);
    fs.writeFileSync(filepath, content, 'utf8');
  }

  read(filename: string): string | null {
    const filepath = path.join(this.storageDir, filename);
    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8');
    }
    return null;
  }
}

export interface VFSConfig {
  /** Maximum length of content before it gets offloaded (e.g. 5000 characters) */
  threshold: number;
  /** Directory to store offloaded files (used by default FileSystemAdapter). Ignored if adapter is provided. */
  storageDir?: string;
  /** Custom URI prefix scheme, e.g. 'context://' */
  uriScheme?: string;
  /** Custom storage adapter. If provided, overrides storageDir and filesystem operations. */
  adapter?: VFSStorageAdapter;
}

export interface VFSResult {
  isOffloaded: boolean;
  content: string;
  uri?: string;
}

export interface OffloadOptions {
  /** Allows overriding the instance threshold for a specific call */
  threshold?: number;
  /** Number of characters to preserve from the head of the content (default: 0) */
  headChars?: number;
  /** Number of characters to preserve from the tail of the content (default: 2000) */
  tailChars?: number;
}

export class Offloader {
  private config: VFSConfig;
  private adapter: VFSStorageAdapter;

  constructor(config: Partial<VFSConfig> = {}) {
    const storageDir = config.storageDir ?? path.join(process.cwd(), '.context_vfs');
    this.config = {
      threshold: config.threshold ?? 5000,
      storageDir,
      uriScheme: config.uriScheme ?? 'context://vfs/',
    };

    this.adapter = config.adapter ?? new FileSystemAdapter(storageDir);
  }

  /**
   * Snaps a character index to the nearest line boundary.
   * For head: snaps backward to include the last complete line.
   * For tail: snaps forward to start at the beginning of a line.
   */
  private _snapToLineBoundary(content: string, charIndex: number, direction: 'head' | 'tail'): number {
    if (charIndex <= 0) return 0;
    if (charIndex >= content.length) return content.length;

    if (direction === 'head') {
      // Snap backward: find the last newline before or at charIndex
      const lastNewline = content.lastIndexOf('\n', charIndex);
      return lastNewline === -1 ? charIndex : lastNewline + 1;
    }
    // Snap forward: find the first newline at or after charIndex
    const nextNewline = content.indexOf('\n', charIndex);
    return nextNewline === -1 ? charIndex : nextNewline + 1;
  }

  private _prepareOffload(content: string, headChars: number, tailChars: number) {
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    const filename = `vfs_${Date.now()}_${hash}.txt`;
    const uri = `${this.config.uriScheme}${filename}`;

    const totalLines = content.split('\n').length;
    const totalChars = content.length;

    // Snap to line boundaries
    const headEnd = headChars > 0 ? this._snapToLineBoundary(content, headChars, 'head') : 0;
    const tailStart = tailChars > 0
      ? this._snapToLineBoundary(content, content.length - tailChars, 'tail')
      : content.length;

    const headStr = headEnd > 0 ? content.slice(0, headEnd) : '';
    const tailStr = tailStart < content.length ? content.slice(tailStart) : '';

    const truncated = Prompts.getVFSOffloadReminder(uri, totalLines, totalChars, headStr, tailStr);

    return { filename, uri, truncated };
  }

  /**
   * If content exceeds the threshold, writes full content to VFS (synchronously)
   * and returns a truncated string with a pointer URI.
   * Throws an error if the configured adapter is asynchronous.
   */
  public offload(content: string, options?: OffloadOptions): VFSResult {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const headChars = options?.headChars ?? 0;
    const tailChars = options?.tailChars ?? 2000;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    // If head + tail would cover the entire content, no need to truncate
    if (headChars + tailChars >= content.length) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, headChars, tailChars);

    const writeResult = this.adapter.write(filename, content);
    if (writeResult instanceof Promise) {
      throw new Error(
        'Offloader.offload() was called synchronously, but the VFSStorageAdapter is asynchronous. Use offloadAsync() instead.',
      );
    }

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * If content exceeds the threshold, writes full content to VFS (asynchronously)
   * and returns a truncated string with a pointer URI.
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async offloadAsync(content: string, options?: OffloadOptions): Promise<VFSResult> {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const headChars = options?.headChars ?? 0;
    const tailChars = options?.tailChars ?? 2000;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    if (headChars + tailChars >= content.length) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, headChars, tailChars);

    await this.adapter.write(filename, content);

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * Reads the full content back from a URI (synchronously).
   * Throws an error if the adapter is asynchronous.
   */
  public resolve(uri: string): string | null {
    const scheme = this.config.uriScheme;
    if (!scheme || !uri.startsWith(scheme)) {
      return null;
    }

    const filename = uri.slice(scheme.length);
    const readResult = this.adapter.read(filename);

    if (readResult instanceof Promise) {
      throw new Error(
        'Offloader.resolve() was called synchronously, but the VFSStorageAdapter is asynchronous. Use resolveAsync() instead.',
      );
    }

    return readResult;
  }

  /**
   * Reads the full content back from a URI (asynchronously).
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async resolveAsync(uri: string): Promise<string | null> {
    const scheme = this.config.uriScheme;
    if (!scheme || !uri.startsWith(scheme)) {
      return null;
    }

    const filename = uri.slice(scheme.length);
    const readResult = await this.adapter.read(filename);

    return readResult;
  }
}
