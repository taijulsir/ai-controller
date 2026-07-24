import { Readable } from "node:stream";
import type { IArtifactStorage } from "../storage/interfaces";

// Test-only IArtifactStorage implementation -- backs ArtifactIndex/
// ArtifactService unit tests with no disk I/O, demonstrating the
// testability benefit the storage abstraction review called out.
export class InMemoryStorage implements IArtifactStorage {
  private readonly objects = new Map<string, Buffer>();

  async save(key: string, content: Buffer | string | Readable): Promise<void> {
    if (Buffer.isBuffer(content)) {
      this.objects.set(key, content);
      return;
    }
    if (typeof content === "string") {
      this.objects.set(key, Buffer.from(content, "utf8"));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of content) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(key, Buffer.concat(chunks));
  }

  async read(key: string): Promise<Readable> {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`No such key: ${key}`);
    }
    return Readable.from(object);
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async list(prefix = ""): Promise<string[]> {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }

  async copy(sourceKey: string, destinationKey: string): Promise<void> {
    const object = this.objects.get(sourceKey);
    if (!object) {
      throw new Error(`No such key: ${sourceKey}`);
    }
    this.objects.set(destinationKey, object);
  }
}
