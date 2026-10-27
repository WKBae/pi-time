import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, Type,
  type AssistantMessage, type SimpleStreamOptions, type Usage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, createEventBus, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type AgentSessionEvent, type CustomEntry, type EventBus, type Extension, type ExtensionAPI, type ExtensionError,
  type ExtensionFactory, type ExtensionRuntime, type ExtensionUIContext, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import registerTimeExtension from "../src/index.ts";

// Pi 1.3.0 exports the runtime but keeps its inline factory loader internal.
const { loadExtensionFromFactory } = await import(new URL(
  "./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"),
).href) as {
  loadExtensionFromFactory(
    factory: ExtensionFactory, cwd: string, eventBus: EventBus, runtime: ExtensionRuntime,
    extensionPath?: string,
  ): Promise<Extension>;
};

function usage(units = 1): Usage {
  return {
    input: 100 * units, cacheRead: 50 * units, cacheWrite: 10 * units,
    output: 20 * units, totalTokens: 180 * units,
    cost: { input: 0.001 * units, output: 0.002 * units, cacheRead: 0.003 * units,
      cacheWrite: 0.004 * units, total: 0.01 * units },
  };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "Done" }],
    api: "time-test-api", provider: "time-test", model: "test",
    stopReason: "stop", timestamp: 0, usage: usage(), ...overrides,
  };
}

type Response = (options?: SimpleStreamOptions) => AssistantMessage | Promise<AssistantMessage>;

async function harness(
  t: TestContext,
  configure: (pi: ExtensionAPI) => void = () => {},
  persist = false,
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-time-session-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let now = 0;
  const responses: Response[] = [];
  const failures: unknown[] = [];
  const events: AgentSessionEvent[] = [];
  const errors: ExtensionError[] = [];
  const compactionEvents: string[] = [];
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory((pi) => {
    registerTimeExtension(pi, {
      now: () => now,
      date: () => new Date(2026, 0, 1, 13, 5, 9),
    });
    pi.on("session_compact", (event) => { compactionEvents.push(event.compactionEntry.id); });
    configure(pi);
  }, cwd, createEventBus(), runtime, "<inline:time-integration>");
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [extension], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Integration test.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error("Unexpected resource discovery"); },
    reload: async () => { throw new Error("Unexpected resource reload"); },
  };
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerProvider("time-test", {
    api: "time-test-api", baseUrl: "http://unused.invalid", apiKey: "fake",
    models: [{
      id: "test", name: "Test", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 4096,
    }],
    streamSimple(_model, _context, options) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        let message: AssistantMessage;
        try {
          const response = responses.shift();
          assert.ok(response, "Unexpected model request");
          message = await response(options);
          assert.notEqual(message.stopReason, "pending", "Script must complete the response");
        } catch (error) {
          failures.push(error);
          message = assistant({ stopReason: "error", errorMessage: String(error) });
        }
        stream.push({ type: "start", partial: message });
        if (message.stopReason === "error" || message.stopReason === "aborted") {
          stream.push({ type: "error", reason: message.stopReason, error: message });
        } else if (message.stopReason !== "pending") {
          stream.push({ type: "done", reason: message.stopReason, message });
        }
        stream.end(message);
      });
      return stream;
    },
  });
  const model = modelRuntime.getModel("time-test", "test");
  assert.ok(model);
  const { session } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), modelRuntime, model, thinkingLevel: "off",
    resourceLoader,
    sessionManager: persist
      ? SessionManager.create(cwd, join(cwd, "sessions"))
      : SessionManager.inMemory(cwd),
    noTools: "builtin",
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false }, cacheWarming: "off",
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 0, maxAgentDelayMs: 0,
        provider: { maxRetries: 0 } },
    }),
  });
  t.after(() => session.dispose());
  const messages = () => session.sessionManager.getEntries().filter(
    (entry): entry is CustomEntry<{ message: string }> => entry.type === "custom" && entry.customType === "pi-time",
  ).map((entry) => entry.data!.message);
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "agent_end") assert.deepEqual(messages(), [], "Recorded before settlement");
  });
  await session.bindExtensions({
    mode: "tui",
    uiContext: {} as ExtensionUIContext,
    onError: (error) => { errors.push(error); },
  });
  return {
    session, extension, events, messages, responses, compactionEvents,
    advance(ms: number) { now += ms; },
    async prompt() { await session.prompt("Work", { expandPromptTemplates: false }); },
    verify() {
      assert.deepEqual(failures, []);
      assert.deepEqual(errors, []);
      assert.equal(responses.length, 0, "Unused model responses");
      assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
      assert.equal(messages().length, 1);
    },
  };
}

const options = { timeout: 15000 };

