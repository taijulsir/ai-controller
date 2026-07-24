import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FilesystemStorage } from "../storage/FilesystemStorage";

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

describe("FilesystemStorage", () => {
  let baseDirectory: string;
  let storage: FilesystemStorage;

  beforeEach(async () => {
    baseDirectory = await mkdtemp(path.join(tmpdir(), "artifact-storage-"));
    storage = new FilesystemStorage(baseDirectory);
  });

  afterEach(async () => {
    await rm(baseDirectory, { recursive: true, force: true });
  });

  it("round-trips buffer content through nested keys", async () => {
    await storage.save("2026/07/22/a.md", Buffer.from("hello"));
    const data = await streamToString(await storage.read("2026/07/22/a.md"));
    expect(data).toBe("hello");
  });

  it("round-trips streamed content without full buffering upfront", async () => {
    const large = "x".repeat(1024 * 1024);
    await storage.save("2026/07/22/large.txt", Readable.from(large));
    const data = await streamToString(await storage.read("2026/07/22/large.txt"));
    expect(data).toBe(large);
  });

  it("reports existence correctly before and after delete", async () => {
    await storage.save("2026/07/22/b.md", "content");
    expect(await storage.exists("2026/07/22/b.md")).toBe(true);

    await storage.delete("2026/07/22/b.md");
    expect(await storage.exists("2026/07/22/b.md")).toBe(false);
  });

  it("lists keys recursively as forward-slash relative paths", async () => {
    await storage.save("2026/07/22/a.md", "a");
    await storage.save("2026/07/23/b.md", "b");

    const keys = await storage.list();
    expect(keys.sort()).toEqual(["2026/07/22/a.md", "2026/07/23/b.md"]);
  });

  it("copies content to a new key without disturbing the source", async () => {
    await storage.save("2026/07/22/a.md", "original");
    await storage.copy("2026/07/22/a.md", "2026/07/22/a-copy.md");

    expect(await streamToString(await storage.read("2026/07/22/a-copy.md"))).toBe("original");
    expect(await streamToString(await storage.read("2026/07/22/a.md"))).toBe("original");
  });

  it("rejects keys that would escape the base directory", async () => {
    await expect(storage.save("../escape.md", "nope")).rejects.toThrow(/escapes base directory/);
  });
});
