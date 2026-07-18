import type { NormalizedBlock, SessionEntry } from "./types";

const XML_WRAPPER_RE =
  /<(system-reminder|ide_opened_file|command-message|context-window-usage)[^>]*>[\s\S]*?<\/\1>/g;

/**
 * Extract the full text content from a message's content field.
 * Content is unknown — validate at runtime:
 *   - string → use directly
 *   - array of { type: "text", text: string } → join text parts
 */
function extractText(content: unknown): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item && typeof item === "object" && "type" in item) {
        const p = item as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") {
          parts.push(p.text);
        }
      }
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * Sanitize text: strip XML wrapper tags, normalize newlines,
 * collapse whitespace runs.
 */
function sanitize(text: string): string {
  return text
    .replace(XML_WRAPPER_RE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Safely extract a string field from a loose object.
 */
function getStrField(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

function normalizeOne(entry: SessionEntry, index: number): NormalizedBlock[] {
  if (entry.type !== "message" || !entry.message) return [];

  const msg = entry.message;

  if (msg.role === "user") {
    const text = sanitize(extractText(msg.content));
    return [{ kind: "user", text, sourceIndex: index }];
  }

  if (msg.role === "bashExecution") {
    // SessionMessage doesn't type bash fields, so read from raw
    const raw = msg as unknown as Record<string, unknown>;
    return [
      {
        kind: "bash",
        text: getStrField(raw, "output"),
        command: getStrField(raw, "command"),
        output: getStrField(raw, "output"),
        exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
        sourceIndex: index,
      },
    ];
  }

  if (msg.role === "toolResult") {
    // SessionMessage doesn't type toolName, so read from raw
    const raw = msg as unknown as Record<string, unknown>;
    return [
      {
        kind: "tool_result",
        name: getStrField(raw, "toolName"),
        text: sanitize(extractText(msg.content)),
        sourceIndex: index,
      },
    ];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];

    if (typeof msg.content === "string") {
      return [
        { kind: "assistant", text: sanitize(msg.content), sourceIndex: index },
      ];
    }

    if (!Array.isArray(msg.content)) return [];

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (!part || typeof part !== "object" || !("type" in part)) continue;
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        blocks.push({
          kind: "assistant",
          text: sanitize(p.text),
          sourceIndex: index,
        });
      } else if (p.type === "toolCall" && typeof p.name === "string") {
        blocks.push({
          kind: "tool_call",
          text: "",
          name: p.name,
          args: (p.arguments as Record<string, unknown>) ?? {},
          sourceIndex: index,
        });
      }
      // p.type === "thinking" → skip (no block)
    }
    return blocks;
  }

  return [];
}

/**
 * Convert raw omp session entries into normalized blocks.
 * Only processes entries of type "message". Non-message entries
 * and messages with unrecognized roles are skipped.
 */
export function normalize(entries: SessionEntry[]): NormalizedBlock[] {
  return entries.flatMap((entry, i) => normalizeOne(entry, i));
}
