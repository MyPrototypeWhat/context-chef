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
  /** Number of tail lines to preserve in the truncated output (default: 20) */
  tailLines?: number;
}

export class Pointer {
  private config: VFSConfig;
  private adapter: VFSStorageAdapter;

  constructor(config: Partial<VFSConfig> = {}) {
    this.config = {
      threshold: config.threshold ?? 5000,
      storageDir: config.storageDir ?? path.join(process.cwd(), '.context_vfs'),
      uriScheme: config.uriScheme ?? 'context://vfs/',
    };

    this.adapter = config.adapter ?? new FileSystemAdapter(this.config.storageDir!);
  }

  private _prepareOffload(content: string, activeThreshold: number, tailLines: number) {
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    const filename = `vfs_${Date.now()}_${hash}.txt`;

    let lastLinesStr = '';
    if (tailLines > 0) {
      const lines = content.split('\n');
      lastLinesStr = lines.slice(-tailLines).join('\n');
    }

    const uri = `${this.config.uriScheme}${filename}`;
    const truncated = Prompts.getVFSOffloadReminder(activeThreshold, uri, lastLinesStr);

    return { filename, uri, truncated };
  }

  /**
   * If content exceeds the threshold, writes full content to VFS (synchronously)
   * and returns a truncated string with a pointer URI.
   * Throws an error if the configured adapter is asynchronous.
   */
  public offload(
    content: string,
    options?: OffloadOptions,
  ): VFSResult {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const tailLines = options?.tailLines ?? 20;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, activeThreshold, tailLines);

    const writeResult = this.adapter.write(filename, content);
    if (writeResult instanceof Promise) {
      throw new Error('Pointer.offload() was called synchronously, but the VFSStorageAdapter is asynchronous. Use offloadAsync() instead.');
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
  public async offloadAsync(
    content: string,
    options?: OffloadOptions,
  ): Promise<VFSResult> {
    const activeThreshold = options?.threshold ?? this.config.threshold;
    const tailLines = options?.tailLines ?? 20;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, activeThreshold, tailLines);

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
      throw new Error('Pointer.resolve() was called synchronously, but the VFSStorageAdapter is asynchronous. Use resolveAsync() instead.');
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
