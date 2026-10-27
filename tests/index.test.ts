import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import {
  discoverAndLoadExtensions,
  type ExtensionAPI, type ExtensionContext, type ExtensionEvent,
  type BeforeAgentStartEvent, type SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import registerTimeExtension from "../src/index.ts";

function usage(overrides: Partial<Usage> = {}): Usage {
  return {
    input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
    ...overrides,
  };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "Done" }], api: "openai-responses",
    provider: "openai", model: "test", stopReason: "stop", timestamp: 0,
    usage: usage(), ...overrides,
  };
}

function toolStart(toolCallId: string, parentToolCallId?: string): ExtensionEvent {
  return { type: "tool_execution_start", toolCallId, toolName: "test", args: {}, parentToolCallId };
}

function toolEnd(toolCallId: string, isError = false): ExtensionEvent {
  return { type: "tool_execution_end", toolCallId, toolName: "test", result: {}, isError };
}

const before = { type: "before_agent_start", messageType: "user", prompt: "work" } as BeforeAgentStartEvent;
const settled = { type: "agent_settled", aborted: false } as const;

function harness() {
  type Handler = (event: never, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const timeEntries: { customType: string; data: unknown }[] = [];
  let timeRenderer: ((entry: { data?: unknown }, options: unknown, theme: {
    fg(color: string, text: string): string;
  }) => unknown) | undefined;
  let now = 1000;
  let date = new Date(2026, 0, 1, 13, 5, 9);
  let entries: unknown[] = [];
  const ctx = {
    hasUI: true, mode: "tui",
    sessionManager: { getEntryCount: () => entries.length, getEntries: () => entries },
  } as unknown as ExtensionContext;
  const api = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
      return () => {};
    },
    appendEntry(customType: string, data: unknown) {
      timeEntries.push({ customType, data });
    },
    registerEntryRenderer(_customType: string, renderer: unknown) {
      timeRenderer = renderer as typeof timeRenderer;
    },
  } as unknown as ExtensionAPI;
  registerTimeExtension(api, { now: () => now, date: () => date });
  return {
    timeEntries, ctx,
    get messages() { return timeEntries.map((entry) => (entry.data as { message: string }).message); },
    renderTimeEntry(entry: unknown) {
      let color: string | undefined;
      const rendered = timeRenderer?.(entry as { data?: unknown }, {}, {
        fg(name, text) {
          color = name;
          return text;
        },
      });
      return { color, rendered };
    },
    advance(ms: number) { now += ms; },
    setDate(value: Date) { date = value; },
    setEntries(value: unknown[]) { entries = value; },
    async emit(event: ExtensionEvent) {
      for (const handler of handlers.get(event.type) ?? []) await handler(event as never, ctx);
    },
  };
}

test("records once at settlement, after tools, retries, and boundary continuations", async () => {
  const h = harness();
  await h.emit(before);
  h.advance(3000);
  await h.emit({ type: "agent_start" });
  const message = assistant({ stopReason: "toolUse", content: [
    { type: "toolCall", id: "call-1", name: "test", arguments: {} },
  ] });
  await h.emit({ type: "message_end", message });
  await h.emit({ type: "message_end", message });
  const tool: ToolResultMessage = {
    role: "toolResult", toolCallId: "call-1", toolName: "test",
    content: [], isError: false, timestamp: 1, usage: usage(),
  };
  await h.emit({ type: "message_end", message: tool });
  await h.emit({ type: "agent_end", messages: [message, tool] });
  assert.equal(h.messages.length, 0);
  h.advance(60000);
  await h.emit({ type: "agent_start" });
  await h.emit({ type: "message_end", message: assistant({ stopReason: "error" }) });
  await h.emit({ type: "agent_end", messages: [] });
  await h.emit({ type: "agent_start" });
  await h.emit({ type: "message_end", message: assistant() });
  assert.equal(h.messages.length, 0);
  h.advance(20000);
  await h.emit(settled);
  await h.emit(settled);
  assert.deepEqual(h.timeEntries, [{
    customType: "pi-time",
    data: { message: "1m 23s · tools 0s · in 640 (200 cached), out 80 · $0.0400 · 01:05:09 PM" },
  }]);
  const rendered = h.renderTimeEntry({ data: { message: "timing" } });
  assert.equal(rendered.color, "dim");
  assert.ok(rendered.rendered);
  assert.match((rendered.rendered as { render(width: number): string[] }).render(80)[0]!, /^ timing\s+$/);
  assert.doesNotThrow(() => h.renderTimeEntry({ data: undefined }));
  assert.equal(h.renderTimeEntry({ data: { message: 42 } }).rendered, undefined);
  assert.equal(h.renderTimeEntry({ data: 42 }).rendered, undefined);
  assert.equal(h.renderTimeEntry({ data: null }).rendered, undefined);
  assert.equal(h.renderTimeEntry("legacy").rendered, undefined);
});

