import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { compact } from "./src/compact";

export default function ompCompactVcc(pi: ExtensionAPI) {
  pi.setLabel("VCC Compaction");

  pi.on("session_before_compact", (event, ctx) => {
    const branchEntries = ctx.sessionManager.getBranch();
    const preparation = (event as any).preparation;
    const previousSummary = preparation?.previousSummary as string | undefined;
    const tokensBefore = preparation?.tokensBefore as number;

    // Extract fileOps from the event for cumulative file tracking
    const fops = preparation?.fileOps as { read?: string[]; written?: string[]; edited?: string[] } | undefined;
    const fileOps = fops ? {
      readFiles: fops.read ?? [],
      modifiedFiles: [...(fops.written ?? []), ...(fops.edited ?? [])],
    } : undefined;

    try {
      const result = compact(branchEntries, { previousSummary, fileOps });

      // Log timings for debugging
      const ms = result.timings.total?.toFixed(0) ?? "?";
      pi.logger?.debug?.(`vcc compact: ${ms}ms (cut=${result.timings.cut?.toFixed(0)} shake=${result.timings.shake?.toFixed(0)} norm=${result.timings.normalize?.toFixed(0)} extract=${result.timings.extract?.toFixed(0)} fmt=${result.timings.format?.toFixed(0)} merge=${result.timings.merge?.toFixed(0)})`);
      return {
        compaction: {
          summary: result.summary,
          firstKeptEntryId: result.firstKeptEntryId,
          tokensBefore: tokensBefore ?? 0,
          details: {
            compactor: "omp-compact-vcc",
            version: 1,
            ...result.stats,
          },
          fromExtension: true,
        },
      };
    } catch (err) {
      // If compaction fails, let built-in compactor take over
      return;
    }
  });

  pi.on("session_compact", (_event, ctx) => {
    ctx.ui.notify("VCC compaction complete", "info");
  });
}
