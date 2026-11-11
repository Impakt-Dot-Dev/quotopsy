// Tests run against synthetic session logs built here, never real ones.
// When a new kind of log turns up in the wild, add a case that reproduces its
// structure (record types and shapes), not its content.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyze, hashMessage } from "../quotopsy.mjs";

const OPUS = "claude-opus-5-5"; // $4 in, $0.20 cache read, $8 one-hour write, $20 out, per million tokens
const M = 1e-6;
const T0 = Date.parse("2026-11-01T10:00:00Z");
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${actual} != ${expected}`);

// Builds one session file record by record, in the shapes Claude Code logs.
class Session {
  lines = [];
  n = 0;
  constructor(version = "2.1.322") { this.version = version; }
  add(record) { this.lines.push(JSON.stringify({ version: this.version, ...record })); return this; }
  shape(shapeHash, tools, systemTexts) {
    return this.add({ type: "api-request-shape", shapeHash, shape: { tools, system: systemTexts.map((text) => ({ type: "text", text })) } });
  }
  // Logs a message as a blob and returns the hash a request refers to it by.
  blob(message) { const hash = hashMessage(message); this.add({ type: "api-request-blob", hash, message }); return hash; }
  request(id, { base, keep = 0, tail, shapeHash = "shape", minute = 0, source = "repl_main_thread" }) {
    return this.add({ type: "api-request", id, base, keep, tail, shapeHash, timestamp: at(minute), querySource: source });
  }
  // The response to request `ref`; without `ref` it is an old-style record.
  assistant(ref, usage, { model = OPUS, content = [{ type: "text", text: "ok" }], minute = 0, sidechain = false, agentId } = {}) {
    return this.add({
      type: "assistant", requestRef: ref ?? undefined, timestamp: at(minute), isSidechain: sidechain, agentId,
      message: { id: `msg_${++this.n}`, model, role: "assistant", content, usage: usageOf(usage) },
    });
  }
  user(content) { return this.add({ type: "user", message: { role: "user", content } }); }
}

function usageOf({ fresh = 0, read = 0, write1h = 0, write5m = 0, output = 0, thinking = 0, speed, inference_geo }) {
  return {
    input_tokens: fresh, cache_read_input_tokens: read, cache_creation_input_tokens: write1h + write5m,
    cache_creation: { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write5m },
    output_tokens: output, output_tokens_details: { thinking_tokens: thinking }, speed, inference_geo,
  };
}

// Writes sessions into a fresh logs folder and analyses it.
function run(sessions, options) {
  const root = mkdtempSync(join(tmpdir(), "quotopsy-test-"));
  mkdirSync(join(root, "project"));
  sessions.forEach((s, i) => writeFileSync(join(root, "project", `session-${i}.jsonl`), s.lines.join("\n") + "\n"));
  const summary = analyze(root, options);
  // A session that throws is skipped, which would otherwise hide a bug here.
  assert.equal(summary.filesFailed, 0, "a session file failed to parse");
  return summary;
}

// No NaN or Infinity anywhere: JSON would turn them into null.
function assertFinite(value, path = "summary") {
  if (typeof value === "number") assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
}

const text = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
const category = (summary, name) => summary.categories.find((c) => c.name === name);

test("charges each part of the prompt by its position in the cache", () => {
  const bash = { name: "Bash", description: "b".repeat(300) };
  const search = { name: "mcp__github__search", description: "s".repeat(500) };
  const system = "# Rules\n" + "r".repeat(200);
  const message = text("hello ".repeat(50));
  const chars = { bash: JSON.stringify(bash).length, search: JSON.stringify(search).length, system: system.length + 1, message: JSON.stringify(message.content[0]).length };

  const s = new Session().shape("shape", [bash, search], [system]);
  // One token per character, with the cache boundary exactly after the tools.
  s.request("r1", { tail: [s.blob(message)] })
    .assistant("r1", { read: chars.bash + chars.search, write1h: chars.system + chars.message, output: 1000, thinking: 400 });
  const summary = run([s]);

  assert.equal(category(summary, "built-in tools").read, chars.bash);
  assert.equal(category(summary, "MCP server: github").read, chars.search);
  assert.equal(category(summary, "system prompt").write, chars.system);
  assert.equal(category(summary, "user messages").write, chars.message);
  near(category(summary, "built-in tools").weighted, chars.bash * 0.2 * M, "tools at cache-read price");
  near(category(summary, "system prompt").weighted, chars.system * 8 * M, "system at one-hour write price");
  near(category(summary, "output").weighted, 1000 * 20 * M, "output price");
  near(category(summary, "output").subs.find((x) => x.name === "thinking").share * summary.totalWeighted, 400 * 20 * M, "thinking share");
  assert.equal(category(summary, "system prompt").subs[0].name, "Rules");
  assert.equal(summary.charsPerToken.median, 1);
});

test("total equals the usage priced directly, and shares sum to one", () => {
  const s = new Session().shape("shape", [{ name: "Read", description: "x".repeat(100) }], ["plain system text"]);
  s.request("r1", { tail: [s.blob(text("one"))] }).assistant("r1", { fresh: 7, read: 900, write1h: 300, write5m: 200, output: 50 });
  const summary = run([s]);
  near(summary.totalWeighted, (7 * 4 + 900 * 0.2 + 300 * 8 + 200 * 5 + 50 * 20) * M, "total");
  near(summary.categories.reduce((n, c) => n + c.share, 0), 1, "shares");
});

// A conversation of three requests; `second` and `third` describe the later two.
function conversation(second, third) {
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(100) }], ["system"]);
  const u1 = s.blob(text("first")), a1 = s.blob({ role: "assistant", content: [{ type: "text", text: "reply" }] }), u2 = s.blob(text("second"));
  s.request("r1", { tail: [u1] }).assistant("r1", { write1h: 20000 });
  s.request("r2", { base: "r1", keep: 1, tail: [a1, u2], minute: second.minute }).assistant("r2", second.usage, { model: second.model });
  if (third) s.request("r3", { base: "r2", keep: 3, tail: [s.blob(text("third"))], minute: third.minute }).assistant("r3", third.usage, { model: third.model });
  return s;
}

test("reports a cache rebuilt after an idle gap, with what it cost", () => {
  const summary = run([conversation({ minute: 180, usage: { read: 1000, write1h: 25000 } })]);
  assert.equal(summary.cacheRebuilds.length, 1);
  const [rebuild] = summary.cacheRebuilds;
  assert.equal(rebuild.cause, "idle longer than the cache lifetime");
  assert.equal(rebuild.tokens, 19000); // the 20,000-token prompt minus the 1,000 read back
  assert.equal(rebuild.gapMin, 180);
  assert.equal(rebuild.version, "2.1.322"); // the Claude Code version that made the request
  near(rebuild.wasted, 19000 * (8 - 0.2) * M, "cost above a warm cache");
  assert.match(summary.findings[0].what, /Cache rebuilt 1x: idle/);
});

test("does not report a rebuild when the cache was read back", () => {
  const summary = run([conversation({ minute: 180, usage: { read: 20000, write1h: 30000 } })]);
  assert.equal(summary.cacheRebuilds.length, 0);
});

test("names a model switch as the cause when the cache had not expired", () => {
  const summary = run([conversation(
    { minute: 5, usage: { read: 20000, write1h: 6000 } },
    { minute: 10, usage: { read: 1000, write1h: 40000 }, model: "claude-fable-5-1" },
  )]);
  assert.deepEqual(summary.cacheRebuilds.map((r) => [r.cause, r.tokens]), [["model switched mid-session", 25000]]);
});

test("a subagent's own conversation between two main requests is not a rebuild", () => {
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(100) }], ["system"]);
  const u1 = s.blob(text("main question")), a1 = s.blob({ role: "assistant", content: [{ type: "text", text: "delegating" }] }), u2 = s.blob(text("main follow-up"));
  s.request("m1", { tail: [u1] }).assistant("m1", { write1h: 60000 });
  s.request("sub", { tail: [s.blob(text("subagent brief"))], minute: 1, source: "agent:custom:code-critic" }).assistant("sub", { write1h: 9000 });
  s.request("m2", { base: "m1", keep: 1, tail: [a1, u2], minute: 2 }).assistant("m2", { read: 60000, write1h: 500 });
  const summary = run([s]);
  assert.equal(summary.cacheRebuilds.length, 0);
  assert.deepEqual(summary.byThread.map((t) => [t.name, t.requests]), [["main thread", 2], ["subagent: code-critic", 1]]);
});

test("matches a resumed conversation, which logs no base, by its first message", () => {
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(100) }], ["system"]);
  const u1 = s.blob(text("start")), a1 = s.blob({ role: "assistant", content: [{ type: "text", text: "reply" }] }), u2 = s.blob(text("next morning"));
  s.request("r1", { tail: [u1] }).assistant("r1", { write1h: 30000 });
  s.request("r2", { tail: [u1, a1, u2], minute: 900 }).assistant("r2", { read: 500, write1h: 31000 });
  assert.deepEqual(run([s]).cacheRebuilds.map((r) => r.cause), ["idle longer than the cache lifetime"]);
});

test("resolves results of parallel tool calls sent as one message", () => {
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(100) }], ["system"]);
  const calls = [{ type: "tool_use", id: "t1", name: "Bash", input: {} }, { type: "tool_use", id: "t2", name: "mcp__db__query", input: {} }];
  const results = calls.map((c) => ({ type: "tool_result", tool_use_id: c.id, content: "x".repeat(400) }));
  const u1 = s.blob(text("go"));
  s.request("r1", { tail: [u1] }).assistant("r1", { write1h: 1000 }, { content: calls });
  // Logged as two records and never as a blob; the request refers to the merged message.
  s.user([results[0]]).user([results[1]]);
  const merged = hashMessage({ role: "user", content: results });
  const turn = hashMessage({ role: "assistant", content: calls });
  s.request("r2", { base: "r1", keep: 1, tail: [turn, merged], minute: 1 }).assistant("r2", { read: 1000, write1h: 500 });

  const summary = run([s]);
  assert.equal(summary.missingBlobs, 0);
  assert.deepEqual(category(summary, "tool results").subs.map((x) => [x.name, x.calls]).sort(), [["Bash", 1], ["mcp__db__query", 1]]);
});

test("logs from before request records are counted, not attributed", () => {
  const s = new Session("2.1.290");
  s.assistant(null, { write1h: 50000, output: 100 }, { minute: 0 });
  s.assistant(null, { read: 50000, write1h: 2000, output: 100 }, { minute: 5 });
  s.assistant(null, { read: 800, write1h: 53000, output: 100 }, { minute: 200 }); // back after three hours
  s.assistant(null, { write1h: 4000 }, { minute: 201, sidechain: true, agentId: "a1" }); // a subagent starting is not a rebuild
  const summary = run([s]);

  assert.equal(summary.requests, 0);
  assert.equal(summary.unattributedMessages, 4);
  assert.deepEqual(summary.claudeCodeVersions, { "2.1.290": { attributed: 0, unattributed: 4 } });
  assert.ok(category(summary, "unattributed input").share > 0.9);
  assert.deepEqual(summary.cacheRebuilds.map((r) => [r.cause, r.tokens, r.gapMin]), [["idle longer than the cache lifetime", 51200, 195]]);
  assert.equal(summary.from, at(0));
  assert.equal(summary.to, at(201));
});

test("prices models from the table, by family when unlisted, and fast mode at double", () => {
  const one = (model, usage) => run([new Session().assistant(null, usage, { model })]);
  near(one("claude-fable-5-1", { read: 1e6 }).totalWeighted, 0.25, "Fable 5.1 cache read");
  near(one("claude-opus-5-5", { read: 1e6 }).totalWeighted, 0.2, "Opus 5.5 cache read");
  near(one("claude-sonnet-4-6-20260101", { fresh: 1e6 }).totalWeighted, 3, "dated model id");
  near(one("claude-opus-5-5", { output: 1e6, speed: "fast" }).totalWeighted, 40, "fast mode");

  near(one("claude-fable-5-2", { fresh: 1e6, read: 1e6 }).totalWeighted, 8.2, "Fable 5.2");
  near(one("claude-sonnet-5-5", { read: 1e6 }).totalWeighted, 0.1, "Sonnet 5.5 cache read");
  near(one("claude-opus-4-1-20250805", { output: 1e6 }).totalWeighted, 75, "retired Opus 4.1");
  near(one("claude-opus-5-5", { fresh: 1e6, inference_geo: "us" }).totalWeighted, 4.4, "US-only inference");
  near(one("claude-haiku-5-5", { read: 100000 }).totalWeighted, 0.001, "Haiku 5.5 up to 100,000 prompt tokens");
  near(one("claude-haiku-5-5", { read: 100001 }).totalWeighted, 100001 * 0.05 * M, "Haiku 5.5 above it");

  const unknown = one("claude-fable-9", { fresh: 1e6 });
  near(unknown.totalWeighted, 8, "priced as its family");
  assert.deepEqual(unknown.assumedPricing, { "claude-fable-9": "claude-fable-5-2" });
});

test("ignores synthetic messages, malformed lines and empty files", () => {
  const s = new Session();
  s.lines.push("{not json", "");
  s.assistant(null, { fresh: 999999 }, { model: "<synthetic>" });
  s.assistant(null, { fresh: 100 });
  const summary = run([s, new Session()]);
  assert.equal(summary.files, 2);
  assert.equal(summary.unattributedMessages, 1);
  near(summary.totalWeighted, 100 * 4 * M, "only the real message");
});

test("a missing logs folder is an error the caller can recognise", () => {
  assert.throws(() => analyze(join(tmpdir(), "quotopsy-does-not-exist")), { code: "ENOENT" });
});

test("does not count image payloads as text", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(400000) } };
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(4000) }], ["system"]);
  s.request("r1", { tail: [s.blob({ role: "user", content: [image, { type: "text", text: "what is this?" }] })] }).assistant("r1", { write1h: 3000 });
  const summary = run([s]);
  // 400,000 characters of base64 would otherwise swamp everything else.
  assert.ok(category(summary, "user messages").share < 0.6);
  assert.ok(summary.charsPerToken.max < 5);
});

// One session carrying a marker in every place message text can live.
function sessionWithSecrets() {
  const SECRET = "ZEBRA-SECRET-7731";
  const s = new Session().shape("shape",
    [{ name: "Bash", description: `b ${SECRET}` }, { name: "mcp__acme_billing__refund_customer", description: `m ${SECRET}` }],
    [`# Payroll rules\n${SECRET}\n<private_notes>\n${SECRET}\n</private_notes>\n# MCP Server Instructions\n## acme_billing\n${SECRET}`]);
  const call = { type: "tool_use", id: "t1", name: "mcp__acme_billing__refund_customer", input: { note: SECRET } };
  const tail = [
    s.blob({ role: "system", content: [{ type: "text", text: `# Environment\n${SECRET}` }] }),
    s.blob(text(`please ${SECRET}`)),
    s.blob({ role: "assistant", content: [{ type: "thinking", thinking: SECRET }, call] }),
    s.blob({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `result ${SECRET}` }] }),
  ];
  // Far fewer tokens than characters, so --debug lists this request.
  s.request("r1", { tail, source: "agent:custom:acme-refund-bot" }).assistant("r1", { write1h: 20, output: 5 }, { content: [call] });
  return { s, SECRET };
}