test("tool time counts serial, parallel, and nested intervals once across turns", async () => {
  const h = harness();
  await h.emit(toolStart("idle"));
  h.advance(10000);
  await h.emit(toolEnd("idle"));
  await h.emit(before);
  h.advance(5000);
  await h.emit(toolEnd("unknown"));
  await h.emit(toolStart("outer"));
  h.advance(500);
  await h.emit(toolStart("outer")); // Duplicate starts must not reset the interval.
  await h.emit(toolStart("outer/1", "outer"));
  h.advance(1000);
  await h.emit(toolStart("parallel"));
  h.advance(1000);
  await h.emit(toolEnd("outer/1"));
  await h.emit(toolEnd("outer"));
  await h.emit(toolEnd("outer"));
  h.advance(1000);
  await h.emit(toolEnd("parallel", true));
  await h.emit({ type: "agent_end", messages: [] });
  h.advance(2000);
  await h.emit({ type: "agent_start" });
  await h.emit(toolStart("serial"));
  h.advance(750);
  await h.emit(toolEnd("serial"));
  h.advance(1000);
  await h.emit(settled);
  assert.match(h.messages[0], /^12s · tools 4s · in /);

  await h.emit(before);
  h.advance(2000);
  await h.emit(settled);
  assert.match(h.messages[1], /^2s · tools 0s · in /);
});

test("settlement counts unfinished tool time and clears it, including on abort", async () => {
  for (const aborted of [false, true]) {
    const h = harness();
    await h.emit(before);
    h.advance(1000);
    await h.emit(toolStart("unfinished"));
    h.advance(2500);
    await h.emit({ type: "agent_settled", aborted });
    await h.emit(settled);
    assert.equal(h.messages.length, 1);
    assert.match(h.messages[0], /^3s · tools 2s · in /);
    await h.emit(toolEnd("unfinished"));
    await h.emit(before);
    h.advance(1000);
    await h.emit(settled);
    assert.match(h.messages[1], /^1s · tools 0s · in /);
  }
});

test("a fresh prompt discards pending tool intervals", async () => {
  const h = harness();
  await h.emit(before);
  await h.emit(toolStart("old"));
  h.advance(10000);
  await h.emit(before);
  await h.emit(toolEnd("old"));
  h.advance(1000);
  await h.emit(settled);
  assert.match(h.messages[0], /^1s · tools 0s · in /);
});

test("consecutive tasks reset usage, elapsed time, and completion wall clock", async () => {
  const h = harness();
  await h.emit(before);
  await h.emit({ type: "message_end", message: assistant() });
  h.advance(60000);
  await h.emit(settled);
  h.advance(100000);
  await h.emit(before);
  await h.emit({ type: "message_end", message: assistant({ usage: usage({ input: 1 }) }) });
  h.advance(2000);
  h.setDate(new Date(2026, 0, 1, 0, 0, 1));
  await h.emit(settled);
  assert.deepEqual(h.messages, [
    "1m 0s · tools 0s · in 160 (50 cached), out 20 · $0.0100 · 01:05:09 PM",
    "2s · tools 0s · in 61 (50 cached), out 20 · $0.0100 · 12:00:01 AM",
  ]);
});

test("idle events and user messages cannot add usage or create an entry", async () => {
  const h = harness();
  await h.emit({ type: "message_end", message: assistant() });
  await h.emit(settled);
  assert.equal(h.messages.length, 0);
  await h.emit(before);
  await h.emit({ type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } });
  await h.emit(settled);
  assert.equal(h.messages[0], "0s · tools 0s · in 0 (0 cached), out 0 · $0.0000 · 01:05:09 PM");
});

test("compaction usage is counted once within the active task", async () => {
  const h = harness();
  const event: SessionCompactEvent = {
    type: "session_compact", reason: "overflow", willRetry: true, fromExtension: false,
    compactionEntry: {
      type: "compaction", id: "c", parentId: null, timestamp: "",
      summary: "", firstKeptEntryId: "a", tokensBefore: 100, usage: usage(),
    },
  };
  await h.emit(event);
  await h.emit(before);
  await h.emit(event);
  await h.emit(event);
  await h.emit({ type: "message_end", message: assistant() });
  await h.emit(settled);
  assert.equal(h.messages[0], "0s · tools 0s · in 320 (100 cached), out 40 · $0.0200 · 01:05:09 PM");
});

