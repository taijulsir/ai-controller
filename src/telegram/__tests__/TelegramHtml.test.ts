import { describe, expect, it } from "vitest";
import { escapeHtml, stripHtml } from "../TelegramHtml";

describe("escapeHtml", () => {
  it("escapes &, <, > so they can never be read as markup", () => {
    expect(escapeHtml("<script>a && b</script>")).toBe("&lt;script&gt;a &amp;&amp; b&lt;/script&gt;");
  });

  it("escapes a literal </pre> so it cannot close an outer <pre> block early", () => {
    expect(escapeHtml("some diff line\n</pre>\nmore")).toBe("some diff line\n&lt;/pre&gt;\nmore");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("+ added line, unchanged")).toBe("+ added line, unchanged");
  });
});

describe("stripHtml", () => {
  it("removes this module's tags and decodes entities back to plain text", () => {
    expect(stripHtml("<b>Title</b>\n<pre>a &lt; b &amp;&amp; c &gt; d</pre>")).toBe("Title\na < b && c > d");
  });

  it("round-trips escapeHtml output back to the original text", () => {
    const original = "diff with <tags>, & ampersands, and </pre> fragments";
    expect(stripHtml(escapeHtml(original))).toBe(original);
  });
});
