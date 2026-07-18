# omp-compact-vcc

Algorithmic (no-LLM) session compaction for omp — extracts goals, files, decisions, and blockers via regex to produce structured, deterministic summaries.

## Install

```bash
omp plugin install github:user/omp-compact-vcc
```

## What it does

- Compacts omp sessions without calling an LLM — purely algorithmic
- Extracts session goals from user messages
- Identifies files and changes referenced during the session
- Captures decisions, blockers, and outstanding context
- Produces a brief deterministic transcript summary
- Preserves user messages and smart-selected context entries
- Reports compaction statistics (tokens saved, turns kept, etc.)

## How it works

The plugin hooks into the `session_before_compact` lifecycle event. When omp is about to compact a session, omp-compact-vcc:

1. Normalizes the session entries into uniform blocks
2. Applies regex-based sectioning to extract goals, files, decisions, and context
3. Applies a "smart keep" algorithm that retains the last few user turns unmangled
4. Produces a `CompactionStats` object reporting what was summarized vs. kept

No LLM calls, no prompt engineering — just fast, reproducible compaction.

## License

MIT
