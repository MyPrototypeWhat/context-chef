import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Prompts } from '../prompts';

export interface VFSConfig {
  /** Maximum length of content before it gets offloaded (e.g. 5000 characters) */
  threshold: number;
  /** Directory to store offloaded files */
  storageDir: string;
  /** Custom URI prefix scheme, e.g. 'context://' */
  uriScheme?: string;
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

  constructor(config: Partial<VFSConfig> = {}) {
    this.config = {
      threshold: config.threshold ?? 5000,
      storageDir: config.storageDir ?? path.join(process.cwd(), '.context_vfs'),
      uriScheme: config.uriScheme ?? 'context://vfs/',
    };

    if (!fs.existsSync(this.config.storageDir)) {
      fs.mkdirSync(this.config.storageDir, { recursive: true });
    }
  }

  /**
   * Scans content. If it exceeds the threshold, writes the full content to VFS
   * and returns a truncated string with a pointer URI.
   * If not, returns the original content.
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

    const hash = crypto.createHash('md5').update(content).digest('hex').substring(0, 8);
    const filename = `${type}_${Date.now()}_${hash}.txt`;
    const filepath = path.join(this.config.storageDir, filename);

    fs.writeFileSync(filepath, content, 'utf8');

    const uri = `${this.config.uriScheme}${filename}`;

    let lastLines = '';
    // For logs, it's often useful to keep the last few lines
    if (type === 'log') {
      const lines = content.split('\n');
      lastLines = lines.slice(-20).join('\n');
    }

    const truncated = Prompts.getVFSOffloadReminder(activeThreshold, uri, lastLines);

    return {
      isOffloaded: true,
      content: truncated,
      uri,
    };
  }

  /**
   * Reads the full content back from a URI
   */
  public resolve(uri: string): string | null {
    const scheme = this.config.uriScheme;
    if (!scheme || !uri.startsWith(scheme)) {
      return null;
    }

    const filename = uri.slice(scheme.length);
    const filepath = path.join(this.config.storageDir, filename);

    if (fs.existsSync(filepath)) {
      return fs.readFileSync(filepath, 'utf8');
    }

    return null;
  }
}
