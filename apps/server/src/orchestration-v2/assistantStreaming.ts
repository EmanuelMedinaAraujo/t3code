import type { ResponseStreamingMode } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

// An opening fence may sit at any indentation, since fences inside list
// items are indented past the marker. A closing fence may be indented at most
// three spaces more than its opener. Deeper lines are content in the block.
const MARKDOWN_FENCE_PATTERN = /^( *)(`{3,}|~{3,})/;
// CommonMark blank lines hold only spaces and tabs. Other whitespace, such as
// a no-break space, is paragraph content.
const BLANK_LINE_PATTERN = /^[ \t]*$/;
// A bullet or ordered marker followed by whitespace, at any indentation so
// nested items count. The trailing space is required, so a partial `-` or
// `1.` never matches before the model finishes the marker.
const LIST_ITEM_START_PATTERN = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/;
// The same marker, matched in place at a line start: `y` anchors it at
// `lastIndex`, and `m` lets `^` match there because a newline precedes it.
const LIST_ITEM_START_AT_PATTERN = new RegExp(LIST_ITEM_START_PATTERN.source, "my");
// A section title: an ATX heading, or a line of only bold text, which models
// often use as a heading.
const SECTION_TITLE_PATTERN = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|\*\*(?:[^*]|\*(?!\*))+\*\*:?$)/;
// An unindented ATX heading ends the paragraph or list above it, even with no
// blank line between them. A bold line would continue the paragraph instead.
const TOP_LEVEL_HEADING_PATTERN = /^#{1,6}(?:[ \t]|$)/;

/**
 * Splits buffered assistant text at the last blank line, closing code fence,
 * or list item start that is not inside an open fenced code block. `ready` is
 * safe to deliver now because the markdown before it will not change shape as
 * more text arrives. `rest` stays buffered until the next boundary or
 * completion. Only fully terminated lines count, so a trailing partial line
 * never leaks; a list item start is the one lookahead that may sit on the
 * partial line, since tight lists have no blank lines between items and would
 * otherwise land all at once.
 *
 * A section title holds the boundary until a content line follows it, so a
 * title never lands alone and waits above a block that is still streaming.
 */
export function splitBufferedAssistantText(text: string): { ready: string; rest: string } {
  return splitAtBoundary(text, scanAssistantText(text, INITIAL_SCAN).boundary);
}

function splitAtBoundary(text: string, boundary: number): { ready: string; rest: string } {
  if (boundary === -1) {
    return { ready: "", rest: text };
  }
  return { ready: text.slice(0, boundary), rest: text.slice(boundary) };
}

/**
 * `LIST_ITEM_START_PATTERN` against the unterminated line at `lineStart`, with
 * trailing spaces, tabs and carriage returns trimmed as for complete lines.
 */
function partialLineStartsListItem(text: string, lineStart: number): boolean {
  let end = text.length;
  for (; end > lineStart; end -= 1) {
    const code = text.charCodeAt(end - 1);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0d) break;
  }
  LIST_ITEM_START_AT_PATTERN.lastIndex = lineStart;
  const match = LIST_ITEM_START_AT_PATTERN.exec(text);
  // Trimming only removes a trailing run, so the trimmed line matches exactly
  // when the in-place match ends inside it.
  return match !== null && lineStart + match[0].length <= end;
}

/** Scanner state after every fully terminated line before `lineStart`. */
interface AssistantTextScan {
  readonly lineStart: number;
  readonly openFence: { readonly marker: string; readonly indent: number } | null;
  readonly boundary: number;
  readonly titleAwaitingContent: boolean;
}

const INITIAL_SCAN: AssistantTextScan = {
  lineStart: 0,
  openFence: null,
  boundary: -1,
  titleAwaitingContent: false,
};

/**
 * Scans `text` from `start`, which must describe a prefix of `text`. Returns
 * the boundary, including the partial last line's list-item lookahead, and the
 * state to resume from once more text is appended.
 */
function scanAssistantText(
  text: string,
  start: AssistantTextScan,
): { boundary: number; resume: AssistantTextScan } {
  let { openFence, boundary, lineStart, titleAwaitingContent } = start;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const mayStartListItem = openFence === null && lineStart > 0 && !titleAwaitingContent;
    if (newline === -1) {
      // The partial last line is scanned again on every update, so check it
      // without copying it: a long paragraph would otherwise cost its length.
      return {
        boundary:
          mayStartListItem && partialLineStartsListItem(text, lineStart) ? lineStart : boundary,
        resume: { lineStart, openFence, boundary, titleAwaitingContent },
      };
    }
    const line = text.slice(lineStart, newline).replace(/[ \t\r]+$/, "");
    if (mayStartListItem && LIST_ITEM_START_PATTERN.test(line)) {
      boundary = lineStart;
    }
    const fenceMatch = MARKDOWN_FENCE_PATTERN.exec(line);
    if (fenceMatch) {
      const indent = fenceMatch[1]!.length;
      const marker = fenceMatch[2]!;
      if (openFence === null) {
        openFence = { marker, indent };
        titleAwaitingContent = false;
      } else if (
        marker[0] === openFence.marker[0] &&
        marker.length >= openFence.marker.length &&
        indent <= openFence.indent + 3 &&
        line.length === indent + marker.length
      ) {
        // CommonMark: a closing fence carries no info string.
        openFence = null;
        boundary = newline + 1;
      }
    } else if (openFence === null && BLANK_LINE_PATTERN.test(line) && lineStart > 0) {
      if (!titleAwaitingContent) {
        boundary = newline + 1;
      }
    } else if (openFence === null) {
      if (lineStart > 0 && !titleAwaitingContent && TOP_LEVEL_HEADING_PATTERN.test(line)) {
        boundary = lineStart;
      }
      titleAwaitingContent = SECTION_TITLE_PATTERN.test(line);
    }
    lineStart = newline + 1;
  }
}

/**
 * `splitBufferedAssistantText` for text that usually grows by appends. Resumes
 * from the last fully terminated line when the text still starts with it, so a
 * streaming message is not rescanned from the top on every update.
 */
function makeIncrementalAssistantTextSplitter() {
  let scanned = "";
  let resume = INITIAL_SCAN;
  return (text: string): { ready: string; rest: string } => {
    // Slice equality, not startsWith: V8 compares flat strings in bulk, which
    // keeps this check far cheaper than the scan it saves.
    const extendsScanned = text.slice(0, scanned.length) === scanned;
    const result = scanAssistantText(text, extendsScanned ? resume : INITIAL_SCAN);
    resume = result.resume;
    scanned = text.slice(0, resume.lineStart);
    return splitAtBoundary(text, result.boundary);
  };
}

/** Buffer assistant messages and reasoning alike, keeping unfinished markdown out of the read model. */
export function makeAssistantStreamingFilter(mode: ResponseStreamingMode) {
  const delivered = new Map<string, { text: string; at: number }>();
  const splitters = new Map<string, ReturnType<typeof makeIncrementalAssistantTextSplitter>>();
  return (
    event: ProviderAdapter.ProviderAdapterV2Event,
    now: number,
  ): ProviderAdapter.ProviderAdapterV2Event | null => {
    if (
      event.type === "node.updated" &&
      event.node.kind === "assistant_message" &&
      event.node.status === "running"
    )
      return null;
    const message =
      event.type === "message.updated" && event.message.role === "assistant"
        ? event.message
        : event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
          ? event.turnItem
          : null;
    if (!message) return event;
    const key = `${event.type}:${message.id}`;
    if (!message.streaming) {
      delivered.delete(key);
      splitters.delete(key);
      return event;
    }
    if (mode === "turn") return null;
    const previous = delivered.get(key);
    if (previous && now - previous.at < 400) return null;
    let split = splitters.get(key);
    if (split === undefined) {
      split = makeIncrementalAssistantTextSplitter();
      splitters.set(key, split);
    }
    const { ready } = split(message.text);
    if (!ready || ready === previous?.text) return null;
    delivered.set(key, { text: ready, at: now });
    if (event.type === "message.updated")
      return { ...event, message: { ...event.message, text: ready } };
    if (
      event.type === "turn_item.updated" &&
      (event.turnItem.type === "assistant_message" || event.turnItem.type === "reasoning")
    )
      return { ...event, turnItem: { ...event.turnItem, text: ready } };
    return event;
  };
}
