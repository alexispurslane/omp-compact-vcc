import { BRIEF_MAX_LINES, type SectionData } from "./types";

const TUI_SAFE_LINE_CHARS = 120;

/** Wrap a single line at maxChars, breaking on word boundaries. */
const wrapLine = (line: string, maxChars: number): string[] => {
  if (line.length <= maxChars) return [line];

  // Detect leading bullet/number prefix for continuation indentation
  const indent = line.match(/^\s*(?:[-*]\s+|\d+\.\s+)?/)?.[0] ?? "";
  const continuationIndent = indent ? " ".repeat(Math.min(indent.length, 8)) : "";
  const wrapped: string[] = [];
  let remaining = line;
  let prefix = "";

  while (prefix.length + remaining.length > maxChars) {
    const available = Math.max(20, maxChars - prefix.length);
    let splitAt = remaining.lastIndexOf(" ", available);
    // Fallback: hard-split if no good word boundary in first half
    if (splitAt < Math.floor(available * 0.5)) splitAt = available;

    wrapped.push(prefix + remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
    prefix = continuationIndent;
  }

  if (remaining) wrapped.push(prefix + remaining);
  return wrapped;
};

/** Wrap every line in `text` at maxChars, preserving existing line breaks. */
const wrapLongLines = (text: string, maxChars = TUI_SAFE_LINE_CHARS): string =>
  text.split("\n").flatMap((line) => wrapLine(line, maxChars)).join("\n");

/** Build a section block: `[Title]\n- item1\n- item2`. Returns "" if items empty. */
const section = (title: string, items: string[]): string => {
  if (items.length === 0) return "";
  const body = items.map((i) => `- ${i}`).join("\n");
  return `[${title}]\n${body}`;
};

/**
 * Cap brief transcript to BRIEF_MAX_LINES, keeping the tail.
 * If the tail starts mid-section, rewind to the nearest section header
 * so the brief never opens in the middle of a header block.
 */
const capBrief = (text: string): string => {
  const lines = text.split("\n");
  if (lines.length <= BRIEF_MAX_LINES) return text;
  const omitted = lines.length - BRIEF_MAX_LINES;
  const kept = lines.slice(-BRIEF_MAX_LINES);
  // Rewind to first section header to avoid cutting mid-section
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

/**
 * Assemble the final structured summary string from SectionData.
 *
 * - Empty sections are skipped entirely.
 * - Sections are separated by double newline.
 * - The brief transcript is separated from header sections by `\n\n---\n\n`.
 * - Long lines are wrapped at 120 characters.
 * - The brief transcript is capped to BRIEF_MAX_LINES (120) from the bottom.
 */
export const formatSummary = (data: SectionData): string => {
  const headerParts = [
    section("Session Goal", data.sessionGoal),
    section("Files And Changes", data.filesAndChanges),
    section("Commits", data.commits),
    section("Outstanding Context", data.outstandingContext),
    section("User Preferences", data.userPreferences),
  ].filter(Boolean);

  const parts: string[] = [];
  if (headerParts.length > 0) {
    parts.push(headerParts.join("\n\n"));
  }
  if (data.briefTranscript) {
    parts.push(capBrief(data.briefTranscript));
  }

  if (parts.length === 0) return "";
  return wrapLongLines(parts.join("\n\n---\n\n"));
};
