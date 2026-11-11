#!/usr/bin/env node
// Quotopsy: reads Claude Code session logs locally and estimates which part of the
// context each weighted token belongs to. No network, no LLM calls, no deps.
//
//   node quotopsy.mjs [logs-dir] [--json] [--redact] [--debug]
//
// --redact replaces MCP server names, MCP tool names and prompt section
// headings with numbered placeholders, for output that will be shared.
// --debug adds structure-only diagnostics to the JSON (record types, block
// types, sizes and counts for requests the tool handled badly). No text.
//
// Uses only node: builtins, so it also runs under
//   deno run --allow-read=$HOME/.claude --deny-net quotopsy.mjs $HOME/.claude/projects
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
// Kept equal to "version" in package.json; a test checks it.
export const VERSION = "0.4.2";
const MCP = "MCP server: ", INSTRUCTIONS = "MCP instructions: ";
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

// Claude Code logs thinking as an encrypted signature, usually with no text,
// and sends it back with every later request. Counting the signature as plain
// text overstates what that costs. ESTIMATE, fitted on 537 real requests from
// one machine: the billed prompt size is explained most consistently when the
// first 1,000 characters of a signature count for nothing and the rest count
// 1.4 times. `thinkingSignatures` in the summary lets other logs check this.
const SIGNATURE_OVERHEAD = 1000, SIGNATURE_TO_TEXT = 1.4;
function thinkingChars(b) {
  const text = typeof b.thinking === "string" ? b.thinking.length : 0;
  const signature = typeof b.signature === "string" ? b.signature.length : 0;
  return Math.max(text, (signature - SIGNATURE_OVERHEAD) * SIGNATURE_TO_TEXT, 0);
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
// `since` and `until` (milliseconds) limit the summary to usage from `since`
// up to, not including, `until`. Earlier requests are still read, because
// later ones are logged as changes to them.
export function analyze(root, { redact = false, debug: debugOn = false, onProgress = () => {}, since = null, until = null } = {}) {
  const filtered = since !== null || until !== null;
  const inRange = (ts) => {
    if (!filtered) return true;
    const t = Date.parse(ts);
    return (since === null || t >= since) && (until === null || t < until);
  };
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

  // Tool names carry the server name with other characters turned into "_";
  // do the same to names from instruction headings so the two meet.
  const serverRow = (server) => MCP + alias("server", String(server).trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40));
  function toolGroup(name) {
    return isMcp(name) ? serverRow(name.split("__")[1]) : "built-in tools";
  }
  // The row a tool's costs add up under: its own for a built-in tool, its
  // server's for an MCP tool.
  function culpritOf(name) {
    return isMcp(name) ? toolGroup(name) : name;
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
      else if (sub && inMcp && (!mcpServers.size || mcpServers.has(sub[1].trim()))) { flush(); label = INSTRUCTIONS + serverRow(sub[1]).slice(MCP.length); }
      chars += line.length + 1;
    }
    flush();
    return out;
  }

  // Prompt text -> segments by heading. A server's instructions, and its tool
  // names where the prompt lists them, are charged to that server as the
  // cost of keeping it connected.
  function promptSegments(category, text) {
    const names = new Map(); // server row -> characters spent naming its tools
    for (const [name] of text.matchAll(/mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_-]+/g)) names.set(toolGroup(name), (names.get(toolGroup(name)) ?? 0) + name.length + 1);
    const named = Math.min(text.length, [...names.values()].reduce((n, c) => n + c, 0));
    const rest = text.length ? (text.length - named) / text.length : 0;
    return [
      ...sections(text).map(([sec, c]) => [category, sec, c * rest, sec.startsWith(INSTRUCTIONS) ? [MCP + sec.slice(INSTRUCTIONS.length), "connected"] : null]),
      ...[...names].map(([server, c]) => { withTools.add(server); return [category, "MCP tool names", c * named / [...names.values()].reduce((n, x) => n + x, 0), [server, "connected"]]; }),
    ];
  }

  // One logged message -> [category, sub, chars, culprit] segments, in prompt
  // order. `culprit` is [tool or server, which of its costs], when there is one.
  function blobSegments(msg, toolNames) {
    const blocks = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : (Array.isArray(msg.content) ? msg.content : []).filter((b) => b && typeof b === "object");
    return blocks.flatMap((b) => {
      const chars = b.type === "thinking" ? thinkingChars(b) : blockChars(b);
      if (msg.role === "system") return promptSegments("injected system messages", b.text ?? "");
      if (msg.role === "assistant") return [["assistant history", b.type, chars, b.type === "tool_use" ? [culpritOf(String(b.name ?? "unknown")), "calling"] : null]];
      if (b.type === "tool_result") {
        const name = toolNames.get(b.tool_use_id) ?? "(unknown tool)";
        return [["tool results", toolLabel(name), chars, [culpritOf(name), "results"]]];
      }
      return [["user messages", (b.text ?? "").startsWith("<system-reminder>") ? "injected reminders" : "typed or pasted", chars]];
    });
  }

  function parseSession(file) {
    const blobs = new Map(), shapes = new Map(), requests = [], responses = new Map();
    const orphans = new Map(); // assistant messages with no logged request
    const toolNames = new Map(); // tool_use id -> tool name
    const toolTimes = new Map(); // tool_use id -> when it was called
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
        if (inRange(o.timestamp)) {
          const a = attachments.get(o.attachment?.type ?? "unknown") ?? { count: 0, chars: 0 };
          a.count++;
          for (const r of Array.isArray(o.rendered) ? o.rendered : []) a.chars += typeof r?.content === "string" ? r.content.length : 0;
          attachments.set(o.attachment?.type ?? "unknown", a);
        }
        if (o.attachment?.type === "deferred_tools_delta" && inRange(o.timestamp)) {
          // Lists the tools of every connected server, loaded or not.
          for (const key of ["addedNames", "readdedNames", "surfacedNames"]) for (const n of Array.isArray(o.attachment[key]) ? o.attachment[key] : []) {
            if (typeof n === "string" && isMcp(n)) { withTools.add(toolGroup(n)); blame([toolGroup(n), "connected"], 0); }
          }
        }
        if (o.attachment?.type === "mcp_instructions_delta" && Array.isArray(o.attachment.addedNames)) for (const n of o.attachment.addedNames) mcpServers.add(String(n).trim());
      }
      else if (o.type === "assistant" && o.message?.usage) {
        // One record per content block, each repeating the message's usage.
        const key = o.requestRef ?? null;
        if (String(o.message.model ?? "").startsWith("<")) continue; // synthetic local message, not an API call
        const content = (Array.isArray(o.message.content) ? o.message.content : []).filter((b) => b && typeof b === "object");
        (key ? responses : orphans).set(key ?? o.message.id, { id: o.message.id, usage: o.message.usage, model: o.message.model, version: o.version, sidechain: !!o.isSidechain, ts: o.timestamp, thread: o.isSidechain ? `agent ${o.agentId ?? ""}` : "main" });
        for (const b of content) if (b.type === "tool_use") { toolNames.set(b.id, String(b.name ?? "unknown")); toolTimes.set(b.id, o.timestamp); }
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
    return { blobs, shapes, requests, responses, orphans, toolNames, toolTimes, turns, recordTypes };
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
  // Signature size against billed thinking tokens, to check the estimate above.
  const signatures = { responses: 0, chars: 0, thinkingTokens: 0 };
  const signatureChars = (blocks = []) => blocks.reduce((n, b) => n + (b.type === "thinking" && typeof b.signature === "string" ? b.signature.length : 0), 0);
  const signatureCheck = (chars, thinkingTokens) => {
    if (!chars || !thinkingTokens) return;
    signatures.responses++; signatures.chars += chars; signatures.thinkingTokens += thinkingTokens;
  };
  // Per tool or MCP server: what its schema, writing and re-reading its calls,
  // and keeping its results in context cost. ESTIMATES, like every attribution.
  // For an MCP server, `connected` is what its instructions and listed tool
  // names cost: paid whether or not its tools are ever loaded or called.
  const culprits = new Map();
  const blame = ([who, field], weighted) => {
    const c = culprits.get(who) ?? { schema: 0, calling: 0, results: 0, connected: 0 };
    c[field] += weighted; culprits.set(who, c);
  };
  // Servers whose tools were seen by name, so their calls can be counted.
  const withTools = new Set();
  // Output spent writing tool calls: the response's non-thinking output, split
  // across its text and tool-call blocks by size.
  const outputShares = (blocks = []) => {
    const sized = blocks.filter((b) => b.type !== "thinking" && b.type !== "redacted_thinking").map((b) => [b, blockChars(b)]);
    const all = sized.reduce((n, [, c]) => n + c, 0);
    return sized.filter(([b]) => b.type === "tool_use" && all).map(([b, c]) => [culpritOf(String(b.name ?? "unknown")), c / all]);
  };
  const blameOutput = (shares, cost) => { for (const [who, part] of shares) blame([who, "calling"], cost * part); };

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

  // Responses with no logged request wait until every file's requests are
  // counted: a resumed session copies earlier responses whose requests are
  // logged in the file it continues.
  const pendingOrphans = [], sessions = [];
  for (const [i, file] of files.entries()) {
    onProgress(i, files.length);
    // One unreadable session should not lose the rest.
    try { sessions.push(readSession(file)); } catch { stats.failedFiles++; if (!filtered) stats.files++; }
  }
  for (const pending of pendingOrphans) countOrphans(pending);
  stats.files += sessions.filter((session) => session.active).length;

  // Returns the session's state. It counts (`active`) always, unless a period
  // was asked for and the session has no usage in it.
  function readSession(file) {
    const s = parseSession(file);
    const session = { active: !filtered };
    for (const [id, name] of s.toolNames) if (inRange(s.toolTimes.get(id))) {
      count(calls, toolLabel(name)); count(calls, toolGroup(name));
      if (isMcp(name)) { withTools.add(toolGroup(name)); blame([toolGroup(name), "connected"], 0); }
    }

    for (const [type, n] of s.recordTypes) debug.recordTypes.set(type, (debug.recordTypes.get(type) ?? 0) + n);

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
      if (!res) { if (inRange(req.timestamp)) stats.noResponse++; continue; }
      if (counted.has(req.id)) continue;
      counted.add(req.id);
      if (res.id) counted.add(res.id);
      if (!inRange(req.timestamp)) {
        // Outside the period: remember it only as what a later request extends.
        const u = splitUsage(res.usage);
        answered.set(req.id, { prompt: u.fresh + u.write + u.read, ts: req.timestamp, model: res.model, shapeHash: req.shapeHash, ttlMin: u.write1h || !u.write ? 60 : 5 });
        lastOf.set(hashes[0], answered.get(req.id));
        continue;
      }
      session.active = true;
      stats.requests++;
      count(stats.models, modelName(res.model));
      const source = redact ? threadOf(req.querySource) : req.querySource ?? "unknown";
      count(stats.sources, source);
      coverage(req.version, "attributed");
      seen(req.timestamp);

      const u = splitUsage(res.usage), w = rates(res.model, res.usage);
      bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
      bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);
      blameOutput(outputShares(s.turns.get(res.id)), (u.output - u.thinking) * w.output);
      signatureCheck(signatureChars(s.turns.get(res.id)), u.thinking);
      const inputCost = u.fresh * w.fresh + u.write5m * w.write5m + u.write1h * w.write1h + u.read * w.read;
      spend(byModel, modelName(res.model), inputCost, u.output * w.output);
      spend(byThread, threadOf(req.querySource), inputCost, u.output * w.output);

      // Prompt order is tools, system, messages; the cache covers a prefix of it.
      const shape = s.shapes.get(req.shapeHash) ?? {};
      const tools = (Array.isArray(shape.tools) ? shape.tools : []).filter((t) => t && typeof t === "object").map((t) => [String(t.name ?? "unknown"), t]);
      const system = typeof shape.system === "string" ? [{ text: shape.system }] : Array.isArray(shape.system) ? shape.system : [];
      for (const g of new Set(tools.map(([name]) => toolGroup(name)))) { count(loadedIn, g); if (g.startsWith(MCP)) withTools.add(g); }
      for (const [name] of tools) if (!isMcp(name)) count(loadedIn, name);
      const segs = [
        ...tools.map(([name, t]) => [toolGroup(name), toolLabel(name), JSON.stringify(t).length, [culpritOf(name), "schema"]]),
        ...system.flatMap((b) => promptSegments("system prompt", String(b?.text ?? ""))),
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
      for (const [cat, sub, c, culprit] of segs) {
        const end = pos + c * perChar;
        let lo = 0;
        for (const [kind, size, rate] of bands) {
          const overlap = Math.max(0, Math.min(end, lo + size) - Math.max(pos, lo));
          if (overlap) bump(cat, sub, kind, overlap, overlap * rate);
          if (overlap && culprit) blame(culprit, overlap * rate);
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
        rebuilds.push({ cause, tokens: lost, wasted: lost * (writeRate - w.read), at: req.timestamp, gapMin: Math.round(gapMin), version: req.version ?? "unknown" });
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
    pendingOrphans.push({ session, hasRequests: s.requests.length > 0, list: [...s.orphans.values()].map((o) => ({ ...o, calling: outputShares(s.turns.get(o.id)), signature: signatureChars(s.turns.get(o.id)) })) });
    return session;
  }

  // Sessions without request records: usage is known, its cause is not.
  function countOrphans({ session, hasRequests, list }) {
    const lastOrphan = new Map(); // thread -> its previous message
    for (const { id, usage, model, version, sidechain, ts, thread, calling, signature } of list) {
      if (id && counted.has(id)) continue;
      counted.add(id);
      if (!inRange(ts)) {
        // Outside the period: remember it only as what the next one follows.
        const u = splitUsage(usage);
        lastOrphan.set(thread, { prompt: u.fresh + u.write + u.read, ts, ttlMin: u.write1h || !u.write ? 60 : 5 });
        continue;
      }
      session.active = true;
      coverage(version, "unattributed");
      count(stats.models, modelName(model));
      seen(ts);
      count(debug.unattributed, `version ${version ?? "unknown"}, ${sidechain ? "subagent" : "main"} thread, file ${hasRequests ? "has" : "has no"} request records`);
      const u = splitUsage(usage), w = rates(model, usage);
      const cat = "unattributed input";
      stats.unattributed++;
      bump(cat, "cache read", "read", u.read, u.read * w.read);
      bump(cat, "cache write", "write", u.write, u.write5m * w.write5m + u.write1h * w.write1h);
      bump(cat, "fresh input", "fresh", u.fresh, u.fresh * w.fresh);
      bump("output", "thinking", "output", u.thinking, u.thinking * w.output);
      bump("output", "text and tool calls", "output", u.output - u.thinking, (u.output - u.thinking) * w.output);
      blameOutput(calling, (u.output - u.thinking) * w.output);
      signatureCheck(signature, u.thinking);
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
        rebuilds.push({ cause: "idle longer than the cache lifetime", tokens: lost, wasted: lost * (writeCost / u.write - w.read), at: ts, gapMin: Math.round(gapMin), version: version ?? "unknown" });
      }
      lastOrphan.set(thread, { prompt, ts, ttlMin: u.write1h || !u.write ? 60 : 5 });
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
    const instr = share(culprits.get(r.name)?.connected ?? 0);
    const n = loadedIn.get(r.name) ?? 0, k = r.calls ?? 0;
    // Never-called servers are reported together, below.
    if (!k || k / n > 0.05) continue;
    findings.push({ effect: r.share + instr, what: `${server}: schemas loaded in ${n} requests, called ${k}x`, fix: "Disable it, or enable it only in the projects that use it." });
  }
  // Every connected server: what staying connected cost (instructions, tool
  // names, schemas) against what using it cost (calls and their results).
  const byMcpServer = [...culprits.entries()].filter(([who]) => who.startsWith(MCP)).map(([who, c]) => {
    const n = calls.get(who) ?? 0, loaded = loadedIn.get(who) ?? 0, carried = c.connected + c.schema, used = c.calling + c.results;
    // Calls cannot be matched to a server known only by its instructions.
    const verdict = !withTools.has(who) ? "calls unknown" : !n ? "never called" : loaded && n / loaded <= 0.05 ? "rarely called" : "in use";
    return { name: who.slice(MCP.length), calls: n, loadedIn: loaded, carried, used, cost: carried + used, share: share(carried + used), verdict };
  }).sort((a, b) => b.cost - a.cost);
  // Never-called servers, costliest first, in two groups with different fixes:
  // those whose full schemas were loaded anyway, and those that only cost
  // their instructions and tool names.
  const idle = byMcpServer.filter((r) => r.verdict === "never called");
  const top = (list) => list.slice(0, 3).map((r) => r.name).join(", ") + (list.length > 3 ? ` and ${list.length - 3} more` : "");
  const plural = (list) => `${list.length} MCP server${list.length > 1 ? "s" : ""}`;
  const loaded = idle.filter((r) => r.loadedIn > 0), listed = idle.filter((r) => !r.loadedIn);
  if (loaded.length) findings.push({
    effect: loaded.reduce((n, r) => n + r.share, 0),
    what: `${plural(loaded)} never called, with schemas loaded anyway; ${top(loaded)}`,
    fix: "Schemas should load only when a tool is needed: check that ENABLE_TOOL_SEARCH is not set to false. Then disable what this project does not need, at the start of a session: /mcp disable <name>",
  });
  if (listed.length) findings.push({
    effect: listed.reduce((n, r) => n + r.share, 0),
    what: `${plural(listed)} connected but never called; costliest first: ${top(listed)}`,
    fix: "Their instructions and tool names load in every request. Disable what this project does not need, at the start of a session: /mcp disable <name>",
  });
  for (const r of byMcpServer.filter((r) => r.verdict === "calls unknown" && r.share > 0)) {
    findings.push({ effect: r.share, what: `${r.name}: instructions loaded in every session; whether you use it cannot be measured`, fix: "Disconnect it if you do not use it." });
  }
  const thinking = row("output")?.subs.find((x) => x.name === "thinking");
  // Thinking is paid for twice: once written as output, then re-read as part
  // of the history in every later request.
  const reread = row("assistant history")?.subs.find((x) => x.name === "thinking")?.share ?? 0;
  if (thinking) findings.push({ effect: thinking.share + reread, upperBound: true, what: `Thinking tokens; ${(thinking.share * 100).toFixed(1)}% written as output, ${(reread * 100).toFixed(1)}% re-read in later requests`, fix: "Lower the effort level for routine work. Upper bound: the saving depends on how much less it thinks." });
  const topResult = row("tool results")?.subs[0];
  if (topResult) findings.push({ effect: topResult.share, upperBound: true, what: `Results of ${topResult.name} (${topResult.calls ?? 0} calls) kept in context`, fix: "Ask for narrower output (line ranges, filters), or hand bulky reads to a subagent." });
  findings.sort((a, b) => b.effect - a.effect);

  const ranked = (map) => [...map.entries()]
    .map(([name, e]) => ({ name, requests: e.requests, cost: e.cost, share: share(e.cost), costPerRequest: e.cost / e.requests, outputShare: e.cost ? e.output / e.cost : 0 }))
    .sort((a, b) => b.cost - a.cost);
  const byTool = [...culprits.entries()].map(([who, c]) => {
    const cost = c.schema + c.calling + c.results;
    return {
      name: who.startsWith(MCP) ? who.slice(MCP.length) : who, kind: who.startsWith(MCP) ? "mcp server" : "tool",
      calls: calls.get(who) ?? 0, loadedIn: loadedIn.get(who) ?? 0, schema: c.schema, calling: c.calling, results: c.results, cost, share: share(cost),
    };
  }).sort((a, b) => b.cost - a.cost);
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
    since: since === null ? null : new Date(since).toISOString(), until: until === null ? null : new Date(until).toISOString(),
    files: stats.files, filesScanned: files.length, filesFailed: stats.failedFiles, requests: stats.requests, requestsWithoutResponse: stats.noResponse, unattributedMessages: stats.unattributed, missingBlobs: stats.missingBlobs,
    from: stats.first, to: stats.last, models: Object.fromEntries(stats.models),
    thinkingSignatures: signatures,
    charsPerToken: { min: cpt[0], p5: q(0.05), median: q(0.5), p95: q(0.95), max: cpt[cpt.length - 1], shareOutside2to4_5: offRatio },
    claudeCodeVersions: Object.fromEntries(stats.versions), querySources: Object.fromEntries(stats.sources),
    totalWeighted: total, categories: rows, cacheRebuilds: rebuilds, findings,
    byModel: ranked(byModel), byThread: ranked(byThread), byTool, byMcpServer,
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

// Signs that the numbers deserve less trust than usual, from the summary
// alone. An empty list means none were found.
export function health(summary) {
  const off = [];
  const share = (n, of) => (of ? n / of : 0), pct = (x) => (x * 100).toFixed(0) + "%";
  if (summary.filesFailed) off.push(`${summary.filesFailed} session file${summary.filesFailed > 1 ? "s" : ""} could not be read`);
  // Request records exist from Claude Code 2.1.300; unattributed usage on a
  // newer version means the log format is not being read as expected.
  const supported = (v) => { const [a, b, c] = v.split(".").map(Number); return a > 2 || (a === 2 && (b > 1 || (b === 1 && c >= 300))); };
  const recent = Object.entries(summary.claudeCodeVersions).filter(([v]) => supported(v));
  const lost = recent.reduce((n, [, c]) => n + c.unattributed, 0), all = recent.reduce((n, [, c]) => n + c.attributed + c.unattributed, 0);
  if (share(lost, all) > 0.02) off.push(`${pct(share(lost, all))} of requests on Claude Code 2.1.300 or newer could not be attributed`);
  if (summary.charsPerToken.shareOutside2to4_5 > 0.05) off.push(`${pct(summary.charsPerToken.shareOutside2to4_5)} of prompts were rebuilt at an unlikely size`);
  if (share(summary.missingBlobs, summary.requests) > 0.05) off.push(`${summary.missingBlobs} messages were missing from the log`);
  if (share(summary.requestsWithoutResponse, summary.requests + summary.requestsWithoutResponse) > 0.2) off.push(`${pct(share(summary.requestsWithoutResponse, summary.requests + summary.requestsWithoutResponse))} of logged requests have no response`);
  const unknown = summary.cacheRebuilds.filter((r) => r.cause === "unknown").length;
  if (share(unknown, summary.cacheRebuilds.length) > 0.3 && unknown > 2) off.push(`${unknown} cache rebuilds have no identified cause`);
  return off;
}

// What --doctor prints: versions, counts and sizes that describe how well the
// logs were read. No names, paths or text, so it can be pasted into an issue.
function printDoctor(summary, ms) {
  const line = (label, value) => console.log(`${(label + ":").padEnd(22)}${value}`);
  const counts = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none";
  // Type names come from Claude Code; anything that does not look like one is not printed.
  const typeNames = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [/^[A-Za-z0-9_-]{1,40}$/.test(k) ? k : "(other)", v]));
  const c = summary.charsPerToken, sig = summary.thinkingSignatures, off = health(summary);
  console.log("```");
  line("quotopsy", VERSION);
  line("runtime", `${globalThis.Deno ? "deno " + globalThis.Deno.version.deno : "node " + process.versions.node}, ${process.platform} ${process.arch}`);
  line("read in", `${(ms / 1000).toFixed(1)}s, ${summary.filesScanned ? Math.round(ms / summary.filesScanned) : 0} ms per session`);
  line("period", summary.since || summary.until ? `${summary.since ?? "start"} to ${summary.until ?? "end"}` : "all logs");
  line("sessions", `${summary.files} counted, ${summary.filesScanned} scanned, ${summary.filesFailed} unreadable`);
  line("requests", `${summary.requests} attributed, ${summary.unattributedMessages} without a request record, ${summary.requestsWithoutResponse} without a response`);
  line("claude code", Object.entries(summary.claudeCodeVersions).map(([v, n]) => `${v} (${n.attributed} ok, ${n.unattributed} not)`).join(", ") || "none");
  line("models", counts(summary.models));
  line("chars per token", c.median === undefined ? "no request rebuilt in full" : `p5 ${c.p5.toFixed(2)}, median ${c.median.toFixed(2)}, p95 ${c.p95.toFixed(2)}, ${(c.shareOutside2to4_5 * 100).toFixed(1)}% outside 2 to 4.5`);
  line("missing messages", summary.missingBlobs);
  line("thinking signatures", sig.thinkingTokens ? `${sig.responses} responses, ${(sig.chars / sig.thinkingTokens).toFixed(2)} chars per thinking token` : "none");
  line("cache rebuilds", counts(Object.fromEntries([...new Set(summary.cacheRebuilds.map((r) => r.cause))].map((cause) => [cause, summary.cacheRebuilds.filter((r) => r.cause === cause).length]))));
  line("mcp servers", `${summary.byMcpServer.length} (${counts(Object.fromEntries([...new Set(summary.byMcpServer.map((r) => r.verdict))].map((v) => [v, summary.byMcpServer.filter((r) => r.verdict === v).length])))})`);
  line("record types", counts(typeNames(summary.debug.recordTypes)));
  line("injected context", counts(typeNames(Object.fromEntries(Object.entries(summary.injectedByType).map(([type, a]) => [type, a.count])))));
  line("unattributed", counts(summary.debug.unattributed));
  line("health", off.length ? off.join("; ") : "nothing looks off");
  console.log("```");
}

// Terminal styling. Progress and banner go to stderr so piped or redirected
// output stays clean; colour is used only on a terminal that wants it.
const noColor = globalThis.Deno ? globalThis.Deno.noColor : "NO_COLOR" in process.env;
const paint = (stream) => (code, text) => (stream.isTTY && !noColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const out = paint(process.stdout), err = paint(process.stderr);
// Same accents as quotopsy.com: green for the brand and bars, amber for costs.
const BOLD = 1, DIM = 2, YELLOW = 33, GREEN = 32;
const BANNER = ["▀▄  █▀█  █ █ █▀█ ▀█▀ █▀█ █▀█ █▀ █▄█", "▄▀  █▄█▄ █▄█ █▄█  █  █▄█ █▀▀ ▄█  █ "];
const bar = (share, width = 20) => "█".repeat(Math.round(share * width)).padEnd(width, "░");
const num = (n) => Math.round(n).toLocaleString("en-US");

function printReport(summary, redact) {
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const title = (t) => t[0].toUpperCase() + t.slice(1);
  // Dates in the reader's own time zone: the logs are in UTC, where an
  // evening session already belongs to tomorrow.
  const day = (iso) => { const d = new Date(iso); return iso ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : "?"; };
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

  console.log(`  ${num(summary.files)} sessions · ${num(summary.requests + summary.unattributedMessages)} requests · ${day(summary.from)} to ${day(summary.to)} · ${out(BOLD, usd(summary.totalWeighted))} at API prices`);
  if (summary.since || summary.until) {
    // `until` is the first moment left out, so step back to name its last day.
    const period = [summary.since && `from ${day(summary.since)}`, summary.until && `up to ${day(new Date(Date.parse(summary.until) - 1).toISOString())}`].filter(Boolean).join(" ");
    console.log(out(DIM, `  Only usage ${period}`));
  }
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
    console.log(`  ${title(r.name).slice(0, 30).padEnd(30)}  ${out(GREEN, bar(r.share))}  ${pct(r.share).padStart(6)}  ${usd(r.weighted).padStart(10)}`);
    if (r.share < 0.05 || r.subs.length < 2) continue;
    for (const sub of r.subs.slice(0, 3)) {
      console.log(out(DIM, `      ${pct(sub.share).padStart(6)}  ${sub.name}${sub.calls != null ? ` (${num(sub.calls)} calls)` : ""}`));
    }
  }
  console.log();

  // One row per tool or MCP server: everything it cost, wherever it shows up
  // in the table above.
  if (summary.byTool.length) {
    heading("BY TOOL", "calls   schema  calling  results    share      API $");
    const shown = summary.byTool.filter((r) => r.share >= 0.001).slice(0, 8);
    for (const r of shown) {
      const name = r.kind === "mcp server" ? `${r.name} (MCP)` : r.name;
      console.log(`  ${(name.length > 20 ? name.slice(0, 19) + "…" : name).padEnd(20)}${num(r.calls).padStart(7)}${usd(r.schema).padStart(9)}${usd(r.calling).padStart(9)}${usd(r.results).padStart(9)}${pct(r.share).padStart(9)}${usd(r.cost).padStart(11)}`);
    }
    if (summary.byTool.length > shown.length) console.log(out(DIM, `  and ${summary.byTool.length - shown.length} smaller ones`));
    console.log();
  }

  if (summary.byMcpServer.length) {
    heading("BY MCP SERVER", "calls  connected       used    share  verdict       ");
    const shown = summary.byMcpServer.slice(0, 25);
    for (const r of shown) {
      const verdict = r.verdict === "in use" ? out(DIM, r.verdict.padEnd(14)) : out(YELLOW, r.verdict.padEnd(14));
      console.log(`  ${(r.name.length > 22 ? r.name.slice(0, 21) + "…" : r.name).padEnd(22)}${num(r.calls).padStart(6)}${usd(r.carried).padStart(11)}${usd(r.used).padStart(11)}${pct(r.share).padStart(9)}  ${verdict}`);
    }
    if (summary.byMcpServer.length > shown.length) console.log(out(DIM, `  and ${summary.byMcpServer.length - shown.length} more`));
    console.log();
  }

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
  const off = health(summary);
  const notes = [
    "Every figure is an estimate. Usage is priced at published API rates per model; how weekly limits weight it is not published.",
    "By MCP server: connected is what its instructions, tool names and loaded schemas cost whether or not you call it; used is its calls and their results. Disable one for a project with /mcp disable <name>.",
    "By tool: schema is its definition loaded in every request; calling is writing its calls and re-reading them later; results is its output kept in context.",
    ...Object.entries(summary.assumedPricing).map(([model, as]) => `No published price known for ${model}; priced as ${as}.`),
    off.length ? `Health: ${off.length} thing${off.length > 1 ? "s" : ""} look${off.length > 1 ? "" : "s"} off, so read the figures with more caution: ${off.join("; ")}. To report it, paste the output of npx quotopsy --doctor into an issue.`
      : `Health: nothing looks off (${summary.charsPerToken.median?.toFixed(2) ?? "?"} characters per token, ${num(summary.unattributedMessages)} requests without a request record).`,
    `Claude Code versions: ${Object.entries(summary.claudeCodeVersions).map(([v, c]) => `${v} (${num(c.attributed + c.unattributed)})`).join(", ")}.`,
    ...(summary.filesFailed ? [`${num(summary.filesFailed)} session files could not be read and are left out.`] : []),
    "Nothing left this machine. For a shareable summary: npx quotopsy --json --redact",
    "A lean setup kit is planned. Waitlist: https://quotopsy.com/#waitlist",
  ];
  for (const note of notes) wrap(note, "  · ", "    ", (t) => out(DIM, t));
  console.log();
}

// A day given as YYYY-MM-DD, or as a number of days back from today ("7d"),
// read in the local time zone. Returns the start of that day plus `addDays`.
export function parseDay(text, addDays = 0, now = new Date()) {
  const ago = /^(\d+)d$/.exec(text), ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!ago && !ymd) return null;
  const d = ago ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - Number(ago[1])) : new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
  // Reject dates the calendar rolled over, such as 2026-02-31.
  if (ymd && (d.getMonth() !== Number(ymd[2]) - 1 || d.getDate() !== Number(ymd[3]))) return null;
  d.setDate(d.getDate() + addDays);
  return d.getTime();
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version")) return console.log(VERSION);
  // --doctor always redacts: its output is meant to be pasted in public.
  const doctor = args.includes("--doctor");
  const asJson = args.includes("--json"), redact = doctor || args.includes("--redact"), debug = doctor || args.includes("--debug");
  // --since=DAY and --until=DAY, also accepted as two words.
  const period = {};
  for (const name of ["since", "until"]) {
    const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (i < 0) continue;
    const [arg, next] = args.splice(i, args[i].includes("=") ? 1 : 2);
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : next ?? "";
    // --until names the last day to include, so the cut is the start of the next one.
    period[name] = parseDay(value, name === "until" ? 1 : 0);
    if (period[name] === null) {
      console.error(`--${name} needs a day, as YYYY-MM-DD or a number of days back such as 7d. Got: ${value || "nothing"}`);
      process.exit(1);
    }
  }
  const root = args.find((a) => !a.startsWith("--")) ?? join(homedir(), ".claude", "projects");

  const started = Date.now();
  let lastDraw = 0, bannerShown = false;
  const onProgress = (done, total) => {
    if (!process.stderr.isTTY) return;
    if (!bannerShown) {
      bannerShown = true;
      process.stderr.write(`\n${BANNER.map((l) => "  " + err(GREEN, l)).join("\n")}\n  ${err(DIM, "where did your Claude Code usage go?")}\n\n`);
    }
    if (Date.now() - lastDraw < 60 && done < total) return;
    lastDraw = Date.now();
    process.stderr.write(`\r  Reading sessions  ${err(GREEN, bar(done / total, 24))}  ${done}/${total}`);
  };

  let summary;
  try { summary = analyze(root, { redact, debug, onProgress, ...period }); } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e;
  }
  if (!summary?.filesScanned) {
    console.error(`No Claude Code session logs found in ${root}\nPass the folder that holds them: npx quotopsy <logs-dir>`);
    process.exit(1);
  }
  if (process.stderr.isTTY) {
    process.stderr.write(`\r\x1b[2K  ${err(GREEN, "✓")} Read ${num(summary.files)} sessions and ${num(summary.requests + summary.unattributedMessages)} requests in ${((Date.now() - started) / 1000).toFixed(1)}s, on this machine only\n\n`);
  }

  if (doctor) {
    printDoctor(summary, Date.now() - started);
    if (process.stderr.isTTY) process.stderr.write("\n  Nothing above names a server, a tool, a file or any text. Paste it into an issue:\n  https://github.com/Impakt-Dot-Dev/quotopsy/issues\n\n");
  } else if (asJson) {
    console.log(JSON.stringify(summary, null, 2));
    if (process.stderr.isTTY && !process.stdout.isTTY) process.stderr.write(`  Summary written${redact ? ", with names replaced by placeholders" : ""}. Have a look before you share it.\n\n`);
  } else if (!summary.totalWeighted) {
    console.log(summary.since || summary.until ? "  No usage in that period." : "  The logs contain no usage records yet.");
  } else {
    printReport(summary, redact);
  }
}

// Run only when executed directly, not when imported by the tests.
const isMain = import.meta.main ?? (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url));
if (isMain) main();
