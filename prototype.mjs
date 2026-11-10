#!/usr/bin/env node
// Quotopsy go/no-go prototype (spec build step 1).
// Reads Claude Code session logs locally and estimates which part of the
// context each weighted token belongs to. No network, no LLM calls, no deps.
//
//   node prototype.mjs [logs-dir] [--json] [--redact]
//
// --redact replaces MCP server names, MCP tool names and prompt section
// headings with numbered placeholders, for output that will be shared.
// --debug adds structure-only diagnostics to the JSON (record types, block
// types, sizes and counts for requests the tool handled badly). No text.
//
// Uses only node: builtins, so it also runs under
//   deno run --allow-read=$HOME/.claude --deny-net prototype.mjs $HOME/.claude/projects
// (the path is explicit because looking up the home directory needs a
// further Deno permission)
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// HYPOTHESIS: usage is weighted at published API prices, so one unit is one
// API-equivalent dollar. Whether weekly limits weight token types and models
// the same way is unpublished.
// Per model: [input $/MTok, cache read $/MTok]. Output is 5x input, cache
// writes are 1.25x (5 min) and 2x (1 h) input. Prices as of 2026-10.
const PRICES = {
  "claude-fable-5-1": [10, 0.25], "claude-mythos-5-1": [10, 0.25], "claude-fable-5": [10, 1], "claude-mythos-5": [10, 1],
  "claude-opus-5-5": [4, 0.2], "claude-opus-5": [5, 0.5], "claude-opus-4-8": [5, 0.5], "claude-opus-4-7": [5, 0.5], "claude-opus-4-6": [5, 0.5], "claude-opus-4-5": [5, 0.5],
  "claude-sonnet-5-5": [2, 0.2], "claude-sonnet-5": [2, 0.2], "claude-sonnet-4-6": [3, 0.3], "claude-sonnet-4-5": [3, 0.3],
  "claude-haiku-5-5": [0.1, 0.01], "claude-haiku-4-5": [1, 0.1],
};
// Models missing from the table are priced like the newest listed model of
// the same family, and reported so the reader knows.
const FAMILY = { fable: "claude-fable-5-1", mythos: "claude-mythos-5-1", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
const assumedPricing = new Map(); // model -> model whose prices were used
function rates(model = "", usage = {}) {
  const id = model.replace(/-\d{8}$/, "");
  let key = id in PRICES ? id : null;
  if (!key) {
    key = FAMILY[Object.keys(FAMILY).find((f) => id.includes(f))] ?? "claude-opus-5-5";
    assumedPricing.set(model, key);
  }
  const [input, read] = PRICES[key];
  const per = (usage.speed === "fast" ? 2 : 1) / 1e6; // fast mode bills at 2x
  return { fresh: input * per, write5m: 1.25 * input * per, write1h: 2 * input * per, read: read * per, output: 5 * input * per };
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const redact = args.includes("--redact");
const debugOn = args.includes("--debug");

// Terminal styling. Progress and banner go to stderr so piped or redirected
// output stays clean; colour is used only on a terminal that wants it.
const noColor = globalThis.Deno ? globalThis.Deno.noColor : "NO_COLOR" in process.env;
const paint = (stream) => (code, text) => (stream.isTTY && !noColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const out = paint(process.stdout), err = paint(process.stderr);
const BOLD = 1, DIM = 2, CYAN = 36, YELLOW = 33, GREEN = 32;
const BANNER = ["┌─┐ ┬ ┬┌─┐┌┬┐┌─┐┌─┐┌─┐┬ ┬", "│─┼┐│ ││ │ │ │ │├─┘└─┐└┬┘", "└─┘└└─┘└─┘ ┴ └─┘┴  └─┘ ┴ "];
const bar = (share, width = 20) => "█".repeat(Math.round(share * width)).padEnd(width, "░");
const num = (n) => Math.round(n).toLocaleString("en-US");
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
    // A <tag> on its own line opens a block; its closing tag ends the block
    // without handing the text that follows to the previous heading.
    const open = /^<([a-z][\w-]*)>\s*$/.exec(line), close = /^<\/([a-z][\w-]*)>\s*$/.exec(line);
    if (open) { flush(); inMcp = false; label = alias("section", `<${open[1]}>`); }
    else if (close) { chars += line.length + 1; flush(); label = "(no heading)"; continue; }
    else if (top) { flush(); inMcp = top[1].startsWith("MCP Server Instructions"); label = alias("section", top[1].slice(0, 40)); }
    else if (sub && inMcp) { flush(); label = "MCP instructions: " + alias("server", sub[1].slice(0, 40)); }
    chars += line.length + 1;
  }
  flush();
  return out;
}

// Base64 image and document payloads are not tokenized as text. ESTIMATE:
// drop the payload and count each as roughly 1,500 tokens' worth of chars.
const MEDIA_CHARS = 4500;
function blockChars(b) {
  let media = 0;
  const text = JSON.stringify(b, (k, v) => (k === "data" && typeof v === "string" && v.length > 1000 ? (media++, "") : v));
  return text.length + media * MEDIA_CHARS;
}

// One logged message -> [category, sub, chars] segments, in prompt order.
function blobSegments(msg, toolNames) {
  const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
  return blocks.flatMap((b) => {
    const chars = blockChars(b);
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
  const recordTypes = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    count(recordTypes, String(o.type));
    if (o.type === "api-request-blob") blobs.set(o.hash, o.message);
    else if (o.type === "api-request-shape") shapes.set(o.shapeHash, o.shape);
    else if (o.type === "api-request") requests.push(o);
    else if (o.type === "assistant" && o.message?.usage) {
      // One record per content block, each repeating the message's usage.
      const key = o.requestRef ?? null;
      if (o.message.model?.startsWith("<")) continue; // synthetic local message, not an API call
      (key ? responses : orphans).set(key ?? o.message.id, { usage: o.message.usage, model: o.message.model, version: o.version, sidechain: !!o.isSidechain });
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
  return { blobs, shapes, requests, responses, orphans, toolNames, recordTypes };
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

const stats = { files: 0, requests: 0, noResponse: 0, unattributed: 0, missingBlobs: 0, charsPerToken: [], models: new Map(), versions: new Map(), sources: new Map(), first: null, last: null };
// Claude Code version -> requests that could and could not be attributed
const coverage = (version, key) => {
  const v = stats.versions.get(version ?? "unknown") ?? { attributed: 0, unattributed: 0 };
  v[key]++; stats.versions.set(version ?? "unknown", v);
};
const calls = new Map(); // tool group or tool name -> call count
const loadedIn = new Map(); // tool group -> requests that carried its schemas
const rebuilds = [];

// Structure-only diagnostics for --debug. Sizes, counts and type names; the
// only names are tool and section labels, which --redact replaces.
const DEBUG_CAP = 50;
const debug = { recordTypes: new Map(), unattributed: new Map(), offRequests: [], unknownRebuilds: [], offRequestCount: 0 };
// Content block types of a message, including those nested in tool results.
function blockTypes(msg, into) {
  for (const b of Array.isArray(msg.content) ? msg.content : [{ type: "text" }]) {
    count(into, `${msg.role}:${b.type}`);
    if (b.type === "tool_result" && Array.isArray(b.content)) for (const inner of b.content) count(into, `tool_result>${inner.type}`);
  }
}

let files;
try { files = findJsonl(root); } catch { files = []; }
if (!files.length) {
  console.error(`No Claude Code session logs found in ${root}\nPass the folder that holds them: node prototype.mjs <logs-dir>`);
  process.exit(1);
}

const started = Date.now();
if (process.stderr.isTTY) {
  process.stderr.write(`\n${BANNER.map((l) => "  " + err(CYAN, l)).join("\n")}\n  ${err(DIM, "where did your Claude Code usage go?")}\n\n`);
}
let lastDraw = 0;
function progress(done) {
  if (!process.stderr.isTTY || (Date.now() - lastDraw < 60 && done < files.length)) return;
  lastDraw = Date.now();
  process.stderr.write(`\r  Reading sessions  ${err(CYAN, bar(done / files.length, 24))}  ${done}/${files.length}`);
}

for (const file of files) {
  progress(stats.files);
  stats.files++;
  const s = parseSession(file);
  for (const name of s.toolNames.values()) { count(calls, toolLabel(name)); count(calls, toolGroup(name)); }

  // Sessions without request records: usage is known, its cause is not.
  for (const [type, n] of s.recordTypes) debug.recordTypes.set(type, (debug.recordTypes.get(type) ?? 0) + n);
  for (const { usage, model, version, sidechain } of s.orphans.values()) {
    coverage(version, "unattributed");
    count(debug.unattributed, `version ${version ?? "unknown"}, ${sidechain ? "subagent" : "main"} thread, file ${s.requests.length ? "has" : "has no"} request records`);
    const u = splitUsage(usage), w = rates(model, usage);
    const cat = "unattributed (no request record)";
    stats.unattributed++;
    bump(cat, "cache read", "read", u.read, u.read * w.read);
    bump(cat, "cache write", "write", u.write, u.write5m * w.write5m + u.write1h * w.write1h);
    bump(cat, "fresh input", "fresh", u.fresh, u.fresh * w.fresh);
    bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
    bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);
  }

  // Requests are delta-encoded: messages = base's first `keep` + `tail`.
  const msgLists = new Map();
  const answered = new Map(); // request id -> what a follow-up needs to compare against
  const lastOf = new Map(); // first message hash -> same, for the conversation's latest request
  for (const req of s.requests) {
    const baseLen = (msgLists.get(req.base) ?? []).length;
    const hashes = [...(msgLists.get(req.base) ?? []).slice(0, req.keep), ...req.tail];
    msgLists.set(req.id, hashes);
    const res = s.responses.get(req.id);
    if (!res) { stats.noResponse++; continue; }
    stats.requests++;
    count(stats.models, res.model);
    count(stats.sources, req.querySource ?? "unknown");
    coverage(req.version, "attributed");
    stats.first = !stats.first || req.timestamp < stats.first ? req.timestamp : stats.first;
    stats.last = !stats.last || req.timestamp > stats.last ? req.timestamp : stats.last;

    const u = splitUsage(res.usage), w = rates(res.model, res.usage);
    bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
    bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);

    // Prompt order is tools, system, messages; the cache covers a prefix of it.
    const shape = s.shapes.get(req.shapeHash) ?? { tools: [], system: [] };
    for (const g of new Set(shape.tools.map((t) => toolGroup(t.name)))) count(loadedIn, g);
    const segs = [
      ...shape.tools.map((t) => [toolGroup(t.name), toolLabel(t.name), JSON.stringify(t).length]),
      ...shape.system.flatMap((b) => sections(b.text ?? "").map(([sec, c]) => ["system prompt", sec, c])),
    ];
    let missing = 0;
    for (const h of hashes) {
      const m = s.blobs.get(h);
      if (m) segs.push(...blobSegments(m, s.toolNames)); else missing++;
    }
    stats.missingBlobs += missing;
    const prompt = u.fresh + u.write + u.read;
    const chars = segs.reduce((n, seg) => n + seg[2], 0);
    if (!chars || !prompt) continue;
    stats.charsPerToken.push(chars / prompt);
    if (debugOn && (chars / prompt < 2 || chars / prompt > 4.5) && debug.offRequestCount++ < DEBUG_CAP) {
      const byCat = new Map(), types = new Map();
      for (const [cat, , c] of segs) byCat.set(cat, (byCat.get(cat) ?? 0) + c);
      for (const h of hashes) if (s.blobs.has(h)) blockTypes(s.blobs.get(h), types);
      debug.offRequests.push({
        charsPerToken: chars / prompt, version: req.version, source: req.querySource, model: res.model, usage: u,
        messages: hashes.length, missingMessages: missing, keep: req.keep, tail: req.tail.length, hasBase: !!req.base, baseKnown: msgLists.has(req.base),
        charsByCategory: Object.fromEntries(byCat), blockTypes: Object.fromEntries(types),
        largestSegments: [...segs].sort((a, b) => b[2] - a[2]).slice(0, 3).map(([cat, sub, c]) => ({ category: cat, sub, chars: c })),
      });
    }

    // ESTIMATE: scale chars to the request's real token total, then charge
    // each segment by position: first `read` tokens, then `write`, then fresh.
    const perChar = prompt / chars;
    const writeRate = u.write ? (u.write5m * w.write5m + u.write1h * w.write1h) / u.write : 0;
    const bands = [["read", u.read, w.read], ["write", u.write, writeRate], ["fresh", u.fresh, w.fresh]];
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
    // Compare with the request this one extends, not the previous one in the
    // file: subagents interleave their own conversations in the same log.
    // A resumed session logs no base, so fall back to the conversation that
    // starts with the same first message.
    const prev = answered.get(req.base) ?? lastOf.get(hashes[0]);
    const lost = prev ? Math.min(u.write, prev.prompt - u.read) : 0;
    if (prev && u.read < 0.8 * prev.prompt && lost > 5000) {
      const gapMin = (Date.parse(req.timestamp) - Date.parse(prev.ts)) / 60000;
      // An expired cache explains the rebuild whatever else changed.
      const cause = gapMin > prev.ttlMin ? "idle longer than the cache lifetime"
        : prev.model !== res.model ? "model switched mid-session"
        : req.keep < baseLen ? "conversation edited or compacted"
        : req.shapeHash !== prev.shapeHash ? "tool list or system prompt changed"
        : "unknown";
      rebuilds.push({ cause, tokens: lost, wasted: lost * (writeRate - w.read), at: req.timestamp, gapMin: Math.round(gapMin) });
      if (debugOn && cause === "unknown" && debug.unknownRebuilds.length < DEBUG_CAP) {
        debug.unknownRebuilds.push({
          version: req.version, source: req.querySource, gapMin, previousPrompt: prev.prompt, usage: u, ttlMin: prev.ttlMin,
          keep: req.keep, baseMessages: baseLen, tail: req.tail.length, matchedBy: answered.has(req.base) ? "base" : "first message",
        });
      }
    }
    answered.set(req.id, { prompt, ts: req.timestamp, model: res.model, shapeHash: req.shapeHash, ttlMin: u.write1h || !u.write ? 60 : 5 });
    lastOf.set(hashes[0], answered.get(req.id));
  }
}

if (process.stderr.isTTY) {
  process.stderr.write(`\r\x1b[2K  ${err(GREEN, "✓")} Read ${num(stats.files)} sessions and ${num(stats.requests + stats.unattributed)} requests in ${((Date.now() - started) / 1000).toFixed(1)}s, on this machine only\n\n`);
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
  findings.push({ effect: sub.share, what: `${server}: instructions loaded in every session; whether you use it cannot be measured`, fix: "Disconnect it if you do not use it." });
}
const thinking = row("output")?.subs.find((x) => x.name === "thinking");
if (thinking) findings.push({ effect: thinking.share, upperBound: true, what: "Thinking tokens", fix: "Lower the effort level for routine work. Upper bound: the saving depends on how much less it thinks." });
const topResult = row("tool results")?.subs[0];
if (topResult) findings.push({ effect: topResult.share, upperBound: true, what: `Results of ${topResult.name} (${topResult.calls ?? 0} calls) kept in context`, fix: "Ask for narrower output (line ranges, filters), or hand bulky reads to a subagent." });
findings.sort((a, b) => b.effect - a.effect);

const cpt = stats.charsPerToken.sort((a, b) => a - b);
const q = (p) => cpt[Math.min(cpt.length - 1, Math.floor(p * cpt.length))];
// Requests whose reconstructed prompt is far from the billed token count.
const offRatio = cpt.filter((x) => x < 2 || x > 4.5).length / (cpt.length || 1);
const summary = {
  contains: "Token totals, counts, timestamps and model names only. No prompts, code, file paths or tool output. "
    + (redact ? "MCP server names, MCP tool names and prompt section headings are replaced with placeholders." : "Includes MCP server names, tool names and prompt section headings; rerun with --redact to replace them."),
  redacted: redact,
  unit: "API-equivalent US dollars at published prices (hypothesis: limits may weight usage differently)",
  prices: PRICES, assumedPricing: Object.fromEntries(assumedPricing),
  files: stats.files, requests: stats.requests, requestsWithoutResponse: stats.noResponse, unattributedMessages: stats.unattributed, missingBlobs: stats.missingBlobs,
  from: stats.first, to: stats.last, models: Object.fromEntries(stats.models),
  charsPerToken: { min: cpt[0], p5: q(0.05), median: q(0.5), p95: q(0.95), max: cpt[cpt.length - 1], shareOutside2to4_5: offRatio },
  claudeCodeVersions: Object.fromEntries(stats.versions), querySources: Object.fromEntries(stats.sources),
  totalWeighted: total, categories: rows, cacheRebuilds: rebuilds, findings,
};
if (debugOn) {
  summary.debug = {
    contains: "Structure only: record types, block types, sizes and counts. No message text.",
    recordTypes: Object.fromEntries(debug.recordTypes), unattributed: Object.fromEntries(debug.unattributed),
    offRequestsTotal: debug.offRequestCount, offRequests: debug.offRequests, unknownRebuilds: debug.unknownRebuilds,
  };
}

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
  if (process.stderr.isTTY && !process.stdout.isTTY) process.stderr.write(`  Summary written${redact ? ", with names replaced by placeholders" : ""}. Have a look before you share it.\n\n`);
} else if (!total) {
  console.log("  The logs contain no usage records yet.");
} else {
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const title = (t) => t[0].toUpperCase() + t.slice(1);
  const WIDTH = 72;
  // Word-wrap to the report width, with a first-line prefix and a hanging indent.
  const wrap = (text, first, hang, style = (t) => t) => {
    let line = first;
    for (const word of text.split(" ")) {
      if (line.length + word.length + 1 > WIDTH + 2 && line.trim()) { console.log(style(line)); line = hang + word; }
      else line += (line === first || line === hang ? "" : " ") + word;
    }
    console.log(style(line));
  };
  const heading = (left, right = "") => {
    console.log(`  ${out(BOLD, left)}${out(DIM, right.padStart(WIDTH - left.length))}`);
    console.log("  " + out(DIM, "─".repeat(WIDTH)));
  };

  console.log(`  ${num(stats.files)} sessions · ${num(stats.requests)} requests · ${stats.first?.slice(0, 10)} to ${stats.last?.slice(0, 10)} · ${out(BOLD, usd(total))} at API prices`);
  if (redact) console.log(out(DIM, "  Names of MCP servers, MCP tools and prompt sections are replaced with placeholders"));
  console.log();

  heading("WHAT TO FIX", "estimated share of cost");
  const shown = findings.filter((f) => f.effect >= 0.005);
  if (!shown.length) console.log("  Nothing above 0.5% of cost. Your setup looks lean.");
  shown.forEach((f, i) => {
    const [what, detail] = f.what.split("; ");
    const effect = (f.upperBound ? "up to " : "") + pct(f.effect);
    const room = WIDTH - effect.length - 6;
    const left = `${String(i + 1).padStart(2)}  ${what.length > room ? what.slice(0, room - 1) + "…" : what}`;
    console.log(`  ${out(BOLD, left)}${out(YELLOW, effect.padStart(Math.max(1, WIDTH - left.length)))}`);
    if (detail) wrap(title(detail), "      ", "      ", (t) => out(DIM, t));
    wrap(f.fix, "      → ", "        ");
  });
  console.log();

  heading("WHERE IT WENT", "share      API $");
  // Keep the table short: fold small MCP servers into one row.
  const small = rows.filter((r) => r.name.startsWith(MCP) && r.share < 0.005);
  const table = rows.filter((r) => !small.includes(r));
  if (small.length) table.push({ name: `${small.length} other MCP servers`, share: small.reduce((n, r) => n + r.share, 0), weighted: small.reduce((n, r) => n + r.weighted, 0), subs: [] });
  for (const r of table) {
    console.log(`  ${title(r.name).slice(0, 30).padEnd(30)}  ${out(CYAN, bar(r.share))}  ${pct(r.share).padStart(6)}  ${usd(r.weighted).padStart(10)}`);
    if (r.share < 0.05 || r.subs.length < 2) continue;
    for (const sub of r.subs.slice(0, 3)) {
      console.log(out(DIM, `      ${pct(sub.share).padStart(6)}  ${sub.name}${sub.calls != null ? ` (${num(sub.calls)} calls)` : ""}`));
    }
  }
  console.log();

  heading("HOW TO READ THIS");
  const notes = [
    "Every figure is an estimate. Usage is priced at published API rates per model; how weekly limits weight it is not published.",
    ...[...assumedPricing].map(([model, as]) => `No published price known for ${model}; priced as ${as}.`),
    `Check: ${q(0.5)?.toFixed(2)} characters per token (median), ${(offRatio * 100).toFixed(1)}% of requests reconstructed poorly, ${num(stats.unattributed)} requests without a request record.`,
    `Claude Code versions: ${[...stats.versions].map(([v, c]) => `${v} (${num(c.attributed + c.unattributed)})`).join(", ")}.`,
    "Nothing left this machine. For a shareable summary: node prototype.mjs --json --redact",
  ];
  for (const note of notes) wrap(note, "  · ", "    ", (t) => out(DIM, t));
  console.log();
}
