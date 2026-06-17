# perftale

Performance optimizing web apps can be painful. Instead of staring at flame charts, just download the Chrome performance trace, and tell your AI agent to use perftale on it. It turns the mostly-noise trace into high signal insights. It is designed for use with web games, and has dedicated React support, but would be useful for any interaction or animation-heavy app.

## Installation

Requires Node 23.6+ (runs TypeScript natively, no build step) and pnpm.

```bash
pnpm install
```

## Usage

Record a performance trace in Chrome DevTools and export it as JSON, then:

```bash
pnpm analyze <trace.json[.gz]>
```

Options:

- `--fps <n>` — override the auto-detected refresh rate
- `--debug` — include pipeline diagnostics (noise reduction, latency, dropped-frame clusters)
- `--out <path>` — write the structured summary JSON to `<path>`
- `--json` — write the summary JSON to `.perftale/<trace>.summary.json`

Example:

```bash
pnpm analyze ./my-trace.json.gz --json
```

## Using as a Claude skill

perftale ships with a [`SKILL.md`](SKILL.md) that teaches [Claude Code](https://claude.com/claude-code)
when and how to run it. To install it as a personal skill — available in every
project — symlink (or copy) the repo into your Claude skills directory so Claude
discovers `SKILL.md` and the CLI together, and link the CLI globally so the
`perftale` command resolves from any working directory:

```bash
# from the repo root
mkdir -p ~/.claude/skills
ln -s "$(pwd)" ~/.claude/skills/perftale   # or copy it into a project's .claude/skills/
pnpm link --global                          # puts `perftale` on your PATH
```

Once installed, drop a trace into your project (or give Claude its path) and ask
something like "analyze this trace" or "why is this janky" — the skill triggers
automatically, runs the analysis, and reads the summary back to find and fix the jank.

## Output format

`pnpm analyze --json` (or `--out <path>`) writes a structured summary to
`.perftale/<trace>.summary.json` — a compact, timestamp-free digest meant to be read by an agent or diffed across runs.

The full output shape is declared as a single TypeScript type in
[`src/summary-schema.ts`](src/summary-schema.ts) (the `Summary` interface, versioned by `SUMMARY_SCHEMA_VERSION`). Top-level keys:

| key             | meaning                                                                      |
| --------------- | ---------------------------------------------------------------------------- |
| `schemaVersion` | artifact schema version; bumps on any shape change                           |
| `trace`         | source trace filename                                                        |
| `verdict`       | the conclusion — headline, what the frame is bound by, top hotspot, caveats  |
| `frames`        | refresh rate, dropped frames, freezes, and where main-thread frame time goes |
| `profile`       | JS self-time hotspots by function (`null` if the trace has no CPU profile)   |
| `tasks`         | long main-thread tasks (>50ms)                                               |
| `gc`            | GC pause pressure and suspected allocators (`null` if no v8.gc data)         |
| `react`         | component-render digest from React DevTools timing (`null` if absent)        |
| `size`          | noise-reduction stats for the streaming pass                                 |
