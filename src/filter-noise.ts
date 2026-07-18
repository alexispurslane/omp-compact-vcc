import type { NormalizedBlock } from "./types";

const NOISE_TOOLS: Record<string, true> = {
  TodoWrite: true,
  TodoRead: true,
  ToolSearch: true,
  WebSearch: true,
  AskUser: true,
  ExitSpecMode: true,
  GenerateDroid: true,
};

const NOISE_STRINGS = [
  "Continue from where you left off.",
  "No response requested.",
  "IMPORTANT: TodoWrite was not called yet.",
];

const XML_WRAPPER_RE =
  /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

/**
 * Filter noise blocks from a normalized block list.
 *
 * Removes:
 * - tool_call / tool_result blocks whose name is in NOISE_TOOLS
 * - user blocks whose text (after stripping XML wrappers) is empty
 *   or matches known noise strings
 */
export function filterNoise(blocks: NormalizedBlock[]): NormalizedBlock[] {
  const out: NormalizedBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "tool_call" && b.name && NOISE_TOOLS[b.name]) continue;
    if (b.kind === "tool_result" && b.name && NOISE_TOOLS[b.name]) continue;
    if (b.kind === "user") {
      const trimmed = b.text.trim();
      const stripped = trimmed.replace(XML_WRAPPER_RE, "").trim();
      if (NOISE_STRINGS.some((s) => trimmed.includes(s)) || stripped.length === 0) {
        continue;
      }
      out.push({ ...b, text: stripped });
      continue;
    }
    out.push(b);
  }
  return out;
}
