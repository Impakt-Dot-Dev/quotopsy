#!/usr/bin/env node
// Quotopsy go/no-go prototype (spec build step 1).
// Reads Claude Code session logs locally and estimates which part of the
// context each weighted token belongs to. No network, no LLM calls, no deps.
//
//   node prototype.mjs [logs-dir] [--json] [--redact]
//
// --redact replaces MCP server names, MCP tool names and prompt section
// headings with numbered placeholders, for output that will be shared.
//
// Uses only node: builtins, so it also runs under
//   deno run --allow-read=$HOME/.claude --deny-net prototype.mjs
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// HYPOTHESIS: public API price ratios relative to fresh input. Whether weekly
// limits weight token types the same way is unpublished.
const WEIGHTS = { fresh: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 };

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const redact = args.includes("--redact");
const root = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".claude", "projects");

function findJsonl(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findJsonl(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

// Same name -> same placeholder, numbered per kind in order of appearance.
const aliases = new Map(), aliasCounts = new Map();
const PUBLIC_HEADINGS = new Set(["Environment", "Environment update"]); // written by Claude Code itself
function alias(kind, name) {
  if (!redact || PUBLIC_HEADINGS.has(name)) return name;
  const key = kind + "\0" + name;
  if (!aliases.has(key)) {
    aliasCounts.set(kind, (aliasCounts.get(kind) ?? 0) + 1);
    aliases.set(key, `${kind} ${aliasCounts.get(kind)}`);
  }
  return aliases.get(key);
}

const MCP = "MCP server: ";
const isMcp = (name) => name.startsWith("mcp__");
function toolGroup(name) {
  return isMcp(name) ? MCP + alias("server", name.split("__")[1]) : "built-in tools";
}
// Built-in tool names are public; MCP tool names can describe private systems.
function toolLabel(name) {
  return isMcp(name) ? alias("mcp tool", name) : name;
}

// Split prompt text at markdown headings so a category can be broken down.
// Only heading text is kept, never the body.
function sections(text) {
  const out = [];
  let label = "(no heading)", inMcp = false, chars = 0;
  const flush = () => { if (chars) out.push([label, chars]); chars = 0; };
  for (const line of text.split("\n")) {
    const top = /^# (.+)/.exec(line), sub = /^## (.+)/.exec(line);
    if (top) { flush(); inMcp = top[1].startsWith("MCP Server Instructions"); label = alias("section", top[1].slice(0, 40)); }
    else if (sub && inMcp) { flush(); label = "MCP instructions: " + alias("server", sub[1].slice(0, 40)); }
    chars += line.length + 1;
  }
  flush();
  return out;
}

// One logged message -> [category, sub, chars] segments, in prompt order.
function blobSegments(msg, toolNames) {
  const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  return blocks.flatMap((b) => {
    const chars = JSON.stringify(b).length;
    if (msg.role === "system") return sections(b.text ?? "").map(([s, c]) => ["injected system messages", s, c]);
    if (msg.role === "assistant") return [["assistant history", b.type, chars]];
    if (b.type === "tool_result") return [["tool results", toolLabel(toolNames.get(b.tool_use_id) ?? "(unknown tool)"), chars]];
    return [["user messages", (b.text ?? "").startsWith("<system-reminder>") ? "injected reminders" : "typed or pasted", chars]];
  });
}

// Blob hashes are SHA-256 of the message as compact JSON with sorted keys.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
const hashMessage = (m) => createHash("sha256").update(JSON.stringify(sorted(m))).digest("hex");

function parseSession(file) {
  const blobs = new Map(), shapes = new Map(), requests = [], responses = new Map();
  const orphans = new Map(); // assistant messages with no logged request
  const toolNames = new Map(); // tool_use id -> tool name
  const turns = new Map(); // assistant message id -> merged content blocks
  const transcript = []; // messages only logged as transcript records
  let run = []; // user records since the last assistant record
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "api-request-blob") blobs.set(o.hash, o.message);
    else if (o.type === "api-request-shape") shapes.set(o.shapeHash, o.shape);
    else if (o.type === "api-request") requests.push(o);
    else if (o.type === "assistant" && o.message?.usage) {
      // One record per content block, each repeating the message's usage.
      const key = o.requestRef ?? null;
      (key ? responses : orphans).set(key ?? o.message.id, { usage: o.message.usage, model: o.message.model });
      for (const b of o.message.content ?? []) if (b.type === "tool_use") toolNames.set(b.id, b.name);
      turns.set(o.message.id, [...(turns.get(o.message.id) ?? []), ...(o.message.content ?? [])]);
      run = [];
    } else if (o.type === "user" && o.message?.content) {
      const c = o.message.content;
      transcript.push({ role: "user", content: c });
      if (typeof c === "string") transcript.push({ role: "user", content: [{ type: "text", text: c }] });
      // Results of parallel tool calls are logged one record each but sent
      // as a single message, so also try every merge of adjacent records.
      if (Array.isArray(c)) {
        run.push(c);
        for (let i = run.length - 2; i >= Math.max(0, run.length - 16); i--) transcript.push({ role: "user", content: run.slice(i).flat() });
      } else run = [];
    }
  }
  // A request only gets a blob when the wire message differs from the
  // transcript; otherwise its hash refers to the transcript message itself.
  for (const content of turns.values()) transcript.push({ role: "assistant", content });
  for (const m of transcript) {
    const h = hashMessage(m);
    if (!blobs.has(h)) blobs.set(h, m);
  }
  return { blobs, shapes, requests, responses, orphans, toolNames };
}

