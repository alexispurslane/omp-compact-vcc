import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { compact } from "./src/compact";

export default function ompCompactVcc(pi: ExtensionAPI) {
  pi.setLabel("VCC Compaction");

  pi.on("session_before_compact", (event, ctx) => {
    const branchEntries = ctx.sessionManager.getBranch();
    const preparation = (event as any).preparation;
    const previousSummary = preparation?.previousSummary as string | undefined;
    const tokensBefore = preparation?.tokensBefore as number;

    try {
      const result = compact(branchEntries, previousSummary);
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