test("AgentSession retries a transient failure and records once with both attempts", options, async (t) => {
  const h = await harness(t, () => {}, true);
  h.responses.push(
    () => { h.advance(1000); return assistant({ stopReason: "error", errorMessage: "503 overloaded" }); },
    () => { h.advance(2000); return assistant(); },
  );
  await h.prompt();
  h.verify();
  assert.equal(h.events.filter((event) => event.type === "agent_start").length, 2);
  assert.equal(h.events.filter((event) => event.type === "agent_end").length, 2);
  assert.ok(h.events.some((event) => event.type === "auto_retry_end" && event.success));
  assert.deepEqual(h.messages(), ["3s · tools 0s · in 320 (100 cached), out 40 · $0.0200 · 01:05:09 PM"]);
  const sessionFile = h.session.sessionManager.getSessionFile();
  assert.ok(sessionFile);
  const reloaded = SessionManager.open(sessionFile);
  const reloadedEntry = reloaded.getEntries().find(
    (entry): entry is CustomEntry<{ message: string }> => entry.type === "custom" && entry.customType === "pi-time",
  );
  assert.deepEqual(reloadedEntry?.data, { message: h.messages()[0] });
  const renderer = h.extension.entryRenderers?.get("pi-time");
  assert.ok(renderer);
  const rendered = renderer(reloadedEntry!, { expanded: false }, {
    fg(_color, text) { return text; },
  } as Parameters<typeof renderer>[2]);
  assert.ok(rendered);
  assert.match(rendered.render(80)[0]!, /^ 3s\s+·/);
});

for (const continueTask of [false, true]) {
  test(`AgentSession counts persisted boundary compaction (continue: ${continueTask})`, options, async (t) => {
    let compacted = false;
    const h = await harness(t, (pi) => {
      pi.on("agent_before_settle", (event) => {
        if (compacted) return;
        compacted = true;
        h.advance(1000);
        return {
          entries: [...event.entries, {
            type: "compaction", summary: "Continue from this summary.",
            firstKeptEntryId: null, usage: usage(2),
          }],
          continue: continueTask,
        };
      });
    });
    h.responses.push(() => { h.advance(1000); return assistant(); });
    if (continueTask) h.responses.push(() => { h.advance(1000); return assistant(); });
    await h.prompt();
    h.verify();
    assert.equal(h.events.filter((event) => event.type === "agent_start").length, continueTask ? 2 : 1);
    assert.deepEqual(h.compactionEvents, []);
    const compactions = h.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1);
    assert.deepEqual(compactions[0]!.usage, usage(2));
    assert.deepEqual(h.messages(), [continueTask
      ? "3s · tools 0s · in 640 (200 cached), out 80 · $0.0400 · 01:05:09 PM"
      : "2s · tools 0s · in 480 (150 cached), out 60 · $0.0300 · 01:05:09 PM"]);
  });
}

test("AgentSession aggregates nested tool usage and counts overlapping tool time once", options, async (t) => {
  const h = await harness(t, (pi) => {
    pi.registerTool({
      name: "inner", label: "Inner", description: "Nested test tool", parameters: Type.Object({}),
      exposure: "codemode",
      async execute() {
        h.advance(2000);
        return { content: [{ type: "text", text: "Inner" }], details: {}, usage: usage(2) };
      },
    });
    pi.registerTool({
      name: "outer", label: "Outer", description: "Calls inner", parameters: Type.Object({}),
      async execute(_id, _args, _signal, _update, ctx) {
        const outcome = await ctx.executeTool("inner", {});
        assert.equal(outcome.isError, false);
        h.advance(1000);
        return { content: [{ type: "text", text: "Outer" }], details: {}, usage: usage(3) };
      },
    });
  });
  h.responses.push(
    () => { h.advance(1000); return assistant({ stopReason: "toolUse", content: [
      { type: "toolCall", id: "root", name: "outer", arguments: {} },
    ] }); },
    () => { h.advance(1000); return assistant(); },
  );
  await h.prompt();
  h.verify();
  const starts = h.events.filter((event) => event.type === "tool_execution_start");
  assert.deepEqual(starts.map((event) => [event.toolCallId, event.parentToolCallId]), [
    ["root", undefined], ["root/1", "root"],
  ]);
  const results = h.events.filter((event) => event.type === "message_end")
    .map((event) => event.message).filter((message) => message.role === "toolResult");
  assert.equal(results.length, 1);
  const { cost, ...tokens } = results[0]!.usage!;
  assert.deepEqual(tokens, { input: 500, cacheRead: 250, cacheWrite: 50, output: 100, totalTokens: 900 });
  assert.equal(cost.total, 0.05);
  assert.deepEqual(h.messages(), ["5s · tools 3s · in 1,120 (350 cached), out 140 · $0.0700 · 01:05:09 PM"]);
});

test("AgentSession abort settles once and reports partial usage", options, async (t) => {
  const h = await harness(t);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.responses.push(async (options) => {
    const signal = options?.signal;
    assert.ok(signal);
    entered();
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return assistant({ stopReason: "aborted", content: [{ type: "text", text: "Partial" }] });
  });
  const running = h.prompt();
  await started;
  h.advance(3000);
  await h.session.abort();
  await running;
  h.verify();
  assert.ok(h.events.some((event) => event.type === "agent_settled" && event.aborted));
  assert.deepEqual(h.messages(), ["3s · tools 0s · in 160 (50 cached), out 20 · $0.0100 · 01:05:09 PM"]);
});
