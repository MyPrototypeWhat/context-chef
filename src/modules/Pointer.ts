import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prompts } from '../prompts';

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

export interface ProcessOptions {
  /** Allows overriding the instance threshold for a specific call */
  threshold?: number;
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

  private _prepareOffload(content: string, type: 'log' | 'doc', activeThreshold: number) {
    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    const filename = `${type}_${Date.now()}_${hash}.txt`;

    let lastLines = '';
    // For logs, it's often useful to keep the last few lines
    if (type === 'log') {
      const lines = content.split('\n');
      lastLines = lines.slice(-20).join('\n');
    }

    const uri = `${this.config.uriScheme}${filename}`;
    const truncated = Prompts.getVFSOffloadReminder(activeThreshold, uri, lastLines);

    return { filename, uri, truncated };
  }

  /**
   * Scans content. If it exceeds the threshold, writes the full content to VFS (synchronously)
   * and returns a truncated string with a pointer URI.
   * If not, returns the original content.
   * Throws an error if the configured adapter is asynchronous.
   */
  public process(
    content: string,
    type: 'log' | 'doc' = 'log',
    options?: ProcessOptions,
  ): VFSResult {
    const activeThreshold = options?.threshold ?? this.config.threshold;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, type, activeThreshold);
    
    const writeResult = this.adapter.write(filename, content);
    if (writeResult instanceof Promise) {
      throw new Error('Pointer.process() was called synchronously, but the VFSStorageAdapter is asynchronous. Use processAsync() instead.');
    }

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * Scans content. If it exceeds the threshold, writes the full content to VFS (asynchronously)
   * and returns a truncated string with a pointer URI.
   * If not, returns the original content.
   * Safely supports both synchronous and asynchronous adapters.
   */
  public async processAsync(
    content: string,
    type: 'log' | 'doc' = 'log',
    options?: ProcessOptions,
  ): Promise<VFSResult> {
    const activeThreshold = options?.threshold ?? this.config.threshold;

    if (content.length <= activeThreshold) {
      return { isOffloaded: false, content };
    }

    const { filename, uri, truncated } = this._prepareOffload(content, type, activeThreshold);
    
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