test("message text never reaches the summary, in any mode", () => {
  const { s, SECRET } = sessionWithSecrets();
  for (const options of [{}, { debug: true }, { redact: true }, { redact: true, debug: true }]) {
    const summary = run([s], options);
    assert.ok(!JSON.stringify(summary).includes(SECRET), `leaked with ${JSON.stringify(options)}`);
    if (options.debug) assert.equal(summary.debug.offRequests.length, 1);
  }
});

test("--redact replaces private names and keeps public ones", () => {
  const { s } = sessionWithSecrets();
  const plain = JSON.stringify(run([s]));
  const redacted = JSON.stringify(run([s], { redact: true, debug: true }));
  for (const name of ["acme_billing", "refund_customer", "Payroll rules", "private_notes", "acme-refund-bot"]) {
    assert.ok(plain.includes(name), `${name} should appear without --redact`);
    assert.ok(!redacted.includes(name), `${name} leaked with --redact`);
  }
  for (const name of ["Bash", "Environment", "MCP server: server 1", "subagent: agent 1"]) assert.ok(redacted.includes(name), `${name} should remain`);
});

test("flags an MCP server whose schemas are loaded but never called", () => {
  const tools = [{ name: "Bash", description: "b".repeat(100) }, { name: "mcp__jira__search", description: "j".repeat(5000) }];
  const s = new Session().shape("shape", tools, ["system"]);
  s.request("r1", { tail: [s.blob(text("hi"))] }).assistant("r1", { write1h: 2000 });
  const finding = run([s]).findings.find((f) => f.what.startsWith("jira:"));
  assert.match(finding.what, /schemas loaded in 1 requests, called 0x/);
});