function splitUsage(u) {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const thinking = Math.min(output, u.output_tokens_details?.thinking_tokens ?? 0);
  return { fresh: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write, write1h, write5m: write - write1h, output, thinking };
}

const cats = new Map(); // category -> { read, write, fresh, output, weighted, subs }
const bump = (cat, sub, kind, tokens, weighted) => {
  const c = cats.get(cat) ?? { read: 0, write: 0, fresh: 0, output: 0, weighted: 0, subs: new Map() };
  c[kind] += tokens; c.weighted += weighted;
  c.subs.set(sub, (c.subs.get(sub) ?? 0) + weighted);
  cats.set(cat, c);
};
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

const stats = { files: 0, requests: 0, noResponse: 0, unattributed: 0, missingBlobs: 0, charsPerToken: [], models: new Map(), first: null, last: null };
const calls = new Map(); // tool group or tool name -> call count
const loadedIn = new Map(); // tool group -> requests that carried its schemas
const rebuilds = [];

for (const file of findJsonl(root)) {
  stats.files++;
  const s = parseSession(file);
  for (const name of s.toolNames.values()) { count(calls, toolLabel(name)); count(calls, toolGroup(name)); }

  // Sessions without request records: usage is known, its cause is not.
  for (const { usage } of s.orphans.values()) {
    const u = splitUsage(usage);
    const cat = "unattributed (no request record)";
    stats.unattributed++;
    bump(cat, "cache read", "read", u.read, u.read * WEIGHTS.read);
    bump(cat, "cache write", "write", u.write, u.write5m * WEIGHTS.write5m + u.write1h * WEIGHTS.write1h);
    bump(cat, "fresh input", "fresh", u.fresh, u.fresh * WEIGHTS.fresh);
    bump("output", "thinking", "output", u.thinking, u.thinking * WEIGHTS.output);
    bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * WEIGHTS.output);
  }

  // Requests are delta-encoded: messages = base's first `keep` + `tail`.
  const msgLists = new Map();
  let prev = null;
  for (const req of s.requests) {
    const baseLen = (msgLists.get(req.base) ?? []).length;
    const hashes = [...(msgLists.get(req.base) ?? []).slice(0, req.keep), ...req.tail];
    msgLists.set(req.id, hashes);
    const res = s.responses.get(req.id);
    if (!res) { stats.noResponse++; continue; }
    stats.requests++;
    count(stats.models, res.model);
    stats.first = !stats.first || req.timestamp < stats.first ? req.timestamp : stats.first;
    stats.last = !stats.last || req.timestamp > stats.last ? req.timestamp : stats.last;

    const u = splitUsage(res.usage);
    bump("output", "thinking", "output", u.thinking, u.thinking * WEIGHTS.output);
    bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * WEIGHTS.output);

    // Prompt order is tools, system, messages; the cache covers a prefix of it.
    const shape = s.shapes.get(req.shapeHash) ?? { tools: [], system: [] };
    for (const g of new Set(shape.tools.map((t) => toolGroup(t.name)))) count(loadedIn, g);
    const segs = [
      ...shape.tools.map((t) => [toolGroup(t.name), toolLabel(t.name), JSON.stringify(t).length]),
      ...shape.system.flatMap((b) => sections(b.text ?? "").map(([sec, c]) => ["system prompt", sec, c])),
    ];
    for (const h of hashes) {
      const m = s.blobs.get(h);
      if (m) segs.push(...blobSegments(m, s.toolNames)); else stats.missingBlobs++;
    }
    const prompt = u.fresh + u.write + u.read;
    const chars = segs.reduce((n, seg) => n + seg[2], 0);
    if (!chars || !prompt) continue;
    stats.charsPerToken.push(chars / prompt);

    // ESTIMATE: scale chars to the request's real token total, then charge
    // each segment by position: first `read` tokens, then `write`, then fresh.
    const perChar = prompt / chars;
    const writeRate = u.write ? (u.write5m * WEIGHTS.write5m + u.write1h * WEIGHTS.write1h) / u.write : 0;
    const bands = [["read", u.read, WEIGHTS.read], ["write", u.write, writeRate], ["fresh", u.fresh, WEIGHTS.fresh]];
    let pos = 0;
    for (const [cat, sub, c] of segs) {
      const end = pos + c * perChar;
      let lo = 0;
      for (const [kind, size, rate] of bands) {
        const overlap = Math.max(0, Math.min(end, lo + size) - Math.max(pos, lo));
        if (overlap) bump(cat, sub, kind, overlap, overlap * rate);
        lo += size;
      }
      pos = end;
    }

    // Reading back less than the previous prompt means the cache was lost
    // and part of the existing conversation had to be written again. The
    // waste is what those tokens cost above a normal cache read.
    const lost = prev ? Math.min(u.write, prev.prompt - u.read) : 0;
    if (prev && u.read < 0.8 * prev.prompt && lost > 5000) {
      const gapMin = (Date.parse(req.timestamp) - Date.parse(prev.ts)) / 60000;
      // An expired cache explains the rebuild whatever else changed.
      const cause = gapMin > prev.ttlMin ? "idle longer than the cache lifetime"
        : prev.model !== res.model ? "model switched mid-session"
        : req.keep < baseLen ? "conversation edited or compacted"
        : req.shapeHash !== prev.shapeHash ? "tool list or system prompt changed"
        : "unknown";
      rebuilds.push({ cause, tokens: lost, wasted: lost * (writeRate - WEIGHTS.read), at: req.timestamp, gapMin: Math.round(gapMin) });
    }
    prev = { prompt, ts: req.timestamp, model: res.model, shapeHash: req.shapeHash, ttlMin: u.write1h || !u.write ? 60 : 5 };
  }
}

