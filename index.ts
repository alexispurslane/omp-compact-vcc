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

      // Log timings — use pi.logger with a known working method
      const ms = result.timings.total?.toFixed(0) ?? "?";
      const detail = `cut=${result.timings.cut?.toFixed(0)}ms shake=${result.timings.shake?.toFixed(0)}ms norm=${result.timings.normalize?.toFixed(0)}ms extract=${result.timings.extract?.toFixed(0)}ms fmt=${result.timings.format?.toFixed(0)}ms merge=${result.timings.merge?.toFixed(0)}ms`;
      // Try multiple logging approaches — one will work
      try { pi.logger.info(`vcc compact: ${ms}ms total (${detail})`); } catch {}
      try { console.error(`[vcc] ${ms}ms total (${detail})`); } catch {}
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
