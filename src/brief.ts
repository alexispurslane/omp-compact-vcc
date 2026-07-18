import { NormalizedBlock, BRIEF_MAX_LINES } from "./types";

// ── helpers ──

/** Unicode-aware word-boundary character clip. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf(" ", max);
  const end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) return text.slice(0, end - 1);
  }
  return text.slice(0, end);
};

// ── bash compression ──

const CD_PREFIX_RE = /^cd\s+\S+\s*&&\s*/;
const PIPE_TAIL_RE = /\s*\|\s*(?:head|tail|sort|wc|column|tr|cut|awk|uniq)(?:\s[^|]*)?$/;
const BASH_CAP = 240;

const compressBash = (cmd: string): string => {
  let result = cmd.trim();
  result = result.replace(CD_PREFIX_RE, "").trim();
  // Collapse pipe tails — remove up to 3 levels
  for (let i = 0; i < 3; i++) {
    const stripped = result.replace(PIPE_TAIL_RE, "").trim();
    if (stripped === result) break;
    result = stripped;
  }
  if (result.length > BASH_CAP) {
    result = result.slice(0, BASH_CAP - 3) + "...";
  }
  return result;
};

// ── significant word counting ──

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

interface CharSpan {
  start: number;
  end: number;
}

const significantWordSpans = (text: string): CharSpan[] => {
  const words: CharSpan[] = [];
  for (const seg of segmenter.segment(text)) {
    if (!seg.isWordLike) continue;
    if (STOP_WORDS.has(seg.segment.toLowerCase())) continue;
    words.push({ start: seg.index, end: seg.index + seg.segment.length });
  }
  return words;
};

// ── truncation ──

/** Normalize whitespace for token-aware truncation. */
const normalizeText = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const USER_CHAR_LIMIT = 256;

const truncateUserText = (text: string): string => {
  const flat = normalizeText(text);
  return clip(flat, USER_CHAR_LIMIT);
};

const ASSISTANT_HEAD_WORDS = 80;
const ASSISTANT_TAIL_WORDS = 120;
const SEGMENT_CLOSING_HEAD_WORDS = 120;
const SEGMENT_CLOSING_TAIL_WORDS = 120;

const truncateHeadTail = (raw: string, headLimit: number, tailLimit: number): string => {
  const flat = normalizeText(raw);
  const words = significantWordSpans(flat);
  if (words.length <= headLimit + tailLimit) return flat;
  const head = flat.slice(0, words[headLimit - 1].end).trimEnd();
  const tail = flat.slice(words[words.length - tailLimit].start).trimStart();
  return `${head}\n...(middle truncated)...\n${tail}`;
};

// ── self-talk stripping ──

const SELF_TALK_PREFIX_RE = /^\s*(?:hmm|wait|actually|oh|okay|ok|well|so)[,.!\s-]+/i;

const stripSelfTalk = (text: string): string => {
  let result = text;
  for (let i = 0; i < 2; i++) {
    const stripped = result.replace(SELF_TALK_PREFIX_RE, "");
    if (stripped === result) break;
    result = stripped;
  }
  return result;
};

// ── segment detection ──

/**
 * Find the next non-tool_result block after `index`.
 */
const nextRenderableBlock = (blocks: NormalizedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_result") return blocks[i];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks: NormalizedBlock[], index: number): boolean => {
  if (blocks[index]?.kind !== "assistant") return false;
  const next = nextRenderableBlock(blocks, index);
  return !next || next.kind === "user";
};

// ── tool one-liner ──

const TOOL_CAP = 60;

/** Match tool name to its primary displayed field, case-insensitive. */
const TOOL_SUMMARY_FIELDS: Record<string, string> = {
  Read: "file_path", Edit: "file_path", Write: "file_path",
  read: "file_path", edit: "file_path", write: "file_path",
  Glob: "pattern", Grep: "pattern",
};

/** Capitalize first letter for display. */
const displayName = (name: string): string =>
  name.charAt(0).toUpperCase() + name.slice(1);