const total = [...cats.values()].reduce((n, c) => n + c.weighted, 0);
const rows = [...cats.entries()].map(([name, c]) => ({
  name, read: c.read, write: c.write, fresh: c.fresh, output: c.output, weighted: c.weighted, share: c.weighted / total, calls: calls.get(name) ?? null,
  subs: [...c.subs.entries()].map(([sub, w]) => ({ name: sub, share: w / total, calls: calls.get(sub) ?? null })).sort((a, b) => b.share - a.share),
})).sort((a, b) => b.weighted - a.weighted);
const row = (name) => rows.find((r) => r.name === name);

// Findings: things the category table does not spell out. All ESTIMATES.
const findings = [];
const byCause = new Map();
for (const r of rebuilds) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
const rebuildFix = {
  "model switched mid-session": "Pick the model before the first message, or switch in a new session.",
  "idle longer than the cache lifetime": "After a long break, start a new session instead of resuming a long one.",
  "conversation edited or compacted": "Compact at a natural break, before the conversation is large.",
  "tool list or system prompt changed": "Connect MCP servers before the session starts, not during it.",
  "unknown": "No fix identified yet.",
};
for (const [cause, list] of byCause) {
  const wasted = list.reduce((n, r) => n + r.wasted, 0);
  findings.push({ effect: wasted / total, what: `Cache rebuilt ${list.length}x: ${cause}; ${Math.round(list.reduce((n, r) => n + r.tokens, 0) / 1000)}k tokens paid for twice`, fix: rebuildFix[cause] });
}
for (const r of rows.filter((r) => r.name.startsWith(MCP))) {
  const server = r.name.slice(MCP.length);
  const instr = row("injected system messages")?.subs.find((x) => x.name === "MCP instructions: " + server)?.share ?? 0;
  const n = loadedIn.get(r.name) ?? 0, k = r.calls ?? 0;
  if (k / n > 0.05) continue;
  findings.push({ effect: r.share + instr, what: `${server}: schemas loaded in ${n} requests, called ${k}x`, fix: "Disable it, or enable it only in the projects that use it." });
}
// Servers whose instructions are injected but whose tools are not loaded up
// front (deferred, or named differently), so calls cannot be matched.
for (const sub of row("injected system messages")?.subs ?? []) {
  const server = sub.name.replace("MCP instructions: ", "");
  if (server === sub.name || row(MCP + server)) continue;
  findings.push({ effect: sub.share, what: `${server}: instructions injected in every session, usage not measurable`, fix: "Disconnect it if you do not use it." });
}
const thinking = row("output")?.subs.find((x) => x.name === "thinking");
if (thinking) findings.push({ effect: thinking.share, upperBound: true, what: "Thinking tokens", fix: "Lower the effort level for routine work. Upper bound: the saving depends on how much less it thinks." });
const topResult = row("tool results")?.subs[0];
if (topResult) findings.push({ effect: topResult.share, upperBound: true, what: `Results of ${topResult.name} (${topResult.calls ?? 0} calls) kept in context`, fix: "Ask for narrower output (line ranges, filters), or hand bulky reads to a subagent." });
findings.sort((a, b) => b.effect - a.effect);

