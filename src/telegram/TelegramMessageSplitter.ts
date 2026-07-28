// Splits a message that may exceed Telegram's per-message length limit into
// multiple chunks, preferring to break on a newline boundary so lines aren't
// cut mid-word.
//
// HTML-tag aware: ResponseFormatter's output is sent with parse_mode "HTML",
// and its own long-running content (a /showchanges diff wrapped in <pre>)
// can easily exceed maxLength on its own. A naive character-offset split
// would cut straight through that <pre>...</pre> block, leaving one chunk
// with an unclosed <pre> and the next with a stray </pre> -- both invalid,
// and Telegram rejects the entire chunk with a 400 ("can't parse entities")
// rather than rendering it degraded. So whenever a split point falls inside
// an open tag, that tag is closed at the end of the chunk and reopened at
// the start of the next one, exactly like paginating a syntax-highlighted
// code block.
const TAG_PATTERN = /<\/?([a-zA-Z][a-zA-Z0-9]*)>/g;

export function splitMessageText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let openTags: string[] = [];
  let remaining = text;

  while (true) {
    const prefix = openTagsPrefix(openTags);

    // Whatever tags are still open get closed by the real end of the
    // original text (it's well-formed HTML), so no extra suffix is needed
    // once the rest of the message fits in one chunk.
    if (prefix.length + remaining.length <= maxLength) {
      chunks.push(prefix + remaining);
      break;
    }

    // Optimistic first guess: no closing-tag suffix reserved. Once the
    // suffix a real cut would need is known, shrink and retry if it doesn't
    // actually fit -- converges in a couple of iterations since each retry
    // only has to shed the (small, fixed) suffix overhead, never more.
    let cutBudget = Math.max(1, maxLength - prefix.length);
    let slice: string;
    let suffix: string;
    let nextOpenTags: string[];

    while (true) {
      let cut = remaining.lastIndexOf("\n", cutBudget);
      if (cut <= 0) {
        cut = cutBudget;
      }

      slice = withoutTrailingPartialTag(remaining.slice(0, cut));
      if (slice.length === 0) {
        // Only reachable if closing the currently-open tags alone would
        // already exceed maxLength -- not possible for this module's own
        // short tag names at any realistic maxLength, but guards against an
        // infinite loop regardless.
        slice = remaining.slice(0, 1);
      }

      nextOpenTags = tagsOpenAfter(slice, openTags);
      suffix = closingTagsSuffix(nextOpenTags);

      if (slice.length <= 1 || prefix.length + slice.length + suffix.length <= maxLength) {
        break;
      }
      cutBudget = Math.max(1, cutBudget - (prefix.length + slice.length + suffix.length - maxLength));
    }

    chunks.push(prefix + slice + suffix);
    remaining = remaining.slice(slice.length).replace(/^\n+/, "");
    openTags = nextOpenTags;
  }

  return chunks;
}

function openTagsPrefix(openTags: string[]): string {
  return openTags.map((tag) => `<${tag}>`).join("");
}

function closingTagsSuffix(openTags: string[]): string {
  return [...openTags].reverse().map((tag) => `</${tag}>`).join("");
}

// A split index chosen purely by length/newline can land in the middle of a
// literal "<tag>" delimiter. Since every "<" and ">" in diff/user content is
// already escaped to "&lt;"/"&gt;" by TelegramHtml's escapeHtml, any raw "<"
// this close to the end of a slice can only be the start of one of this
// module's own tags -- so it's always safe to just push it into the next
// chunk rather than split it in half.
function withoutTrailingPartialTag(slice: string): string {
  const lastOpen = slice.lastIndexOf("<");
  const lastClose = slice.lastIndexOf(">");
  if (lastOpen > lastClose) {
    return slice.slice(0, lastOpen);
  }
  return slice;
}

function tagsOpenAfter(slice: string, initialOpenTags: string[]): string[] {
  const stack = [...initialOpenTags];
  for (const match of slice.matchAll(TAG_PATTERN)) {
    const tagName = match[1];
    if (match[0].startsWith("</")) {
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    } else {
      stack.push(tagName);
    }
  }
  return stack;
}