test("sizes injected context by attachment type, without its text", () => {
  const s = new Session();
  const listing = (n) => ({ type: "attachment", attachment: { type: "skill_listing", skillCount: n }, rendered: [{ content: "SKILL-TEXT ".repeat(n) }] });
  s.add(listing(10)).add(listing(20)).add({ type: "attachment", attachment: { type: "date" } });
  s.assistant(null, { fresh: 10 });
  const summary = run([s]);
  assert.deepEqual(summary.injectedByType, { skill_listing: { count: 2, chars: 330 }, date: { count: 1, chars: 0 } });
  assert.ok(!JSON.stringify(summary).includes("SKILL-TEXT"));
});

// Cases below came out of a code review; each reproduces one defect.

test("a response whose request was not logged still counts", () => {
  const s = new Session().assistant("never-logged", { fresh: 1000, output: 100 });
  const summary = run([s]);
  assert.equal(summary.unattributedMessages, 1);
  near(summary.totalWeighted, (1000 * 4 + 100 * 20) * M, "total");
});

test("keeps the input cost of a request whose prompt cannot be rebuilt at all", () => {
  const s = new Session();
  s.request("r1", { tail: ["0".repeat(64)], shapeHash: "unknown-shape" }).assistant("r1", { read: 50000, output: 100 });
  const summary = run([s]);
  near(summary.totalWeighted, (50000 * 0.2 + 100 * 20) * M, "total");
  near(summary.byModel[0].share, 1, "model share");
  near(category(summary, "unresolved messages").weighted, 50000 * 0.2 * M, "the missing message carries the input");

  // With no tools, system prompt or messages to place it on, it is unattributed.
  const empty = new Session();
  empty.request("r1", { tail: [], shapeHash: "unknown-shape" }).assistant("r1", { read: 50000 });
  near(category(run([empty]), "unattributed input").weighted, 50000 * 0.2 * M, "nothing to attribute to");
});