const cpt = stats.charsPerToken.sort((a, b) => a - b);
const summary = {
  contains: "Token totals, counts, timestamps and model names only. No prompts, code, file paths or tool output. "
    + (redact ? "MCP server names, MCP tool names and prompt section headings are replaced with placeholders." : "Includes MCP server names, tool names and prompt section headings; rerun with --redact to replace them."),
  redacted: redact,
  weights: WEIGHTS,
  files: stats.files, requests: stats.requests, requestsWithoutResponse: stats.noResponse, unattributedMessages: stats.unattributed, missingBlobs: stats.missingBlobs,
  from: stats.first, to: stats.last, models: Object.fromEntries(stats.models),
  charsPerToken: { min: cpt[0], median: cpt[cpt.length >> 1], max: cpt[cpt.length - 1] },
  totalWeighted: total, categories: rows, cacheRebuilds: rebuilds, findings,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const k = (n) => (n / 1000).toFixed(1).padStart(8) + "k";
  const pct = (x) => (x * 100).toFixed(1).padStart(5) + "%";
  console.log(`Quotopsy prototype: ${stats.files} sessions, ${stats.requests} requests, ${stats.first?.slice(0, 10)} to ${stats.last?.slice(0, 10)}`);
  if (redact) console.log(`Redacted: MCP server names, MCP tool names and prompt section headings are placeholders`);
  console.log(`Weights (hypothesis): fresh 1, cache write 1.25/2, cache read 0.1, output 5\n`);
  console.log(`${"share".padStart(6)}  ${"weighted".padStart(9)}  ${"read".padStart(9)}  ${"written".padStart(9)}  ${"fresh".padStart(9)}  ${"output".padStart(9)}  calls  category (estimated)`);
  for (const r of rows) {
    console.log(`${pct(r.share)}  ${k(r.weighted)}  ${k(r.read)}  ${k(r.write)}  ${k(r.fresh)}  ${k(r.output)}  ${String(r.calls ?? "").padStart(5)}  ${r.name}`);
  }
  const raw = rows.reduce((n, r) => n + r.read + r.write + r.fresh + r.output, 0);
  console.log(`\nTotal: ${k(total).trim()} weighted units from ${k(raw).trim()} raw tokens`);

  console.log(`\nInside the larger categories (share of total)`);
  for (const r of rows.filter((r) => r.share >= 0.05 && r.subs.length > 1)) {
    console.log(`  ${r.name}`);
    for (const sub of r.subs.slice(0, 5)) console.log(`    ${pct(sub.share)}  ${sub.name}${sub.calls != null ? ` (${sub.calls} calls)` : ""}`);
  }

  console.log(`\nFindings (estimated effect on weighted usage)`);
  for (const f of findings.filter((f) => f.effect >= 0.005)) {
    console.log(`  ${f.upperBound ? "up to" : "     "} ${pct(f.effect)}  ${f.what}\n                 Fix: ${f.fix}`);
  }
  console.log(`\nSanity: chars per token min ${cpt[0]?.toFixed(2)}, median ${cpt[cpt.length >> 1]?.toFixed(2)}, max ${cpt[cpt.length - 1]?.toFixed(2)}; ${stats.noResponse} requests had no logged response; ${stats.missingBlobs} missing blobs`);
}
