import { BRIEF_MAX_LINES } from "./types";

const HEADER_NAMES = [
  "Session Goal",
  "Files And Changes",
  "Commits",
  "Outstanding Context",
  "User Preferences",
] as const;

const SEPARATOR = "\n\n---\n\n";

// ─── Section Parsing ────────────────────────────────────────────────

/** Extract a named section's text (with header) from a formatted summary. */
const sectionOf = (text: string, header: string): string => {
  const tag = `[${header}]`;
  const start = text.indexOf(tag);
  if (start < 0) return "";
  const after = text.slice(start);

  // Find next section header or the brief separator
  const nextSections = HEADER_NAMES
    .filter((h) => h !== header)
    .map((h) => after.indexOf(`[${h}]`))
    .filter((n) => n > 0);
  const nextSep = after.indexOf(SEPARATOR);
  const candidates = [...nextSections, ...(nextSep > 0 ? [nextSep] : [])].sort((a, b) => a - b);
  const end = candidates[0];

  return (end ? after.slice(0, end) : after).trim();
};

/** Extract the brief transcript (everything after the `---` separator). */
const briefOf = (text: string): string => {
  const idx = text.indexOf(SEPARATOR);
  if (idx < 0) return "";
  return text.slice(idx + SEPARATOR.length).trim();
};

// ─── Header Merging ─────────────────────────────────────────────────

/** Filter out noise lines from dedup (no skill tags). */
const isClean = (l: string) =>
  l.startsWith("- ") && !l.includes("<skill") && !l.includes("</skill");

/**
 * Merge a single header section from previous and fresh summaries.
 *
 * - Outstanding Context: always use fresh (volatile).
 * - Files And Changes: merge by category, dedup paths.
 * - Session Goal / Commits: line dedup, cap at 8.
 * - User Preferences: line dedup, cap at 15.
 */
const mergeHeaderSection = (header: string, prev: string, fresh: string): string => {
  // Outstanding Context is volatile — always use fresh only
  if (header === "Outstanding Context") return fresh;
  if (!prev) return fresh;
  if (!fresh) return prev;

  if (header === "Files And Changes") {
    return mergeFileLines(prev, fresh);
  }

  // Session Goal, Commits, User Preferences: line-level dedup, cap
  const prevLines = prev.split("\n").filter(isClean);
  const freshLines = fresh.split("\n").filter(isClean);
  const combined = [...new Set([...prevLines, ...freshLines])];
  const CAP = header === "Session Goal" ? 8 : header === "Commits" ? 8 : 15;
  const capped = combined.length > CAP ? combined.slice(-CAP) : combined;
  if (capped.length === 0) return "";
  return `[${header}]\n${capped.join("\n")}`;
};

/**
 * Merge Files And Changes sections by category.
 * Parses "- Modified: a, b, c (+N more)" lines from both texts,
 * deduplicates paths, removes Created entries that appear in Modified,
 * and caps each category at 10 entries.
 */
const mergeFileLines = (prev: string, fresh: string): string => {
  const categories = ["Modified", "Created", "Read"] as const;
  const merged: Record<string, Set<string>> = {};
  for (const cat of categories) merged[cat] = new Set();

  for (const text of [prev, fresh]) {
    for (const line of text.split("\n")) {
      for (const cat of categories) {
        const prefix = `- ${cat}: `;
        if (!line.startsWith(prefix)) continue;
        let rest = line.slice(prefix.length);
        // Strip "(+N more)" suffix
        rest = rest.replace(/\s*\(\+\d+ more\)\s*$/, "");
        for (const p of rest.split(",")) {
          const trimmed = p.trim();
          if (trimmed) merged[cat].add(trimmed);
        }
      }
    }
  }

  // Dedup: a file in Modified (existing) can't also be Created
  for (const p of merged.Modified) merged.Created.delete(p);

  const capLines = (set: Set<string>, limit: number): string => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  const lines: string[] = [];
  if (merged.Modified.size > 0) lines.push(`- Modified: ${capLines(merged.Modified, 10)}`);
  if (merged.Created.size > 0) lines.push(`- Created: ${capLines(merged.Created, 10)}`);
  if (merged.Read.size > 0) lines.push(`- Read: ${capLines(merged.Read, 10)}`);
  if (lines.length === 0) return "";
  return `[Files And Changes]\n${lines.join("\n")}`;
};

// ─── Brief Transcript Merging ───────────────────────────────────────

const briefLineCount = (text: string): number =>
  text ? text.split("\n").length : 0;

/**
 * Cap `text` to `maxLines` keeping the tail, rewinding to the nearest
 * section header to avoid opening mid-section.
 */
const capBriefToLineBudget = (text: string, maxLines: number): string => {
  if (!text || maxLines <= 0) return "";
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(-maxLines);
  const firstHeader = kept.findIndex((l) => /^\[.+\]/.test(l));
  const clean = firstHeader > 0 ? kept.slice(firstHeader) : kept;
  const omitted = lines.length - clean.length;
  return `...(${omitted} earlier lines omitted)\n\n${clean.join("\n")}`;
};

/**
 * Merge two brief transcripts with a priority budget:
 * fresh keeps everything, previous gets the remaining BRIEF_MAX_LINES budget.
 */
const mergeBriefTranscriptWithFreshBudget = (prev: string, fresh: string): string => {
  if (!prev) return fresh;
  if (!fresh) return capBriefToLineBudget(prev, BRIEF_MAX_LINES);

  const freshLines = briefLineCount(fresh);
  const remainingPrevLines = Math.max(0, BRIEF_MAX_LINES - freshLines);
  const prevTail = capBriefToLineBudget(prev, remainingPrevLines);
  return prevTail ? `${prevTail}\n\n${fresh}` : fresh;
};

// ─── Main ───────────────────────────────────────────────────────────

/**
 * Merge a new summary with a prior pi-vcc summary for cumulative tracking
 * across compactions.
 *
 * - Header sections are merged by name with dedup and caps.
 * - Outstanding Context always uses fresh (volatile).
 * - The brief transcript gives priority budget to fresh content.
 * - If `previousSummary` is empty/undefined, returns `freshSummary` unchanged.
 */
export const mergeWithPrevious = (previousSummary: string, freshSummary: string): string => {
  if (!previousSummary) return freshSummary;

  // Merge header sections
  const headers = HEADER_NAMES
    .map((header) => {
      const freshSec = sectionOf(freshSummary, header);
      const prevSec = sectionOf(previousSummary, header);
      return mergeHeaderSection(header, prevSec, freshSec);
    })
    .filter(Boolean);

  // Merge brief transcript
  const prevBrief = briefOf(previousSummary);
  const freshBrief = briefOf(freshSummary);
  const mergedBrief = mergeBriefTranscriptWithFreshBudget(prevBrief, freshBrief);

  const parts: string[] = [];
  if (headers.length > 0) {
    parts.push(headers.join("\n\n"));
  }
  if (mergedBrief) {
    parts.push(mergedBrief);
  }

  return parts.join(SEPARATOR);
};
