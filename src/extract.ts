import type { NormalizedBlock, SectionData } from "./types";

// ── Helpers ──

function nonEmptyLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "\u2026";
}

function clipSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const m = cut.match(/.*[.!?]\s/);
  return m ? m[0].trim() : cut.slice(0, max - 1) + "\u2026";
}

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+\.)\s+/, "").trim();
}

function extractPath(args: Record<string, unknown> | undefined): string | null {
  if (!args) return null;
  for (const key of ["path", "file_path", "filePath", "file"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

// ── Constants ──

const SCOPE_CHANGE_RE =
  /\b(instead|actually|change of plan|forget that|new task|switch to|now I want|pivot|let'?s do|stop .* and)\b/i;

const TASK_RE =
  /\b(fix|implement|add|create|build|refactor|debug|investigate|update|remove|delete|migrate|deploy|test|write|set up)\b/i;

const NOISE_SHORT_RE = /^(ok|yes|no|sure|yeah|yep|go|hi|hey|thx|thanks|ok\b.*|y|n|k)\s*[.!?]*$/i;

const NON_GOAL_RE =
  /^\s*[\[│├└─╭╰]|```|^\s*(=[A-Z]+\(|function |const |let |var |import |export |class )|^(https?:|file:|\/[A-Za-z])|\\n|^\s*For each\b|\bin full\b[^\n]*\b(comments|issue|issues|PRs?|linked)\b/;

const TEMPLATE_SIGNAL_RE =
  /^\s*(For each\b|Do NOT implement\b|Analyze and propose\b|If Task\/context\b|Output:\s*$)/i;

function truncateAtTemplate(lines: string[]): string[] {
  const idx = lines.findIndex((l) => TEMPLATE_SIGNAL_RE.test(l));
  return idx >= 0 ? lines.slice(0, idx) : lines;
}

const BLOCKER_RE =
  /\b(fail(ed|s|ure|ing)?|broken|cannot|can't|won't work|does not work|doesn't work|still (broken|failing|wrong)|blocked|blocker|not (fixed|resolved|working)|crash(es|ed|ing)?)\b/i;

const PREF_PATTERNS = [
  /\bprefer(?:s|red|ring)?\s+\w/i,
  /\bdon'?t want\b/i,
  /\balways (?:use|do|run|prefer|keep|make|format|write|add|set|put|prefix|start|include|append)\b/i,
  /\bnever (?:use|do|run|push|commit|write|ignore|add|set|put|remove|delete|include|deploy)\b/i,
  /\bplease (?:use|avoid|keep|make|don'?t|do not|format|write)\b/i,
  /\b(?:style|format|language|naming)\s*[:=]\s*\S/i,
];

const FILE_READ_TOOLS = new Set(["Read", "read_file", "View"]);
const FILE_WRITE_TOOLS = new Set(["Edit", "Write", "edit", "write", "edit_file", "write_file", "MultiEdit"]);
const FILE_CREATE_TOOLS = new Set(["Write", "write", "write_file"]);

const COMMIT_MSG_RE = /git\s+commit[^\n]*?-m\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\$?'((?:[^'\\]|\\.)*)')/;
const GIT_HASH_RE = /\b([0-9a-f]{7,12})\b/;

// ── Skill collapse: strip <skill>...</skill> wrappers ──

function collapseSkillLines(lines: string[]): string[] {
  return lines.map((l) => l
    .replace(/<skill[^>]*>[\s\S]*?<\/skill>/g, "")
    .replace(/<skill[^>]*\/>/g, "")
  ).filter((l) => l.trim().length > 0);
}

// ── extractGoals ──

const MAX_GOAL_CHARS = 200;
const LEADING_CHARS = 200;

function isSubstantiveGoal(text: string): boolean {
  const t = text.trim();
  if (t.length <= 5) return false;
  if (t.length > MAX_GOAL_CHARS) return false;
  if (NOISE_SHORT_RE.test(t)) return false;
  if (NON_GOAL_RE.test(t)) return false;
  return true;
}

function extractGoals(blocks: NormalizedBlock[]): string[] {
  const goals: string[] = [];
  let latestScopeChange: string[] | null = null;

  for (const b of blocks) {
    if (b.kind !== "user") continue;
    const rawLines = nonEmptyLines(b.text);
    const truncated = truncateAtTemplate(rawLines);
    const lines = collapseSkillLines(truncated.filter(isSubstantiveGoal))
      .map(stripBullet)
      .filter((l) => l.length > 5);
    if (lines.length === 0) continue;

    if (goals.length === 0) {
      goals.push(...lines.slice(0, 6));
      continue;
    }

    // Test scope-change / task intent only on the leading portion
    // so pasted output below the instruction does not trigger matches.
    const leading = b.text.slice(0, LEADING_CHARS);
    if (SCOPE_CHANGE_RE.test(leading)) {
      latestScopeChange = lines.slice(0, 3).map((l) => clip(l, MAX_GOAL_CHARS));
    } else if (TASK_RE.test(leading) && lines[0].length > 15) {
      latestScopeChange = lines.slice(0, 2).map((l) => clip(l, MAX_GOAL_CHARS));
    }
  }

  if (latestScopeChange && latestScopeChange.length > 0) {
    goals.push("[Scope change]", ...latestScopeChange);
  }

  return goals.slice(0, 8);
}

// ── extractFiles ──

interface FileActivity {
  read: Set<string>;
  modified: Set<string>;
  created: Set<string>;
}

function extractFiles(
  blocks: NormalizedBlock[],
  fileOps?: { readFiles?: string[]; modifiedFiles?: string[]; createdFiles?: string[] },
): FileActivity {
  const act: FileActivity = {
    read: new Set(fileOps?.readFiles ?? []),
    modified: new Set(fileOps?.modifiedFiles ?? []),
    created: new Set(fileOps?.createdFiles ?? []),
  };

  for (const b of blocks) {
    if (b.kind !== "tool_call") continue;
    const p = extractPath(b.args);
    if (!p || !b.name) continue;

    if (FILE_READ_TOOLS.has(b.name)) act.read.add(p);
    if (FILE_WRITE_TOOLS.has(b.name)) act.modified.add(p);
    if (FILE_CREATE_TOOLS.has(b.name)) act.created.add(p);
  }

  const all = [...act.read, ...act.modified, ...act.created];
  const prefix = longestCommonDirPrefix(all);
  if (prefix) {
    act.read = trimPaths(act.read, prefix);
    act.modified = trimPaths(act.modified, prefix);
    act.created = trimPaths(act.created, prefix);
  }

  return act;
}

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
  if (i < 2) return "";
  return split[0].slice(0, i).join("/") + "/";
}

function trimPaths(set: Set<string>, prefix: string): Set<string> {
  if (!prefix) return set;
  const out = new Set<string>();
  for (const p of set) out.add(p.startsWith(prefix) ? p.slice(prefix.length) : p);
  return out;
}

function formatFileActivity(
  blocks: NormalizedBlock[],
  fileOps?: FileOpsInput,
): string[] {
  const act = extractFiles(blocks, fileOps);
  // Dedup: if already Modified, drop from Created
  for (const p of act.modified) act.created.delete(p);
  const lines: string[] = [];
  const cap = (set: Set<string>, limit: number) => {
    const arr = [...set];
    if (arr.length <= limit) return arr.join(", ");
    return arr.slice(0, limit).join(", ") + ` (+${arr.length - limit} more)`;
  };
  if (act.modified.size > 0) lines.push(`Modified: ${cap(act.modified, 10)}`);
  if (act.created.size > 0) lines.push(`Created: ${cap(act.created, 10)}`);
  if (act.read.size > 0) lines.push(`Read: ${cap(act.read, 10)}`);
  return lines;
}

// ── extractBlockers ──

function extractBlockers(blocks: NormalizedBlock[]): string[] {
  const items: string[] = [];
  const tail = blocks.slice(-20);

  for (const b of tail) {
    if (b.kind !== "assistant" && b.kind !== "user") continue;

    for (const line of nonEmptyLines(b.text)) {
      if (!BLOCKER_RE.test(line)) continue;
      if (line.length < 15) continue;
      if (/^\s*[-*+>]\s/.test(line)) continue;
      if (/^\s*\(/.test(line)) continue;
      if (!/^\s*["'`*_]?[A-Z`]/.test(line)) continue;

      const clipped =
        b.kind === "user"
          ? `[user] ${clipSentence(line, 150)}`
          : clipSentence(line, 150);

      if (!items.includes(clipped)) items.push(clipped);
      break; // first blocker line per block only
    }
  }

  return items.slice(0, 5);
}

// ── extractCommits ──

interface CommitInfo {
  hash?: string;
  message: string;
}

function cleanMessage(msg: string): string {
  return msg.replace(/\\"/g, '"').replace(/\\'/g, "'").trim();
}

function extractCommits(blocks: NormalizedBlock[]): string[] {
  const commits: CommitInfo[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.kind !== "tool_call" || b.name !== "bash") continue;
    const cmd = typeof b.args?.command === "string" ? b.args.command : "";
    if (!/\bgit\s+commit\b/.test(cmd)) continue;
    const m = cmd.match(COMMIT_MSG_RE);
    if (!m) continue;
    const message = cleanMessage(m[1] ?? m[2] ?? m[3] ?? "").split("\n")[0].trim();
    if (!message) continue;

    let hash: string | undefined;
    for (let j = i + 1; j < Math.min(blocks.length, i + 3); j++) {
      const r = blocks[j];
      if (r.kind !== "tool_result") continue;
      const bracket = r.text.match(/\[\S+\s+([0-9a-f]{7,12})\]/);
      if (bracket) { hash = bracket[1]; break; }
      const range = r.text.match(/\b([0-9a-f]{7,12})\.\.([0-9a-f]{7,12})\b/);
      if (range) { hash = range[2]; break; }
      const plain = r.text.match(GIT_HASH_RE);
      if (plain) { hash = plain[1]; break; }
    }

    const key = `${hash ?? ""}::${message}`;
    if (!commits.some((c) => `${c.hash ?? ""}::${c.message}` === key)) {
      commits.push({ hash, message });
    }
  }

  return commits.slice(-8).map((c) => c.hash ? `${c.hash}: ${c.message}` : c.message);
}

// ── extractPreferences ──

function extractPreferences(blocks: NormalizedBlock[]): string[] {
  const prefs: string[] = [];
  const seen = new Set<string>();

  for (const b of blocks) {
    if (b.kind !== "user") continue;

    let perBlock = 0;
    for (const line of nonEmptyLines(b.text)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length < 5) continue;
      if (trimmed.length > 200) continue;
      if (trimmed.endsWith("?") || trimmed.includes("?...")) continue;
      if (!PREF_PATTERNS.some((p) => p.test(trimmed))) continue;

      const clipped = clip(trimmed, 200);
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      prefs.push(clipped);

      if (++perBlock >= 1) break;
    }
  }

  return prefs.slice(0, 10);
}

function dedupPreferencesAgainstGoals(prefs: string[], goals: string[]): string[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const goalSet = new Set(goals.map(norm));
  return prefs.filter((p) => !goalSet.has(norm(p)));
}

// ── extractSections (public export) ──

export interface FileOpsInput {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export function extractSections(
  blocks: NormalizedBlock[],
  fileOps?: FileOpsInput,
): SectionData {
  const sessionGoal = extractGoals(blocks);
  const userPreferences = dedupPreferencesAgainstGoals(
    extractPreferences(blocks),
    sessionGoal,
  );

  return {
    sessionGoal,
    outstandingContext: extractBlockers(blocks),
    filesAndChanges: formatFileActivity(blocks, fileOps),
    commits: extractCommits(blocks),
    userPreferences,
    briefTranscript: "", // built later by brief module
  };
}
