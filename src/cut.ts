import {
  type CutDecision,
  type CutResult,
  type SessionEntry,
  SMART_KEEP_THRESHOLD_TOKENS,
  MAX_KEEP_TURNS,
} from "./types";

/** Characters per token heuristic used for length-based estimation. */
const CHARS_PER_TOKEN = 3.5;

/**
 * Extract the text content of a {@link SessionMessage} for token estimation.
 * Handles plain strings and OpenAI-style content arrays.
 */
function getMessageTextContent(msg: { content: unknown }): string {
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .filter(
        (block: unknown): block is { type: string; text?: string } =>
          typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text",
      )
      .map((b) => b.text ?? "")
      .join("\n");
  }
  return "";
}

/**
 * Smart compaction cut-point selection.
 *
 * Determines how many of the oldest user turns should be summarized by
 * working backwards from the most recent conversation and keeping at most
 * `MAX_KEEP_TURNS` turns (or enough turns to reach
 * `SMART_KEEP_THRESHOLD_TOKENS` estimated tokens).
 */
export function smartCut(branchEntries: SessionEntry[]): CutDecision {
  // ------------------------------------------------------------------
  // 1. Locate the prior compaction and determine scan start point
  // ------------------------------------------------------------------
  let lastCompactionIdx = -1;
  let priorFirstKeptEntryId: string | undefined;

  for (let i = 0; i < branchEntries.length; i++) {
    const e = branchEntries[i];
    if (e.type === "compaction") {
      lastCompactionIdx = i;
      priorFirstKeptEntryId = e.firstKeptEntryId;
    }
  }

  // The entry id that marks the *beginning* of the scan window.
  let scanAfterId: string | undefined;

  if (lastCompactionIdx >= 0) {
    const afterId = priorFirstKeptEntryId;
    if (afterId && afterId !== "") {
      // Try to find the entry that was the first-kept of the prior compaction.
      const priorKeptIdx = branchEntries.findIndex((e) => e.id === afterId);
      if (priorKeptIdx >= 0) {
        // Start scanning from the entry *after* that marker.
        scanAfterId = branchEntries[priorKeptIdx].id;
      } else {
        // Orphan recovery — the prior first-kept no longer exists in this
        // branch; start from right after the compaction entry itself.
        scanAfterId = branchEntries[lastCompactionIdx].id;
      }
    } else {
      // Prior compaction already compacted everything ("" sentinel);
      // start from after the compaction entry itself.
      scanAfterId = branchEntries[lastCompactionIdx].id;
    }
  }

  // ------------------------------------------------------------------
  // 2. Filter to live messages
  // ------------------------------------------------------------------
  const liveMessages: { entry: SessionEntry; msgIdx: number }[] = [];
  let collecting = scanAfterId === undefined;

  for (let i = 0; i < branchEntries.length; i++) {
    const e = branchEntries[i];
    if (!collecting) {
      if (e.id === scanAfterId) {
        collecting = true;
        // Start collecting from this entry — it is the first entry of
        // the previously kept tail and is now up for re-evaluation.
      } else {
        continue;
      }
    }
    // Skip compaction entries themselves
    if (e.type === "compaction") continue;
    // Keep only messages with valid message field
    if (e.type === "message" && e.message) {
      liveMessages.push({ entry: e, msgIdx: i });
    }
  }

  // ------------------------------------------------------------------
  // 3. Early bail – too few live messages
  // ------------------------------------------------------------------
  if (liveMessages.length <= 2) {
    return { ok: false, reason: "too_few_live_messages" };
  }

  // ------------------------------------------------------------------
  // 4. Identify user turn boundaries (indices into liveMessages)
  // ------------------------------------------------------------------
  const userTurnIndices: number[] = [];
  for (let i = 0; i < liveMessages.length; i++) {
    const msg = liveMessages[i].entry.message;
    if (msg && msg.role === "user") {
      userTurnIndices.push(i);
    }
  }

  if (userTurnIndices.length === 0) {
    // No user turns at all – cannot determine a cut; compact everything.
    // Return the whole set as summarization input.
    return {
      ok: true,
      messages: liveMessages.map((lm) => lm.entry),
      firstKeptEntryId: "",
      keptUserTurns: 0,
      totalUserTurns: 0,
      keptTokenEstimate: 0,
    };
  }

  const totalUserTurns = userTurnIndices.length;

  // ------------------------------------------------------------------
  // 5. Smart keep (working backwards from the last user turn)
  // ------------------------------------------------------------------

  /** Estimated token count for the messages in a single user turn. */
  function estimateTurnTokens(userIdx: number): number {
    const start = userTurnIndices[userIdx];
    const end =
      userIdx + 1 < userTurnIndices.length
        ? userTurnIndices[userIdx + 1]
        : liveMessages.length;

    let chars = 0;
    for (let j = start; j < end; j++) {
      const msg = liveMessages[j].entry.message;
      if (msg) {
        chars += getMessageTextContent(msg).length;
      }
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }

  // Accumulate user turns from the back.
  let accumulatedTokens = 0;
  let keptTurnCount = 0;
  let firstKeptTurnIdx = userTurnIndices.length; // will be decremented

  for (let i = userTurnIndices.length - 1; i >= 0; i--) {
    const turnTokens = estimateTurnTokens(i);
    accumulatedTokens += turnTokens;
    keptTurnCount++;
    firstKeptTurnIdx = i;

    if (
      accumulatedTokens >= SMART_KEEP_THRESHOLD_TOKENS ||
      keptTurnCount >= MAX_KEEP_TURNS
    ) {
      break;
    }
  }

  // ------------------------------------------------------------------
  // 6. Determine cut point and return
  // ------------------------------------------------------------------

  // firstKeptTurnIdx is the earliest (smallest index) user turn we keep.
  // Everything in liveMessages before that index goes to summarization.
  // When firstKeptTurnIdx === 0, we keep ALL turns (compact-all).
  // Summarize everything — the "" sentinel tells buildSessionContext
  // that no entries are kept from before the compaction.
  const firstKeptEntryId =
    firstKeptTurnIdx > 0
      ? liveMessages[userTurnIndices[firstKeptTurnIdx]].entry.id
      : "";

  const messagesToSummarize =
    firstKeptTurnIdx > 0
      ? liveMessages.slice(0, userTurnIndices[firstKeptTurnIdx]).map((lm) => lm.entry)
      : liveMessages.map((lm) => lm.entry);

  const result: CutResult = {
    ok: true,
    messages: messagesToSummarize,
    firstKeptEntryId,
    keptUserTurns: keptTurnCount,
    totalUserTurns,
    keptTokenEstimate: accumulatedTokens,
  };

  return result;
}
