import type { NormalizedBlock, SectionData } from "./types";

// ---------------------------------------------------------------------------
// Helpers (inlined — no ./content module in this project)
// ---------------------------------------------------------------------------

/** Split text into non-empty trimmed lines. */
function nonEmptyLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Clip a string to at most `max` characters (preferring a clean cut). */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

const SENTENCE_BREAK = /[.!?]\s/;

/** Clip to at most `max` chars, ending at a sentence boundary if possible. */
function clipSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const truncated = text.slice(0, max);
  const m = truncated.match(SENTENCE_BREAK);
  if (m && m.index !== undefined && m.index + m[0].length <= truncated.length) {
    return truncated.slice(0, m.index + 1);
  }
  return truncated;
}

/** Extract a file path from tool-call args. Checks known key names in order. */
function extractPath(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Constants used across extractors
// ---------------------------------------------------------------------------

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const NOISE_SHORT_RE =
  /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

const NON_GOAL_RE =
  /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n/;

const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const HASH_RE = /\b[0-9a-f]{7,40}\b/g;

const PREFERENCE_RE =
  /\b(prefer|always|never|don't|use .* instead of|rather than)\b/i;

const FILE_READ_TOOLS: Record<string, true> = {
  Read: true,
  read_file: true,
  View: true,
};
const FILE_WRITE_TOOLS: Record<string, true> = {
  Edit: true,
  Write: true,
  edit: true,
  write: true,
  edit_file: true,
  write_file: true,
  MultiEdit: true,
};
const FILE_CREATE_TOOLS: Record<string, true> = {
  Write: true,
  write: true,
  write_file: true,
};

// ---------------------------------------------------------------------------
// 1. extractGoals (private)
// ---------------------------------------------------------------------------

function extractGoals(blocks: NormalizedBlock[]): string[] {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    const lines = nonEmptyLines(b.text)
      .filter(isSubstantiveGoal)
      .map((l) => l.replace(BULLET_RE, "").trim())
      .filter((l) => l.length > 5);

    if (lines.length === 0) continue;

    if (goals.length === 0) {
      // First user block — capture up to 6 goals
      goals.push(...lines.slice(0, 6));
      continue;
    }

    // Later user blocks — only if scope-change or task-intent language
    const text = b.text;
    const isScopeChange = SCOPE_CHANGE_RE.test(text);
    const isTaskIntent =
      !isScopeChange && TASK_RE.test(text) && lines[0].length > 15;

    if (isScopeChange) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, 200));
    } else if (isTaskIntent) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, 200));
    }
  }

  // Emit [Scope change] marker if we captured new bullets
  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]", ...latestScopeChange);
  }

  return goals.slice(0, 8);
}

function isSubstantiveGoal(text: string): boolean {
  const t = text.trim();
  if (t.length <= 5 || t.length > 200) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
}



// ---------------------------------------------------------------------------
// 2. extractFiles (private)
// ---------------------------------------------------------------------------

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

function extractFiles(blocks: NormalizedBlock[]): FileActivity {
  const act: FileActivity = {
    read: new Set(),
    modified: new Set(),
    created: new Set(),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p) continue;

    if (b.name && FILE_READ_TOOLS[b.name]) act.read.add(p);
    if (b.name && FILE_WRITE_TOOLS[b.name]) act.modified.add(p);
    if (b.name && FILE_CREATE_TOOLS[b.name]) act.created.add(p);
  }

  // Dedup: if file is in modifiedFiles, remove from createdFiles
  for (const p of act.modified) {
    act.created.delete(p);
  }

  // Group by longest common directory prefix
  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
}

/**
 * Find the longest common directory prefix among absolute paths.
 * Returns "" if fewer than 2 absolute paths or no meaningful common prefix.
 * Requires at least /a/b common (2 path segments).
 */
function longestCommonDirPrefix(paths: string[]): string {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length < 2) return "";
  const split = abs.map((p) => p.split("/"));
  const min = Math.min(...split.map((s) => s.length));
  let i = 0;
  while (i < min - 1) {
    const seg = split[0][i];
    if (!split.every((s) => s[i] === seg)) break;
    i++;
  }
  if (i < 2) return ""; // require at least /a/b common
  return split[0].slice(0, i).join("/") + "/";
}

