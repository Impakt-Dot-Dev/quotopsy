# Quotopsy (working title)

Explains where your Claude Code usage went, weighted by token type.

It reads the session logs Claude Code already keeps on your machine and
estimates which part of the context each token belongs to: tool schemas,
system prompt, MCP server instructions, tool results, history, output. It then
lists findings the totals do not show, such as cache rebuilds after idle gaps.

- Runs locally. No network calls, no LLM calls, no dependencies.
- One readable file: [prototype.mjs](prototype.mjs).
- Every attribution is an estimate and is labeled as one.

## Run it

Needs Node 18 or newer.

```bash
node prototype.mjs
```

| Option | Effect |
| --- | --- |
| `[logs-dir]` | Logs to read. Defaults to `~/.claude/projects`. |
| `--json` | Print the summary as JSON instead of a report. |
| `--redact` | Replace MCP server names, MCP tool names and prompt section headings with placeholders. |

To enforce "read these logs, no network" instead of trusting the code:

```bash
deno run --allow-read=$HOME/.claude --deny-net prototype.mjs
```

## Sharing a summary

```bash
node prototype.mjs --json --redact > summary.json
```

The file holds token totals, counts, timestamps and model names. It holds no
prompts, code, file paths or tool output. Its first field, `contains`, states
this and whether names were redacted.

## Limits

- Tested on Claude Code 2.1.309 only. Older versions may not log the request
  records it relies on; their usage shows as "unattributed".
- Usage is weighted at published API prices per model (as of 2026-10), so
  shares are shares of API-equivalent cost. How weekly limits weight token
  types and models is not published.
- A model missing from the price table is priced like the newest listed model
  of its family, and the report says so.
- Prompt text is split at headings and standalone `<tag>` blocks. Text that
  follows a heading with no later heading or tag is credited to that heading.