test("does not spread missing messages over the ones that were found", () => {
  const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(280) }], ["system"]);
  // The base request is not in this log: 40 kept messages cannot be found.
  s.request("r2", { base: "gone", keep: 40, tail: [s.blob(text("x".repeat(2900)))] }).assistant("r2", { read: 90000 });
  const summary = run([s]);
  assert.equal(summary.missingBlobs, 40);
  assert.ok(category(summary, "unresolved messages").share > 0.9, "the hole carries the cost");
  assert.ok(category(summary, "user messages").share < 0.05, "the one known message does not");
  assert.equal(summary.charsPerToken.median, undefined); // incomplete requests do not vouch for the method
});

test("counts a call once when two session files repeat it", () => {
  const old = () => new Session("2.1.290").add({ type: "assistant", timestamp: at(0), message: { id: "msg_same", model: OPUS, content: [], usage: usageOf({ fresh: 1000 }) } });
  assert.equal(run([old(), old()]).unattributedMessages, 1);

  const recorded = () => {
    const s = new Session().shape("shape", [{ name: "Bash", description: "b".repeat(100) }], ["system"]);
    return s.request("same-request", { tail: [s.blob(text("hi"))] }).assistant("same-request", { write1h: 1000 });
  };
  const summary = run([recorded(), recorded()]);
  assert.equal(summary.requests, 1);
  near(summary.totalWeighted, 1000 * 8 * M, "total");
});

