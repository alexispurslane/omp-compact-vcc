// Shared types for omp-compact-vcc
// All module subagents: use these types as your contract.

export interface NormalizedBlock {
  kind: "user" | "assistant" | "tool_call" | "tool_result" | "bash";
  text: string;
  sourceIndex?: number;
  // tool_call specific
  name?: string;
  args?: Record<string, unknown>;
  // bash specific
  command?: string;
  output?: string;
  exitCode?: number;
}

export interface SectionData {
  sessionGoal: string[];
  outstandingContext: string[];
  filesAndChanges: string[];
  commits: string[];
  userPreferences: string[];
  briefTranscript: string;
}

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  keptTokensEst: number;
}

// Session entry types (what getBranch() returns)
export interface SessionMessage {
  role: string;
  content: unknown;
  provider?: string;
  model?: string;
  usage?: unknown;
  timestamp?: number;
}

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: SessionMessage;
  // compaction specific
  summary?: string;
  shortSummary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: unknown;
  preserveData?: unknown;
  fromExtension?: boolean;
  // custom
  customType?: string;
  data?: unknown;
}

// Smart keep result
export interface CutResult {
  ok: true;
  messages: SessionEntry[];       // entries to summarize
  firstKeptEntryId: string;       // first entry to keep ("" = compact all)
  keptUserTurns: number;
  totalUserTurns: number;
  keptTokenEstimate: number;
}

export interface CutCancel {
  ok: false;
  reason: "no_live_messages" | "too_few_live_messages";
}

export type CutDecision = CutResult | CutCancel;

// Constants
export const SMART_KEEP_THRESHOLD_TOKENS = 5000;
export const MAX_KEEP_TURNS = 3;
export const TOOL_RESULT_MAX_CHARS = 2000;
export const TOOL_RESULT_HEAD_RATIO = 0.6;
export const BRIEF_MAX_LINES = 120;
