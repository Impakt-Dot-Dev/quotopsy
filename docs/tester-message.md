# Message for testers

Copy and adjust the first line.

---

Hey, I'm testing a small tool that shows where Claude Code usage actually goes
(tool schemas, MCP servers, history, cache rebuilds, output). Could you run it
once on your personal machine and send me the result? It takes about a minute.

**What it does:** reads the session logs Claude Code already keeps in
`~/.claude/projects` and prints totals. It makes no network calls and no LLM
calls, and it's one file you can read first:
https://github.com/Impakt-Dot-Dev/quotopsy/blob/main/quotopsy.mjs

**What I'd get:** token totals, counts, timestamps and model names. No
prompts, code, file paths or tool output. With `--redact`, MCP server names,
MCP tool names and prompt headings are replaced with placeholders.
`--debug` adds sizes and counts for any requests the tool handled badly, so I
can fix it without seeing your logs. It contains no message text either.

**Steps** (needs Node 18 or newer):

1. Open a terminal in any folder.
2. Run:

   ```bash
   npx github:Impakt-Dot-Dev/quotopsy --json --redact --debug > summary.json
   ```

3. Run this and tell me the version it prints:

   ```bash
   claude --version
   ```

4. Have a look at `summary.json` if you like, then send it to me.

If you're curious, `npx github:Impakt-Dot-Dev/quotopsy` on its own prints a readable report
for you, with real names, that stays on your machine.

Please run it only on a personal machine with a personal Claude account, not
on a work laptop or on logs from work sessions. Thanks!