test("reads provider-wrapped model ids without keeping the wrapper", () => {
  const arn = "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-opus-4-6-v1:0";
  for (const options of [{}, { redact: true }]) {
    const summary = run([new Session().assistant(null, { fresh: 1e6 }, { model: arn })], options);
    near(summary.totalWeighted, 5, "priced as Opus 4.6");
    assert.deepEqual(summary.models, { "claude-opus-4-6": 1 });
    assert.ok(!JSON.stringify(summary).includes("123456789012"));
  }
  assert.deepEqual(run([new Session().assistant(null, { fresh: 1e6 }, { model: "claude-opus-4-5@20251101" })]).models, { "claude-opus-4-5": 1 });
});

test("prices cache writes when the log has the split but not the total", () => {
  const s = new Session().add({ type: "assistant", timestamp: at(0), message: { id: "m1", model: OPUS, content: [], usage: { cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 400 } } } });
  near(run([s]).totalWeighted, (1000 * 8 + 400 * 5) * M, "total");
});

test("logs with no usage produce zeros, not NaN", () => {
  const s = new Session().shape("shape", [], []);
  s.request("r1", { tail: [] }).assistant("r1", {});
  s.assistant(null, {}, { model: "claude-haiku-5-5" });
  const summary = run([s], { debug: true });
  assertFinite(summary);
  assert.equal(summary.totalWeighted, 0);
});