test("ignores a historical compaction event when the new summary matches", async () => {
  const h = harness();
  const historical: SessionCompactEvent["compactionEntry"] = {
    type: "compaction", id: "old-c", parentId: null, timestamp: "",
    summary: "same summary", firstKeptEntryId: "a", tokensBefore: 100, usage: usage(),
  };
  h.setEntries([historical]);
  await h.emit(before);
  const current = { ...historical, id: "new-c", usage: { ...usage(), input: 320 } };
  h.setEntries([historical, current]);
  await h.emit({
    type: "session_compact", reason: "overflow", willRetry: true, fromExtension: false,
    compactionEntry: historical,
  });
  await h.emit(settled);
  assert.deepEqual(h.messages, ["0s · tools 0s · in 380 (50 cached), out 20 · $0.0100 · 01:05:09 PM"]);
});

test("settlement includes boundary compaction usage without a session_compact event", async () => {
  const h = harness();
  await h.emit(before);
  h.setEntries([{
    type: "compaction", id: "boundary-c", parentId: null, timestamp: "",
    summary: "", firstKeptEntryId: "a", tokensBefore: 100, usage: usage(),
  }]);
  await h.emit(settled);
  assert.deepEqual(h.messages, ["0s · tools 0s · in 160 (50 cached), out 20 · $0.0100 · 01:05:09 PM"]);
});

test("aborted tasks report partial usage once and cannot leak into the next task", async () => {
  const h = harness();
  await h.emit(before);
  await h.emit({ type: "message_end", message: assistant({ stopReason: "aborted" }) });
  h.advance(1000);
  await h.emit({ type: "agent_settled", aborted: true });
  assert.equal(h.messages[0], "1s · tools 0s · in 160 (50 cached), out 20 · $0.0100 · 01:05:09 PM");
  await h.emit(before);
  await h.emit(settled);
  assert.equal(h.messages[1], "0s · tools 0s · in 0 (0 cached), out 0 · $0.0000 · 01:05:09 PM");
});

test("successful session changes, shutdown, reload, and tree navigation clear pending state", async () => {
  for (const event of [
    { type: "session_start", reason: "resume" },
    { type: "session_start", reason: "reload" },
    { type: "session_start", reason: "fork" },
    { type: "session_shutdown", reason: "new" },
    { type: "session_tree", newLeafId: "leaf", oldLeafId: "old", fromExtension: false },
  ] as ExtensionEvent[]) {
    const h = harness();
    await h.emit(before);
    await h.emit({ type: "message_end", message: assistant() });
    await h.emit(toolStart("pending"));
    h.advance(2000);
    await h.emit(event);
    await h.emit(settled);
    assert.deepEqual(h.messages, [], event.type);
    await h.emit(before);
    await h.emit(settled);
    assert.equal(h.messages[0], "0s · tools 0s · in 0 (0 cached), out 0 · $0.0000 · 01:05:09 PM");
  }
});

test("a fresh prompt replaces a start that failed before the agent loop", async () => {
  const h = harness();
  await h.emit(before);
  h.advance(60000);
  await h.emit(before);
  await h.emit({ type: "agent_start" });
  h.advance(1000);
  await h.emit(settled);
  assert.equal(h.messages[0], "1s · tools 0s · in 0 (0 cached), out 0 · $0.0000 · 01:05:09 PM");
});

test("agent_start provides a fallback when loaded without a before_agent_start", async () => {
  const h = harness();
  await h.emit({ type: "agent_start" });
  await h.emit({ type: "message_end", message: assistant() });
  h.advance(1000);
  await h.emit(settled);
  assert.equal(h.messages[0], "1s · tools 0s · in 160 (50 cached), out 20 · $0.0100 · 01:05:09 PM");
});

test("print/JSON modes clear state silently while RPC records the entry", async () => {
  const h = harness();
  h.ctx.hasUI = false;
  await h.emit(before);
  await h.emit({ type: "message_end", message: assistant() });
  await h.emit(settled);
  h.ctx.hasUI = true;
  await h.emit(settled);
  assert.equal(h.messages.length, 0);
  h.ctx.mode = "rpc";
  await h.emit(before);
  await h.emit({ type: "message_end", message: assistant() });
  await h.emit(settled);
  assert.equal(h.messages.length, 1);
});

test("Pi discovers the manifest entry point and its real loaded factory", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), "pi-time-load-"));
  try {
    const result = await discoverAndLoadExtensions([root], dir, dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const extension = result.extensions[0]!;
    for (const event of ["before_agent_start", "agent_start", "message_end", "tool_execution_start", "tool_execution_end", "agent_settled"]) {
      assert.equal(extension.handlers.get(event)?.length, 1, event);
    }
    assert.ok(extension.entryRenderers?.has("pi-time"));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./extensions/time/index.ts"]);
    assert.ok(manifest.files.includes("src"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
