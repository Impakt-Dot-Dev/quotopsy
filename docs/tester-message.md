# Message for testers

Copy, adjust the first line, and attach `prototype.mjs`.

---

Hey, I'm testing a small tool that shows where Claude Code usage actually goes
(tool schemas, MCP servers, history, cache rebuilds, output). Could you run it
once on your personal machine and send me the result? It takes about a minute.

**What it does:** reads the session logs Claude Code already keeps in
`~/.claude/projects` and prints totals. It makes no network calls and no LLM
calls, and it's one file you can read first.

**What I'd get:** token totals, counts, timestamps and model names. No
prompts, code, file paths or tool output. With `--redact`, MCP server names,
MCP tool names and prompt headings are replaced with placeholders.

**Steps** (needs Node 18 or newer):

1. Save the attached `prototype.mjs` anywhere and open a terminal in that folder.
2. Run:

   ```bash
   node prototype.mjs --json --redact > summary.json
   ```

3. Run this and tell me the version it prints:

   ```bash
   claude --version
   ```

4. Have a look at `summary.json` if you like, then send it to me.

If you're curious, `node prototype.mjs` on its own prints a readable report
for you, with real names, that stays on your machine.

Please don't run it on a work machine. Thanks!