function trimPaths(set: Set<string>, prefix: string): Set<string> {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) {
    out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. formatFileActivity (private — builds the string[] for SectionData)
// ---------------------------------------------------------------------------

function formatFileActivity(blocks: NormalizedBlock[]): string[] {
  const act = extractFiles(blocks);
  const lines: string[] = [];

  const cap = (set: Set<string>, limit: number): string => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };

  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);

  return lines;
}

// ---------------------------------------------------------------------------
// 4. extractBlockers (private)
// ---------------------------------------------------------------------------

function extractBlockers(blocks: NormalizedBlock[]): string[] {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind !== "assistant" && b.kind !== "user") continue;

    for (const line of nonEmptyLines(b.text)) {
      if (!BLOCKER_RE.test(line)) continue;
      if (line.length < 15) continue;
      // Skip continuation fragments (sub-bullets, parentheticals)
      if (/^\s*[-*+>]\s/.test(line)) continue;
      if (/^\s*\(/.test(line)) continue;
      // Require sentence-like start: capital letter, code identifier, or quote
      if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;

      const clipped =
        b.kind === "user"
          ? `[user] ${clipSentence(line, 150)}`
          : clipSentence(line, 150);

      if (!items.includes(clipped)) items.push(clipped);
    }
  }

  return items.slice(0, 5);
}

// ---------------------------------------------------------------------------
// 5. extractCommits (private)
// ---------------------------------------------------------------------------

function extractCommits(blocks: NormalizedBlock[]): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const b of blocks) {
    const text = b.text;
    let m: RegExpExecArray | null;

    // Reset lastIndex
    HASH_RE.lastIndex = 0;

    while ((m = HASH_RE.exec(text)) !== null) {
      const hash = m[0];
      if (seen.has(hash)) continue;
      seen.add(hash);

      // Grab the line containing the hash for context
      const lineStart = text.lastIndexOf("\n", m.index) + 1;
      const lineEnd = text.indexOf("\n", m.index);
      const line = text.slice(
        lineStart,
        lineEnd === -1 ? undefined : lineEnd,
      );

      // Extract brief description: first sentence or up to 80 chars
      const hashIdx = line.indexOf(hash);
      const afterHash = line.slice(hashIdx + hash.length).trim();
      const desc = afterHash
        ? clipSentence(afterHash, 80)
        : "(no context)";

      const entry = `${hash.slice(0, 7)} ${desc}`;
      results.push(entry);

      if (results.length >= 8) break;
    }

    if (results.length >= 8) break;
  }

  return results;
}

// ---------------------------------------------------------------------------
// 6. extractPreferences (private)
// ---------------------------------------------------------------------------

function extractPreferences(blocks: NormalizedBlock[]): string[] {
  const prefs: string[] = [];

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    for (const line of nonEmptyLines(b.text)) {
      if (!PREFERENCE_RE.test(line)) continue;
      if (line.length <= 20) continue;

      const cleaned = line.replace(BULLET_RE, "").trim();
      if (cleaned.length <= 20) continue;
      if (prefs.includes(cleaned)) continue;

      prefs.push(cleaned);
      if (prefs.length >= 15) break;
    }

    if (prefs.length >= 15) break;
  }

  return prefs;
}

// ---------------------------------------------------------------------------
// 7. extractSections (public — main export)
// ---------------------------------------------------------------------------

export function extractSections(blocks: NormalizedBlock[]): SectionData {
  const sessionGoal = extractGoals(blocks);
  const outstandingContext = extractBlockers(blocks);
  const filesAndChanges = formatFileActivity(blocks);
  const commits = extractCommits(blocks);
  const userPreferences = extractPreferences(blocks);

  return {
    sessionGoal,
    outstandingContext,
    filesAndChanges,
    commits,
    userPreferences,
    briefTranscript: "", // built by the brief module later
  };
}
