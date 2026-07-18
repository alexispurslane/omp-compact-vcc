import type { SessionEntry, CompactionStats, CutResult } from "./types";
import { smartCut } from "./cut";
import { shakeTail } from "./shake";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { extractSections } from "./extract";
import { buildBriefTranscript } from "./brief";
import { formatSummary } from "./format";
import { mergeWithPrevious } from "./merge";

export function compact(
  branchEntries: SessionEntry[],
  previousSummary?: string,
): { summary: string; firstKeptEntryId: string; stats: CompactionStats } {
  // 1. Determine cut point
  const cut = smartCut(branchEntries);

  // 2. Bail if cut is not ok
  if (!cut.ok) {
    throw new Error(cut.reason);
  }

  // 3. Prune verbose tool results in the kept tail
  shakeTail(branchEntries, cut.firstKeptEntryId);

  // 4. Normalize summarization candidates into blocks
  const blocks = normalize(cut.messages);

  // 5. Filter noise
  const filtered = filterNoise(blocks);

  // 6. Extract structured sections
  const data = extractSections(filtered);

  // 7-8. Build and attach brief transcript
  data.briefTranscript = buildBriefTranscript(filtered);

  // 9. Format the fresh summary
  const fresh = formatSummary(data);

  // 10. Merge with previous if available
  const summary =
    previousSummary !== undefined
      ? mergeWithPrevious(previousSummary, fresh)
      : fresh;

  // Compute keptIndex: the branchEntries index where the kept tail starts
  const keptIndex = cut.firstKeptEntryId
    ? branchEntries.findIndex((e) => e.id === cut.firstKeptEntryId)
    : branchEntries.length;

  // 11. Return result
  return {
    summary,
    firstKeptEntryId: cut.firstKeptEntryId,
    stats: {
      summarized: cut.messages.length,
      kept: branchEntries.length - keptIndex,
      keptUserTurns: cut.keptUserTurns,
      totalUserTurns: cut.totalUserTurns,
      keptTokensEst: cut.keptTokenEstimate,
    },
  };
}