test("only real headings become section names", () => {
  const system = ["# Rules", "```bash", "# cat /Users/bob/secret.key", "## not a heading either", "```", "# MCP Server Instructions", "## jira", "use it well", "## Usage notes", "more"].join("\n");
  const s = new Session().add({ type: "attachment", attachment: { type: "mcp_instructions_delta", addedNames: ["jira"] } });
  s.shape("shape", [], [system]).request("r1", { tail: [s.blob(text("hi"))] }).assistant("r1", { write1h: 500 });
  const summary = run([s]);
  assert.deepEqual(category(summary, "system prompt").subs.map((x) => x.name).sort(), ["MCP Server Instructions", "MCP instructions: jira", "Rules"].sort());
  assert.ok(!JSON.stringify(summary).includes("secret.key"));
});

test("survives records with missing or oddly shaped fields", () => {
  const s = new Session();
  s.lines.push("null", "42", JSON.stringify({ type: "api-request-blob", hash: "h", message: null }));
  s.add({ type: "api-request-shape", shapeHash: "no-fields", shape: {} });
  s.add({ type: "api-request-shape", shapeHash: "odd", shape: { tools: [{ description: "nameless" }, null], system: "a plain string" } });
  s.add({ type: "api-request", id: "no-tail", shapeHash: "no-fields" });
  s.add({ type: "api-request", id: "odd", shapeHash: "odd", tail: [s.blob({ role: "user", content: [null, { type: "text", text: "hi" }] })] });
  s.add({ type: "assistant", requestRef: "no-tail", message: { id: "m1", model: null, content: "a string", usage: usageOf({ fresh: 10 }) } });
  s.add({ type: "assistant", requestRef: "odd", message: { id: "m2", content: [null], usage: usageOf({ read: 100 }) } });
  s.add({ type: "assistant", message: { id: "m3", usage: {} } });
  const summary = run([s], { debug: true });
  assertFinite(summary);
  assert.equal(summary.requests, 2);
  assert.deepEqual(summary.models, { unknown: 3 });
});

test("one unreadable session does not lose the others", () => {
  const good = new Session().assistant(null, { fresh: 100 });
  const root = mkdtempSync(join(tmpdir(), "quotopsy-test-"));
  writeFileSync(join(root, "good.jsonl"), good.lines.join("\n"));
  writeFileSync(join(root, "locked.jsonl"), good.lines.join("\n"));
  chmodSync(join(root, "locked.jsonl"), 0); // reading it throws
  const summary = analyze(root);
  assert.equal(summary.files, 2);
  assert.equal(summary.filesFailed, 1);
  near(summary.totalWeighted, 100 * 4 * M, "total");
});
