import type { SessionEntry, CompactionStats } from "./types";
import { smartCut } from "./cut";
import { shakeTail } from "./shake";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { extractSections } from "./extract";
import { buildBriefTranscript } from "./brief";
import { formatSummary } from "./format";
import { mergeWithPrevious } from "./merge";

export interface CompactOptions {
  previousSummary?: string;
  fileOps?: { readFiles?: string[]; modifiedFiles?: string[]; createdFiles?: string[] };
}

export interface CompactResult {
  summary: string;
  firstKeptEntryId: string;
  stats: CompactionStats;
  timings: Record<string, number>;
}

export function compact(
  branchEntries: SessionEntry[],
  options?: CompactOptions,
): CompactResult {
  const timings: Record<string, number> = {};
  const t0 = performance.now();

  const previousSummary = options?.previousSummary;
  const fileOps = options?.fileOps;

  // 1. Determine cut point
  const cut = smartCut(branchEntries);
  timings.cut = performance.now() - t0;

  // 2. Bail if cut is not ok
  if (!cut.ok) {
    throw new Error(cut.reason);
  }

  // 3. Prune verbose tool results in the kept tail
  shakeTail(branchEntries, cut.firstKeptEntryId);
  timings.shake = performance.now() - t0;

  // 4. Normalize summarization candidates into blocks
  const blocks = normalize(cut.messages);

  // 5. Filter noise
  const filtered = filterNoise(blocks);
  timings.normalize = performance.now() - t0;

  // 6. Extract structured sections (with fileOps from prior compactions)
  const data = extractSections(filtered, fileOps);

  // 7-8. Build and attach brief transcript
  data.briefTranscript = buildBriefTranscript(filtered);
  timings.extract = performance.now() - t0;

  // 9. Format the fresh summary
  const fresh = formatSummary(data);
  timings.format = performance.now() - t0;

  // 10. Merge with previous if available
  const summary =
    previousSummary !== undefined
      ? mergeWithPrevious(previousSummary, fresh)
      : fresh;
  timings.merge = performance.now() - t0;

  // Compute keptIndex
  const keptIndex = cut.firstKeptEntryId
    ? branchEntries.findIndex((e) => e.id === cut.firstKeptEntryId)
    : branchEntries.length;

  timings.total = performance.now() - t0;

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
    timings,
  };
}
