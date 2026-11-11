# Quotopsy

Explains where your Claude Code usage went, weighted by token type.

It reads the session logs Claude Code already keeps on your machine and
estimates which part of the context each token belongs to: tool schemas,
system prompt, MCP server instructions, tool results, history, output. It then
lists findings the totals do not show, such as cache rebuilds after idle gaps.

- Runs locally. No network calls, no LLM calls, no dependencies.
- One readable file: [quotopsy.mjs](quotopsy.mjs).
- Every attribution is an estimate and is labeled as one.

## Run it

Needs Node 18 or newer.

```bash
npx quotopsy
```

Or download [quotopsy.mjs](quotopsy.mjs), read it, and run it directly:

```bash
node quotopsy.mjs
```

| Option | Effect |
| --- | --- |
| `[logs-dir]` | Logs to read. Defaults to `~/.claude/projects`. |
| `--json` | Print the summary as JSON instead of a report. |
| `--redact` | Replace MCP server names, MCP tool names and prompt section headings with placeholders. |
| `--debug` | With `--json`, add structure-only diagnostics for requests the tool handled badly: record types, block types, sizes and counts. No message text. |

To enforce "read these logs, no network" instead of trusting the code:

```bash
deno run --allow-read=$HOME/.claude --deny-net quotopsy.mjs $HOME/.claude/projects
```

The logs path is passed explicitly so the script needs no permission beyond
reading that folder. Under these flags Deno refuses any network call and any
read outside `~/.claude`.

## Sharing a summary

```bash
npx quotopsy --json --redact --debug > summary.json
```

The file holds token totals, counts, timestamps and model names. It holds no
prompts, code, file paths or tool output. Its first field, `contains`, states
this and whether names were redacted.

## Tests

```bash
npm test
```

The tests build synthetic session logs and never read real ones. When a new
kind of log turns up, add a case that reproduces its structure, not its
content.

## Limits

- Sees only sessions that ran on this machine. Cloud sessions count against
  the same plan limits but leave no logs here, so they are not in the report.
- Needs Claude Code 2.1.300 or newer for attribution. Older versions do not
  log the request records it relies on, so their usage shows as
  "unattributed"; cache rebuilds after idle gaps are still detected from
  usage alone. Checked on logs from 2.1.300 through 2.1.322.
- Usage is weighted at published API prices per model (checked 2026-11-10), so
  shares are shares of API-equivalent cost. How weekly limits weight token
  types and models is not published.
- A model missing from the price table is priced like the newest listed model
  of its family, and the report says so.
- A message the log does not contain is shown as "unresolved messages" and
  sized from the usual characters-per-token ratio.
- Prompt text is split at headings and standalone `<tag>` blocks. Text that
  follows a heading with no later heading or tag is credited to that heading.

## License

[MIT](LICENSE)
