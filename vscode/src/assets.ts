import * as crypto from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';

const ASSET_INDEX_KEY = 'multimodalAssets.v1';

export interface AssetRecord {
  id: string;
  sha256: string;
  mediaType: string;
  displayName: string;
  size: number;
  storageName: string;
  createdAt: number;
}

export interface PutAssetOptions {
  mediaType?: string;
  displayName?: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
};

export function mediaTypeForName(name: string): string {
  return MIME_BY_EXTENSION[path.extname(name).toLowerCase()] || 'application/octet-stream';
}

export class AssetStore {
  readonly root: vscode.Uri;

  constructor(private context: vscode.ExtensionContext) {
    const scope = context.storageUri || vscode.Uri.joinPath(context.globalStorageUri, 'no-workspace');
    this.root = vscode.Uri.joinPath(scope, 'multimodal-assets');
  }

  all(): AssetRecord[] {
    return this.context.workspaceState.get<AssetRecord[]>(ASSET_INDEX_KEY, []);
  }

  get(id: string): AssetRecord | undefined {
    return this.all().find((asset) => asset.id === id);
  }

  uri(recordOrId: AssetRecord | string): vscode.Uri | undefined {
    const record = typeof recordOrId === 'string' ? this.get(recordOrId) : recordOrId;
    return record ? vscode.Uri.joinPath(this.root, record.storageName) : undefined;
  }

  async read(id: string): Promise<Uint8Array | undefined> {
    const uri = this.uri(id);
    if (!uri) return undefined;
    try {
      return await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }
  }

  async putUri(uri: vscode.Uri): Promise<AssetRecord> {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const displayName = uri.scheme === 'file'
      ? path.basename(uri.fsPath)
      : path.posix.basename(uri.path);
    return this.put(bytes, {
      displayName,
      mediaType: mediaTypeForName(displayName),
    });
  }

  async put(bytes: Uint8Array, options: PutAssetOptions = {}): Promise<AssetRecord> {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const existing = this.all().find((asset) => asset.sha256 === sha256);
    if (existing) return existing;

    const id = crypto.randomUUID();
    const mediaType = options.mediaType || mediaTypeForName(options.displayName || '');
    const extension = EXTENSION_BY_MIME[mediaType] || '';
    const record: AssetRecord = {
      id,
      sha256,
      mediaType,
      displayName: options.displayName || `attachment${extension}`,
      size: bytes.byteLength,
      storageName: `${id}${extension}`,
      createdAt: Date.now(),
    };

    await vscode.workspace.fs.createDirectory(this.root);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.root, record.storageName), bytes);
    await this.context.workspaceState.update(ASSET_INDEX_KEY, [...this.all(), record]);
    return record;
  }

  async removeUnreferenced(referencedIds: Iterable<string>): Promise<string[]> {
    const keep = new Set(referencedIds);
    const assets = this.all();
    const retained: AssetRecord[] = [];
    const removed: string[] = [];
    for (const asset of assets) {
      if (keep.has(asset.id)) {
        retained.push(asset);
        continue;
      }
      const uri = this.uri(asset);
      if (uri) {
        try {
          await vscode.workspace.fs.delete(uri);
        } catch {
          // A missing asset file is already collected; still repair the index.
        }
      }
      removed.push(asset.id);
    }
    if (removed.length) await this.context.workspaceState.update(ASSET_INDEX_KEY, retained);
    return removed;
  }
}
