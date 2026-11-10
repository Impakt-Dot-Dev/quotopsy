#!/usr/bin/env node
// Quotopsy go/no-go prototype (spec build step 1).
// Reads Claude Code session logs locally and estimates which part of the
// context each weighted token belongs to. No network, no LLM calls, no deps.
//
//   node prototype.mjs [logs-dir] [--json] [--redact] [--debug]
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
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";

// HYPOTHESIS: usage is weighted at published API prices, so one unit is one
// API-equivalent dollar. Whether weekly limits weight token types and models
// the same way is unpublished.
// Per model: [input $/MTok, cache read $/MTok]. Output is 5x input, cache
// writes are 1.25x (5 min) and 2x (1 h) input. From Anthropic's pricing page,
// checked 2026-11-10.
const PRICES = {
  "claude-fable-5-2": [8, 0.2], "claude-mythos-5-2": [8, 0.2], "claude-fable-5-1": [10, 0.25], "claude-mythos-5-1": [10, 0.25], "claude-fable-5": [10, 1], "claude-mythos-5": [10, 1],
  "claude-opus-5-5": [4, 0.2], "claude-opus-5": [5, 0.5], "claude-opus-4-8": [5, 0.5], "claude-opus-4-7": [5, 0.5], "claude-opus-4-6": [5, 0.5], "claude-opus-4-5": [5, 0.5],
  "claude-opus-4-1": [15, 1.5], "claude-opus-4": [15, 1.5],
  "claude-sonnet-5-5": [2, 0.1], "claude-sonnet-5": [2, 0.2], "claude-sonnet-4-6": [3, 0.3], "claude-sonnet-4-5": [3, 0.3], "claude-sonnet-4": [3, 0.3],
  "claude-haiku-5-5": [0.1, 0.01], "claude-haiku-4-5": [1, 0.1],
};
// Models missing from the table are priced like the newest listed model of
// the same family, and reported so the reader knows.
const FAMILY = { fable: "claude-fable-5-2", mythos: "claude-mythos-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
const MCP = "MCP server: ";
const isMcp = (name) => name.startsWith("mcp__");
const count = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

function findJsonl(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findJsonl(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
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

// Blob hashes are SHA-256 of the message as compact JSON with sorted keys.
const sorted = (v) => Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v;
export const hashMessage = (m) => createHash("sha256").update(JSON.stringify(sorted(m))).digest("hex");

// The public model name inside a logged model id. Drops date suffixes and
// provider wrappers such as Bedrock ARNs, which can carry an account number.
const MODEL_ID = /claude-(?:fable|mythos|opus|sonnet|haiku)-\d+(?:-\d{1,2})?(?!\d)/;

function splitUsage(u) {
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  // Older logs only have the total; treat what is not one-hour as five-minute.
  const write5m = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - write1h);
  const write = write1h + write5m;
  const output = u.output_tokens ?? 0;
  const thinking = Math.min(output, u.output_tokens_details?.thinking_tokens ?? 0);
  return { fresh: u.input_tokens ?? 0, read: u.cache_read_input_tokens ?? 0, write, write1h, write5m, output, thinking };
}

// Analyse every session log under `root` and return the summary object.
// `onProgress(done, total)` is called before each file is read.
export function analyze(root, { redact = false, debug: debugOn = false, onProgress = () => {} } = {}) {
  const assumedPricing = new Map(); // model -> model whose prices were used
  const modelName = (model) => MODEL_ID.exec(model ?? "")?.[0] ?? (model ? alias("model", String(model)) : "unknown");
  function rates(model, usage = {}) {
    const id = modelName(model);
    let key = id in PRICES ? id : null;
    if (!key) {
      key = FAMILY[Object.keys(FAMILY).find((f) => String(model ?? "").includes(f))] ?? "claude-opus-5-5";
      assumedPricing.set(id, key);
    }
    const [input, read] = PRICES[key];
    let per = 1e-6;
    if (usage.speed === "fast") per *= 2; // fast mode bills at 2x
    if (usage.inference_geo === "us") per *= 1.1; // US-only inference surcharge
    // Haiku 5.5 bills 5x on requests whose prompt is over 100,000 tokens.
    const prompt = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    if (key === "claude-haiku-5-5" && prompt > 100000) per *= 5;
    return { fresh: input * per, write5m: 1.25 * input * per, write1h: 2 * input * per, read: read * per, output: 5 * input * per };
  }

  const mcpServers = new Set(); // servers the log says injected instructions
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
    let label = "(no heading)", inMcp = false, inFence = false, chars = 0;
    const flush = () => { if (chars) out.push([label, chars]); chars = 0; };
    for (const line of text.split("\n")) {
      // A "# ..." line inside a code fence is a comment, not a heading.
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      const top = !inFence && /^# (.+)/.exec(line), sub = !inFence && /^## (.+)/.exec(line);
      // A <tag> on its own line opens a block; its closing tag ends the block
      // without handing the text that follows to the previous heading.
      const open = /^<([a-z][\w-]*)>\s*$/.exec(line), close = /^<\/([a-z][\w-]*)>\s*$/.exec(line);
      if (open) { flush(); inMcp = false; label = alias("section", `<${open[1]}>`); }
      else if (close) { chars += line.length + 1; flush(); label = "(no heading)"; continue; }
      else if (top) { flush(); inMcp = top[1].startsWith("MCP Server Instructions"); label = alias("section", top[1].slice(0, 40)); }
      // A server's own instructions may contain "## ..." lines; when the log
      // names the servers, only those start a new one.
      else if (sub && inMcp && (!mcpServers.size || mcpServers.has(sub[1].trim()))) { flush(); label = "MCP instructions: " + alias("server", sub[1].slice(0, 40)); }
      chars += line.length + 1;
    }
    flush();
    return out;
  }

  // One logged message -> [category, sub, chars] segments, in prompt order.
  function blobSegments(msg, toolNames) {
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && typeof b === "object");
    return blocks.flatMap((b) => {
      const chars = blockChars(b);
      if (msg.role === "system") return sections(b.text ?? "").map(([s, c]) => ["injected system messages", s, c]);
      if (msg.role === "assistant") return [["assistant history", b.type, chars]];
      if (b.type === "tool_result") return [["tool results", toolLabel(toolNames.get(b.tool_use_id) ?? "(unknown tool)"), chars]];
      return [["user messages", (b.text ?? "").startsWith("<system-reminder>") ? "injected reminders" : "typed or pasted", chars]];
    });
  }

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
      if (!o || typeof o !== "object") continue;
      count(recordTypes, String(o.type));
      if (o.type === "api-request-blob") { if (o.message && typeof o.message === "object") blobs.set(o.hash, o.message); }
      else if (o.type === "api-request-shape") { if (o.shape && typeof o.shape === "object") shapes.set(o.shapeHash, o.shape); }
      else if (o.type === "api-request") { if (o.id) requests.push(o); }
      else if (o.type === "attachment") {
        // Context Claude Code injects by itself: skill and agent listings,
        // MCP instructions, memory and instruction files. Sizes only.
        const a = attachments.get(o.attachment?.type ?? "unknown") ?? { count: 0, chars: 0 };
        a.count++;
        for (const r of Array.isArray(o.rendered) ? o.rendered : []) a.chars += typeof r?.content === "string" ? r.content.length : 0;
        attachments.set(o.attachment?.type ?? "unknown", a);
        if (o.attachment?.type === "mcp_instructions_delta" && Array.isArray(o.attachment.addedNames)) for (const n of o.attachment.addedNames) mcpServers.add(String(n).trim());
      }
      else if (o.type === "assistant" && o.message?.usage) {
        // One record per content block, each repeating the message's usage.
        const key = o.requestRef ?? null;
        if (String(o.message.model ?? "").startsWith("<")) continue; // synthetic local message, not an API call
        const content = (Array.isArray(o.message.content) ? o.message.content : []).filter((b) => b && typeof b === "object");
        (key ? responses : orphans).set(key ?? o.message.id, { id: o.message.id, usage: o.message.usage, model: o.message.model, version: o.version, sidechain: !!o.isSidechain, ts: o.timestamp, thread: o.isSidechain ? `agent ${o.agentId ?? ""}` : "main" });
        for (const b of content) if (b.type === "tool_use") toolNames.set(b.id, String(b.name ?? "unknown"));
        turns.set(o.message.id, [...(turns.get(o.message.id) ?? []), ...content]);
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
    // A response whose request was not logged is usage without a known cause.
    const logged = new Set(requests.map((r) => r.id));
    for (const [ref, res] of responses) if (!logged.has(ref)) { orphans.set(`ref ${ref}`, res); responses.delete(ref); }
    return { blobs, shapes, requests, responses, orphans, toolNames, recordTypes };
  }

  const cats = new Map(); // category -> { read, write, fresh, output, weighted, subs }
  const bump = (cat, sub, kind, tokens, weighted) => {
    const c = cats.get(cat) ?? { read: 0, write: 0, fresh: 0, output: 0, weighted: 0, subs: new Map() };
    c[kind] += tokens; c.weighted += weighted;
    c.subs.set(sub, (c.subs.get(sub) ?? 0) + weighted);
    cats.set(cat, c);
  };

  const stats = { files: 0, failedFiles: 0, requests: 0, noResponse: 0, unattributed: 0, missingBlobs: 0, charsPerToken: [], models: new Map(), versions: new Map(), sources: new Map(), first: null, last: null };
  // Claude Code version -> requests that could and could not be attributed
  const coverage = (version, key) => {
    const v = stats.versions.get(version ?? "unknown") ?? { attributed: 0, unattributed: 0 };
    v[key]++; stats.versions.set(version ?? "unknown", v);
  };
  // Cost per model and per thread (main conversation or a subagent type).
  const byModel = new Map(), byThread = new Map();
  const spend = (map, key, input, output) => {
    const e = map.get(key) ?? { requests: 0, cost: 0, output: 0 };
    e.requests++; e.cost += input + output; e.output += output; map.set(key, e);
  };
  // Built-in subagent types are public; custom ones are named by the user.
  const threadOf = (source = "") => {
    if (source.startsWith("agent:builtin:")) return "subagent: " + source.slice(14);
    if (source.startsWith("agent:custom")) return "subagent: " + alias("agent", source.slice(13) || "custom");
    return source.startsWith("agent") ? "subagent: " + alias("agent", source) : "main thread";
  };
  const seen = (ts) => {
    if (!ts) return;
    stats.first = !stats.first || ts < stats.first ? ts : stats.first;
    stats.last = !stats.last || ts > stats.last ? ts : stats.last;
  };
  const attachments = new Map(); // attachment type -> { count, chars }
  const calls = new Map(); // tool group or tool name -> call count
  const loadedIn = new Map(); // tool group -> requests that carried its schemas
  const rebuilds = [];

  // Structure-only diagnostics for --debug. Sizes, counts and type names; the
  // only names are tool and section labels, which --redact replaces.
  const DEBUG_CAP = 50;
  const debug = { recordTypes: new Map(), unattributed: new Map(), offRequests: [], unknownRebuilds: [], offRequestCount: 0 };
  // Content block types of a message, including those nested in tool results.
  function blockTypes(msg, into) {
    for (const b of Array.isArray(msg.content) ? msg.content.filter((b) => b && typeof b === "object") : [{ type: "text" }]) {
      count(into, `${msg.role}:${b.type}`);
      if (b.type === "tool_result" && Array.isArray(b.content)) for (const inner of b.content) count(into, `tool_result>${inner.type}`);
    }
  }

  const files = findJsonl(root);

  // Forked or copied sessions can repeat records; count each call once.
  const counted = new Set();
  const answered = new Map(); // request id -> what a follow-up needs to compare against
  // Typical characters per token, from requests reconstructed in full.
  const clean = { chars: 0, tokens: 0 };
  const UNRESOLVED = "unresolved messages";

  for (const file of files) {
    onProgress(stats.files, files.length);
    stats.files++;
    // One unreadable session should not lose the rest.
    try { readSession(file); } catch { stats.failedFiles++; }
  }

  function readSession(file) {
    const s = parseSession(file);
    for (const name of s.toolNames.values()) { count(calls, toolLabel(name)); count(calls, toolGroup(name)); }

    // Sessions without request records: usage is known, its cause is not.
    for (const [type, n] of s.recordTypes) debug.recordTypes.set(type, (debug.recordTypes.get(type) ?? 0) + n);
    const lastOrphan = new Map(); // thread -> its previous message
    for (const { id, usage, model, version, sidechain, ts, thread } of s.orphans.values()) {
      if (id && counted.has(id)) continue;
      counted.add(id);
      coverage(version, "unattributed");
      count(stats.models, modelName(model));
      seen(ts);
      count(debug.unattributed, `version ${version ?? "unknown"}, ${sidechain ? "subagent" : "main"} thread, file ${s.requests.length ? "has" : "has no"} request records`);
      const u = splitUsage(usage), w = rates(model, usage);
      const cat = "unattributed input";
      stats.unattributed++;
      bump(cat, "cache read", "read", u.read, u.read * w.read);
      bump(cat, "cache write", "write", u.write, u.write5m * w.write5m + u.write1h * w.write1h);
      bump(cat, "fresh input", "fresh", u.fresh, u.fresh * w.fresh);
      bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
      bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);
      const writeCost = u.write5m * w.write5m + u.write1h * w.write1h;
      spend(byModel, modelName(model), u.fresh * w.fresh + writeCost + u.read * w.read, u.output * w.output);
      spend(byThread, sidechain ? "subagent: (type not logged)" : "main thread", u.fresh * w.fresh + writeCost + u.read * w.read, u.output * w.output);

      // Without request records, usage alone still shows a cache lost to
      // idle time: little is read back and the prompt is written again.
      // Other causes cannot be told apart here, so only idle is reported.
      const prompt = u.fresh + u.write + u.read, prev = lastOrphan.get(thread);
      const lost = prev ? Math.min(u.write, prev.prompt - u.read) : 0;
      const gapMin = prev ? (Date.parse(ts) - Date.parse(prev.ts)) / 60000 : 0;
      if (prev && u.read < 0.8 * prev.prompt && lost > 5000 && gapMin > prev.ttlMin) {
        rebuilds.push({ cause: "idle longer than the cache lifetime", tokens: lost, wasted: lost * (writeCost / u.write - w.read), at: ts, gapMin: Math.round(gapMin) });
      }
      lastOrphan.set(thread, { prompt, ts, ttlMin: u.write1h || !u.write ? 60 : 5 });
    }

    // Requests are delta-encoded: messages = base's first `keep` + `tail`.
    const msgLists = new Map();
    const lastOf = new Map(); // first message hash -> same, for the conversation's latest request
    for (const req of s.requests) {
      const baseList = msgLists.get(req.base), tail = Array.isArray(req.tail) ? req.tail : [], keep = req.keep ?? 0;
      const baseLen = (baseList ?? []).length;
      // Messages kept from a base request that is not in this log.
      const lostPrefix = req.base && !baseList ? keep : 0;
      const hashes = [...(baseList ?? []).slice(0, keep), ...tail];
      msgLists.set(req.id, hashes);
      const res = s.responses.get(req.id);
      if (!res) { stats.noResponse++; continue; }
      if (counted.has(req.id)) continue;
      counted.add(req.id);
      stats.requests++;
      count(stats.models, modelName(res.model));
      const source = redact ? threadOf(req.querySource) : req.querySource ?? "unknown";
      count(stats.sources, source);
      coverage(req.version, "attributed");
      seen(req.timestamp);

      const u = splitUsage(res.usage), w = rates(res.model, res.usage);
      bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
      bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);
      const inputCost = u.fresh * w.fresh + u.write5m * w.write5m + u.write1h * w.write1h + u.read * w.read;
      spend(byModel, modelName(res.model), inputCost, u.output * w.output);
      spend(byThread, threadOf(req.querySource), inputCost, u.output * w.output);

      // Prompt order is tools, system, messages; the cache covers a prefix of it.
      const shape = s.shapes.get(req.shapeHash) ?? {};
      const tools = (Array.isArray(shape.tools) ? shape.tools : []).filter((t) => t && typeof t === "object").map((t) => [String(t.name ?? "unknown"), t]);
      const system = typeof shape.system === "string" ? [{ text: shape.system }] : Array.isArray(shape.system) ? shape.system : [];
      for (const g of new Set(tools.map(([name]) => toolGroup(name)))) count(loadedIn, g);
      const segs = [
        ...tools.map(([name, t]) => [toolGroup(name), toolLabel(name), JSON.stringify(t).length]),
        ...system.flatMap((b) => sections(String(b?.text ?? "")).map(([sec, c]) => ["system prompt", sec, c])),
      ];
      // A message that cannot be found leaves a hole of unknown size.
      let missing = lostPrefix;
      if (lostPrefix) segs.push([UNRESOLVED, "kept from a request not in the log", null]);
      for (const h of hashes) {
        const m = s.blobs.get(h);
        if (m) segs.push(...blobSegments(m, s.toolNames));
        else { missing++; segs.push([UNRESOLVED, "message not in the log", null]); }
      }
      stats.missingBlobs += missing;
      const prompt = u.fresh + u.write + u.read;
      if (missing) {
        // ESTIMATE: size the holes from the usual characters-per-token ratio,
        // so their cost is not spread over the messages that were found.
        const known = segs.reduce((n, seg) => n + (seg[2] ?? 0), 0);
        const holes = segs.filter((seg) => seg[2] === null);
        const gap = Math.max(0, prompt * (clean.tokens ? clean.chars / clean.tokens : 2.9) - known);
        for (const seg of holes) seg[2] = gap / holes.length;
      }
      const chars = segs.reduce((n, seg) => n + seg[2], 0);
      const attributable = chars > 0 && prompt > 0;
      if (prompt > 0 && !attributable) {
        // Nothing of the prompt could be rebuilt: keep its cost, without a cause.
        bump("unattributed input", "cache read", "read", u.read, u.read * w.read);
        bump("unattributed input", "cache write", "write", u.write, u.write5m * w.write5m + u.write1h * w.write1h);
        bump("unattributed input", "fresh input", "fresh", u.fresh, u.fresh * w.fresh);
      }
      if (attributable && !missing) {
        stats.charsPerToken.push(chars / prompt);
        clean.chars += chars; clean.tokens += prompt;
      }
      if (debugOn && attributable && !missing && (chars / prompt < 2 || chars / prompt > 4.5) && debug.offRequestCount++ < DEBUG_CAP) {
        const byCat = new Map(), types = new Map();
        for (const [cat, , c] of segs) byCat.set(cat, (byCat.get(cat) ?? 0) + c);
        for (const h of hashes) if (s.blobs.has(h)) blockTypes(s.blobs.get(h), types);
        debug.offRequests.push({
          charsPerToken: chars / prompt, version: req.version, source, model: modelName(res.model), usage: u,
          messages: hashes.length, missingMessages: missing, keep, tail: tail.length, hasBase: !!req.base, baseKnown: !!baseList,
          charsByCategory: Object.fromEntries(byCat), blockTypes: Object.fromEntries(types),
          largestSegments: [...segs].sort((a, b) => b[2] - a[2]).slice(0, 3).map(([cat, sub, c]) => ({ category: cat, sub, chars: c })),
        });
      }

      // ESTIMATE: scale chars to the request's real token total, then charge
      // each segment by position: first `read` tokens, then `write`, then fresh.
      const perChar = attributable ? prompt / chars : 0;
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
          : keep < baseLen ? "conversation edited or compacted"
          : req.shapeHash !== prev.shapeHash ? "tool list or system prompt changed"
          : "unknown";
        rebuilds.push({ cause, tokens: lost, wasted: lost * (writeRate - w.read), at: req.timestamp, gapMin: Math.round(gapMin) });
        if (debugOn && cause === "unknown" && debug.unknownRebuilds.length < DEBUG_CAP) {
          debug.unknownRebuilds.push({
            version: req.version, source, gapMin, previousPrompt: prev.prompt, usage: u, ttlMin: prev.ttlMin,
            keep, baseMessages: baseLen, tail: tail.length, matchedBy: answered.has(req.base) ? "base" : "first message",
          });
        }
      }
      answered.set(req.id, { prompt, ts: req.timestamp, model: res.model, shapeHash: req.shapeHash, ttlMin: u.write1h || !u.write ? 60 : 5 });
      lastOf.set(hashes[0], answered.get(req.id));
    }
  }

  const total = [...cats.values()].reduce((n, c) => n + c.weighted, 0);
  const share = (x) => (total ? x / total : 0);
  const rows = [...cats.entries()].map(([name, c]) => ({
    name, read: c.read, write: c.write, fresh: c.fresh, output: c.output, weighted: c.weighted, share: share(c.weighted), calls: calls.get(name) ?? null,
    subs: [...c.subs.entries()].map(([sub, w]) => ({ name: sub, share: share(w), calls: calls.get(sub) ?? null })).sort((a, b) => b.share - a.share),
  })).sort((a, b) => b.weighted - a.weighted);
  const row = (name) => rows.find((r) => r.name === name);

  // Findings: things the category table does not spell out. All ESTIMATES.
  const findings = [];
  const byCause = new Map();
  for (const r of rebuilds) byCause.set(r.cause, [...(byCause.get(r.cause) ?? []), r]);
  const rebuildFix = {
    "model switched mid-session": "Pick the model before the first message, or switch in a new session.",
    "idle longer than the cache lifetime": "Before a long break, compact the conversation, or start a new session afterwards if you do not need the history. The saving is smaller than this figure when you do need it.",
    "conversation edited or compacted": "Compact at a natural break, before the conversation is large.",
    "tool list or system prompt changed": "Connect MCP servers before the session starts, not during it.",
    "unknown": "No fix identified yet.",
  };
  for (const [cause, list] of byCause) {
    const wasted = list.reduce((n, r) => n + r.wasted, 0);
    findings.push({ effect: share(wasted), what: `Cache rebuilt ${list.length}x: ${cause}; ${Math.round(list.reduce((n, r) => n + r.tokens, 0) / 1000)}k tokens paid for twice`, fix: rebuildFix[cause] });
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

  const ranked = (map) => [...map.entries()]
    .map(([name, e]) => ({ name, requests: e.requests, cost: e.cost, share: share(e.cost), costPerRequest: e.cost / e.requests, outputShare: e.cost ? e.output / e.cost : 0 }))
    .sort((a, b) => b.cost - a.cost);
  const cpt = stats.charsPerToken.sort((a, b) => a - b);
  const q = (p) => cpt[Math.min(cpt.length - 1, Math.floor(p * cpt.length))];
  // Requests whose reconstructed prompt is far from the billed token count.
  const offRatio = cpt.filter((x) => x < 2 || x > 4.5).length / (cpt.length || 1);
  const summary = {
    contains: "Token totals, counts, timestamps and model names. No message text or tool output. "
      + (redact ? "Names of MCP servers, MCP tools and custom subagents, and prompt section headings, are replaced with placeholders."
        : "Includes names of MCP servers, tools and custom subagents, and prompt section headings (lines that start with #); rerun with --redact to replace them."),
    redacted: redact,
    unit: "API-equivalent US dollars at published prices (hypothesis: limits may weight usage differently)",
    prices: PRICES, assumedPricing: Object.fromEntries(assumedPricing),
    files: stats.files, filesFailed: stats.failedFiles, requests: stats.requests, requestsWithoutResponse: stats.noResponse, unattributedMessages: stats.unattributed, missingBlobs: stats.missingBlobs,
    from: stats.first, to: stats.last, models: Object.fromEntries(stats.models),
    charsPerToken: { min: cpt[0], p5: q(0.05), median: q(0.5), p95: q(0.95), max: cpt[cpt.length - 1], shareOutside2to4_5: offRatio },
    claudeCodeVersions: Object.fromEntries(stats.versions), querySources: Object.fromEntries(stats.sources),
    totalWeighted: total, categories: rows, cacheRebuilds: rebuilds, findings,
    byModel: ranked(byModel), byThread: ranked(byThread),
    injectedByType: Object.fromEntries([...attachments].sort((a, b) => b[1].chars - a[1].chars)),
  };
  if (debugOn) {
    summary.debug = {
      contains: "Structure only: record types, block types, sizes and counts. No message text.",
      recordTypes: Object.fromEntries(debug.recordTypes), unattributed: Object.fromEntries(debug.unattributed),
      offRequestsTotal: debug.offRequestCount, offRequests: debug.offRequests, unknownRebuilds: debug.unknownRebuilds,
    };
  }
  return summary;
}

