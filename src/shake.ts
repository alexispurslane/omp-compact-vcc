import {
  type SessionEntry,
  TOOL_RESULT_MAX_CHARS,
  TOOL_RESULT_HEAD_RATIO,
} from "./types";

/**
 * Extract plain text from an unknown-content field.
 * Handles strings and OpenAI-style content arrays.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block: unknown): block is { type: string; text?: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text",
      )
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Truncate a long string to head + tail with a truncation marker.
 */
function truncateHeadTail(text: string): string {
  const headLen = Math.round(TOOL_RESULT_MAX_CHARS * TOOL_RESULT_HEAD_RATIO);
  const tailLen = TOOL_RESULT_MAX_CHARS - headLen;
  const head = text.slice(0, headLen);
  const tail = text.slice(-tailLen);
  return head + "\n...(truncated)...\n" + tail;
}

/**
 * Replace `message.content` with truncated text, preserving the original type
 * structure.
 */
function setTruncatedContent(
  msg: { content: unknown; role?: string },
  originalText: string,
  truncated: string,
): void {
  const c = msg.content;
  if (typeof c === "string") {
    msg.content = truncated;
  } else if (Array.isArray(c)) {
    // Rebuild the array, replacing text blocks inline.
    msg.content = c.map((block: unknown) => {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        return { ...(block as Record<string, unknown>), text: truncated };
      }
      return block;
    });
  } else {
    // Unsupported shape – just store as plain string.
    msg.content = truncated;
  }
}

/**
 * Shake tool-result messages in the kept tail, pruning overly long content
 * to head + tail + truncation marker.
 *
 * Mutates `branchEntries` in-place.
 */
export function shakeTail(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
): void {
  // Sentinel "" means compact-all – no tail to shake.
  if (!firstKeptEntryId) return;

  // Locate the first kept entry.
  const startIdx = branchEntries.findIndex(
    (e) => e.id === firstKeptEntryId,
  );
  if (startIdx < 0) return; // Not found – nothing to do.

  for (let i = startIdx; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" && msg.role !== "tool_result") continue;

    const text = extractText(msg.content);
    if (text.length <= TOOL_RESULT_MAX_CHARS) continue;

    const truncated = truncateHeadTail(text);
    setTruncatedContent(msg, text, truncated);
  }
}
