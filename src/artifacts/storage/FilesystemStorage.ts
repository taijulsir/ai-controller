import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IArtifactStorage } from "./interfaces";

export class FilesystemStorage implements IArtifactStorage {
  constructor(private readonly baseDirectory: string) {}

  async save(key: string, content: Buffer | string | Readable): Promise<void> {
    const filePath = this.resolvePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });

    const source = Buffer.isBuffer(content) || typeof content === "string" ? Readable.from(content) : content;
    await pipeline(source, createWriteStream(filePath));
  }

  async read(key: string): Promise<Readable> {
    return createReadStream(this.resolvePath(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.resolvePath(key));
      return true;
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    await this.walk(this.resolvePath(prefix), keys);
    return keys;
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const destinationPath = this.resolvePath(destinationKey);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(this.resolvePath(sourceKey), destinationPath);
  }

  private async walk(directory: string, keys: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (this.isFileNotFoundError(error)) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.walk(entryPath, keys);
      } else {
        keys.push(path.relative(this.baseDirectory, entryPath).split(path.sep).join("/"));
      }
    }
  }

  // Every key resolves inside baseDirectory -- a key that would escape it
  // (via ".." segments or an absolute path) is rejected here, so path
  // traversal is impossible by construction rather than relying on callers
  // to only ever pass safe, id-based keys (security review, path safety).
  private resolvePath(key: string): string {
    const resolved = path.resolve(this.baseDirectory, key);
    const relative = path.relative(this.baseDirectory, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Artifact storage key escapes base directory: ${key}`);
    }
    return resolved;
  }

  private isFileNotFoundError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
  }
}