// Terminal styling. Progress and banner go to stderr so piped or redirected
// output stays clean; colour is used only on a terminal that wants it.
const noColor = globalThis.Deno ? globalThis.Deno.noColor : "NO_COLOR" in process.env;
const paint = (stream) => (code, text) => (stream.isTTY && !noColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const out = paint(process.stdout), err = paint(process.stderr);
const BOLD = 1, DIM = 2, CYAN = 36, YELLOW = 33, GREEN = 32;
const BANNER = ["┌─┐ ┬ ┬┌─┐┌┬┐┌─┐┌─┐┌─┐┬ ┬", "│─┼┐│ ││ │ │ │ │├─┘└─┐└┬┘", "└─┘└└─┘└─┘ ┴ └─┘┴  └─┘ ┴ "];
const bar = (share, width = 20) => "█".repeat(Math.round(share * width)).padEnd(width, "░");
const num = (n) => Math.round(n).toLocaleString("en-US");

function printReport(summary, redact) {
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

  console.log(`  ${num(summary.files)} sessions · ${num(summary.requests + summary.unattributedMessages)} requests · ${summary.from?.slice(0, 10)} to ${summary.to?.slice(0, 10)} · ${out(BOLD, usd(summary.totalWeighted))} at API prices`);
  if (redact) console.log(out(DIM, "  Names of MCP servers, MCP tools and prompt sections are replaced with placeholders"));
  console.log();

  heading("WHAT TO FIX", "estimated share of cost");
  const shown = summary.findings.filter((f) => f.effect >= 0.005);
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
  const small = summary.categories.filter((r) => r.name.startsWith(MCP) && r.share < 0.005);
  const table = summary.categories.filter((r) => !small.includes(r));
  if (small.length) table.push({ name: `${small.length} other MCP servers`, share: small.reduce((n, r) => n + r.share, 0), weighted: small.reduce((n, r) => n + r.weighted, 0), subs: [] });
  for (const r of table) {
    console.log(`  ${title(r.name).slice(0, 30).padEnd(30)}  ${out(CYAN, bar(r.share))}  ${pct(r.share).padStart(6)}  ${usd(r.weighted).padStart(10)}`);
    if (r.share < 0.05 || r.subs.length < 2) continue;
    for (const sub of r.subs.slice(0, 3)) {
      console.log(out(DIM, `      ${pct(sub.share).padStart(6)}  ${sub.name}${sub.calls != null ? ` (${num(sub.calls)} calls)` : ""}`));
    }
  }
  console.log();

  // Who spent it: shown only when there is more than one to compare.
  for (const [name, list] of [["BY MODEL", summary.byModel], ["BY THREAD", summary.byThread]]) {
    if (list.length < 2) continue;
    heading(name, "requests   per request    share      API $");
    for (const r of list.slice(0, 8)) {
      console.log(`  ${r.name.slice(0, 28).padEnd(28)}${num(r.requests).padStart(10)}${usd(r.costPerRequest).padStart(14)}${pct(r.share).padStart(9)}${usd(r.cost).padStart(11)}`);
    }
    if (list.length > 8) console.log(out(DIM, `  and ${list.length - 8} more`));
    console.log();
  }

  heading("HOW TO READ THIS");
  const notes = [
    "Every figure is an estimate. Usage is priced at published API rates per model; how weekly limits weight it is not published.",
    ...Object.entries(summary.assumedPricing).map(([model, as]) => `No published price known for ${model}; priced as ${as}.`),
    `Check: ${summary.charsPerToken.median?.toFixed(2)} characters per token (median), ${(summary.charsPerToken.shareOutside2to4_5 * 100).toFixed(1)}% of requests reconstructed poorly, ${num(summary.unattributedMessages)} requests without a request record.`,
    `Claude Code versions: ${Object.entries(summary.claudeCodeVersions).map(([v, c]) => `${v} (${num(c.attributed + c.unattributed)})`).join(", ")}.`,
    ...(summary.filesFailed ? [`${num(summary.filesFailed)} session files could not be read and are left out.`] : []),
    "Nothing left this machine. For a shareable summary: node prototype.mjs --json --redact",
  ];
  for (const note of notes) wrap(note, "  · ", "    ", (t) => out(DIM, t));
  console.log();
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json"), redact = args.includes("--redact"), debug = args.includes("--debug");
  const root = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".claude", "projects");

  const started = Date.now();
  let lastDraw = 0, bannerShown = false;
  const onProgress = (done, total) => {
    if (!process.stderr.isTTY) return;
    if (!bannerShown) {
      bannerShown = true;
      process.stderr.write(`\n${BANNER.map((l) => "  " + err(CYAN, l)).join("\n")}\n  ${err(DIM, "where did your Claude Code usage go?")}\n\n`);
    }
    if (Date.now() - lastDraw < 60 && done < total) return;
    lastDraw = Date.now();
    process.stderr.write(`\r  Reading sessions  ${err(CYAN, bar(done / total, 24))}  ${done}/${total}`);
  };

  let summary;
  try { summary = analyze(root, { redact, debug, onProgress }); } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
  if (!summary?.files) {
    console.error(`No Claude Code session logs found in ${root}\nPass the folder that holds them: node prototype.mjs <logs-dir>`);
    process.exit(1);
  }
  if (process.stderr.isTTY) {
    process.stderr.write(`\r\x1b[2K  ${err(GREEN, "✓")} Read ${num(summary.files)} sessions and ${num(summary.requests + summary.unattributedMessages)} requests in ${((Date.now() - started) / 1000).toFixed(1)}s, on this machine only\n\n`);
  }

  if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    if (process.stderr.isTTY && !process.stdout.isTTY) process.stderr.write(`  Summary written${redact ? ", with names replaced by placeholders" : ""}. Have a look before you share it.\n\n`);
  } else if (!summary.totalWeighted) {
    console.log("  The logs contain no usage records yet.");
  } else {
    printReport(summary, redact);
  }
}

// Run only when executed directly, not when imported by the tests.
const isMain = import.meta.main ?? (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main();
