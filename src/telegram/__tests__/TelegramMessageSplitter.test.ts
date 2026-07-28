import { describe, expect, it } from "vitest";
import { splitMessageText } from "../TelegramMessageSplitter";

// Balances "<tag>"/"</tag>" occurrences in a chunk; a mismatch here is
// exactly the shape of bug that produced Telegram's real "can't parse
// entities: Can't find end tag corresponding to start tag pre" error.
function isBalanced(chunk: string): boolean {
  const stack: string[] = [];
  for (const match of chunk.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)>/g)) {
    const tagName = match[1];
    if (match[0].startsWith("</")) {
      if (stack.pop() !== tagName) {
        return false;
      }
    } else {
      stack.push(tagName);
    }
  }
  return stack.length === 0;
}

describe("splitMessageText", () => {
  it("returns the text unchanged when it already fits", () => {
    expect(splitMessageText("hello", 100)).toEqual(["hello"]);
  });

  it("splits plain text on a newline boundary near the limit", () => {
    const text = `${"a".repeat(50)}\n${"b".repeat(50)}`;
    const chunks = splitMessageText(text, 60);
    expect(chunks.join("\n")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
    }
  });

  it("keeps every chunk of a <pre> block spanning a split with balanced tags", () => {
    const diffLines = Array.from({ length: 400 }, (_, i) => `+line ${i} some diff content here`);
    const text = `<b>Header</b>\n\n<pre>${diffLines.join("\n")}</pre>`;
    const chunks = splitMessageText(text, 500);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(isBalanced(chunk)).toBe(true);
    }
    // Reassembling by stripping the tags this splitter itself re-inserted
    // should reproduce the same diff lines, in order, with nothing lost.
    const reassembled = chunks.join("").replace(/<\/?pre>/g, "").replace(/<\/?b>/g, "");
    expect(reassembled).toContain("line 0 ");
    expect(reassembled).toContain("line 399 ");
  });

  it("reopens the tag at the start of the next chunk", () => {
    const diffLines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const text = `<pre>${diffLines.join("\n")}</pre>`;
    const chunks = splitMessageText(text, 400);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith("<pre>")).toBe(true);
    expect(chunks[0].endsWith("</pre>")).toBe(true);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startsWith("<pre>")).toBe(true);
    }
    expect(chunks[chunks.length - 1].endsWith("</pre>")).toBe(true);
  });

  it("never cuts a tag delimiter itself in half", () => {
    const diffLines = Array.from({ length: 500 }, (_, i) => `+line ${i}`);
    const text = `<pre>${diffLines.join("\n")}</pre>`;
    const chunks = splitMessageText(text, 137); // deliberately awkward length
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/<[a-zA-Z]*$/);
      expect(isBalanced(chunk)).toBe(true);
    }
  });

  it("keeps every chunk within maxLength, including its closing-tag suffix", () => {
    const diffLines = Array.from({ length: 600 }, (_, i) => `+line ${i} padding padding padding`);
    const text = `<pre>${diffLines.join("\n")}</pre>`;
    const chunks = splitMessageText(text, 400);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
  });

  it("keeps every chunk within maxLength even when maxLength is very small", () => {
    const diffLines = Array.from({ length: 50 }, (_, i) => `+line ${i} padding`);
    const text = `<pre>${diffLines.join("\n")}</pre>`;
    const chunks = splitMessageText(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
      expect(isBalanced(chunk)).toBe(true);
    }
  });
});