const toolOneLiner = (name: string, args: Record<string, unknown>): string => {
  const display = displayName(name);

  // Primary field lookup
  const field = TOOL_SUMMARY_FIELDS[name];
  if (field && typeof args[field] === "string") {
    const val = args[field] as string;
    const clipped = val.length > TOOL_CAP ? val.slice(0, TOOL_CAP - 3) + "..." : val;
    return `* ${display} "${clipped}"`;
  }

  // Bash tool calls: use command field
  if (display === "Bash" && typeof args.command === "string") {
    const cmd = (args.command as string);
    const clipped = cmd.length > TOOL_CAP ? cmd.slice(0, TOOL_CAP - 3) + "..." : cmd;
    return `* Bash "${clipped}"`;
  }

  // Fallback: try query field (for Grep with "query" key)
  if (typeof args.query === "string") {
    const q = (args.query as string);
    const clipped = q.length > TOOL_CAP ? q.slice(0, TOOL_CAP - 3) + "..." : q;
    return `* ${display} "${clipped}"`;
  }

  return `* ${display}`;
};

// ── main ──

/**
 * Build an inline transcript from the most significant blocks.
 * This is the "brief" section that appears below the --- separator in summaries.
 */
export function buildBriefTranscript(blocks: NormalizedBlock[]): string {
  // Each entry is a line of output (header or content).
  const out: string[] = [];
  let lastHeader = "";

  /** Append header only when switching to a new section, then push content line(s). */
  const emit = (header: string, lines: string[]) => {
    if (header !== lastHeader) {
      if (out.length > 0) out.push(""); // blank line between sections
      out.push(header);
      lastHeader = header;
    }
    for (const line of lines) {
      out.push(line);
    }
  };

  /** Prepare content lines with optional ref suffix on the last line. */
  const contentLines = (text: string, ref: string): string[] => {
    const lines = text.split("\n");
    if (ref && lines.length > 0) {
      const lastIdx = lines.length - 1;
      lines[lastIdx] = `${lines[lastIdx]}${ref}`;
    }
    return lines;
  };

  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
    const b = blocks[blockIndex];
    const ref = b.sourceIndex != null ? ` (#${b.sourceIndex})` : "";

    switch (b.kind) {
      case "user": {
        const text = b.text.trim();
        if (!text) break;
        const truncated = truncateUserText(text);
        emit("[user]", contentLines(truncated, ref));
        break;
      }

      case "bash": {
        const cmd = b.command ? compressBash(b.command) : "";
        if (!cmd) break;
        emit("[user]", contentLines(`$ ${cmd}`, ref));
        break;
      }

      case "assistant": {
        let raw = b.text;
        raw = stripSelfTalk(raw);
        const headTail = isSegmentClosingAssistant(blocks, blockIndex)
          ? { head: SEGMENT_CLOSING_HEAD_WORDS, tail: SEGMENT_CLOSING_TAIL_WORDS }
          : { head: ASSISTANT_HEAD_WORDS, tail: ASSISTANT_TAIL_WORDS };
        const text = truncateHeadTail(raw, headTail.head, headTail.tail);
        if (text) {
          emit("[assistant]", contentLines(text, ref));
        }
        break;
      }

      case "tool_call": {
        if (!b.name || b.name.trim() === "") break;
        const line = toolOneLiner(b.name, b.args ?? {}) + ref;
        emit("[assistant]", [line]);
        break;
      }

      case "tool_result":
        // Tool results are too noisy for the brief; skip entirely.
        break;
    }
  }

  // Cap total output to BRIEF_MAX_LINES from the bottom.
  if (out.length > BRIEF_MAX_LINES) {
    const omitted = out.length - BRIEF_MAX_LINES;
    const tail = out.slice(out.length - BRIEF_MAX_LINES);
    return `...(${omitted} earlier lines omitted)\n\n${tail.join("\n")}`;
  }

  return out.join("\n");
}
