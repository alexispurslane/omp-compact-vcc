# omp-compact-vcc

Algorithmic session compaction for [omp](https://github.com/oh-my-pi/oh-my-pi). No LLM calls — produces structured, deterministic summaries via regex extraction and formatting. 35-99% token reduction on real sessions.

Based on [pi-vcc](https://github.com/sting8k/pi-vcc) by [sting8k](https://github.com/sting8k), ported to the omp extension API.

## Install

```bash
omp plugin install github:alexispurslane/omp-compact-vcc
```

## What it does

- Extracts structured sections: **Session Goal**, **Files & Changes**, **Commits**, **Outstanding Context**, **User Preferences**
- Builds a concise brief transcript from landmark messages
- **Smart keep**: retains 1-3 user turns based on token length — short tails grow, long tails stop early
- **Cumulative merging**: sections accumulate across repeated compactions (dedup, file tracking)
- **Tail shaking**: prunes verbose tool results in the kept region
- Pure algorithmic — deterministic output, 30-470ms, zero API cost

## How it works

Hooks `session_before_compact` to replace the built-in LLM summarization entirely:

1. `smartCut()` — walks user turns backwards, accumulates estimated token length, stops when threshold reached or 3 turns max
2. `shakeTail()` — truncates long tool results in the kept tail region
3. `normalize()` + `filterNoise()` — flattens session entries to uniform blocks, strips noise
4. Regex-based extractors pull goals, files, commits, blockers, and preferences
5. `buildBriefTranscript()` — landmark-based inline transcript with word-budget truncation
6. `mergeWithPrevious()` — deduplicates and accumulates sections across compactions

## Credits

This plugin is a direct port of the algorithm and approach from [pi-vcc](https://github.com/sting8k/pi-vcc) by [sting8k](https://github.com/sting8k), adapted from the Pi extension API (`@earendil-works/pi-coding-agent`) to the omp extension API (`@oh-my-pi/pi-coding-agent`). The core extraction, brief, merge, and cut algorithms are derived from pi-vcc's source.

## License

MIT
