import type { CompactionEntry, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, createUsageTotals, formatNotification } from "./timing.ts";
import type { UsageTotals } from "./timing.ts";

export interface Clock {
  now(): number;
  date(): Date;
}

const systemClock: Clock = {
  now: () => performance.now(),
  date: () => new Date(),
};

interface Run {
  startedAt: number;
  totals: UsageTotals;
  toolMs: number;
  activeToolIds: Set<string>;
  toolsStartedAt: number | undefined;
  seen: WeakSet<object>;
  entryCount: number | undefined;
  preexistingCompactionIds: Set<string>;
  compactionIds: Set<string>;
}

function addCompaction(run: Run, entry: CompactionEntry): void {
  if (run.compactionIds.has(entry.id)) return;
  run.compactionIds.add(entry.id);
  addUsage(run.totals, entry.usage);
}

export default function registerTimeExtension(pi: ExtensionAPI, clock: Clock = systemClock): void {
  let run: Run | undefined;
  const start = (ctx: ExtensionContext): Run => {
    const entries = ctx.sessionManager?.getEntries();
    return {
      startedAt: clock.now(),
      totals: createUsageTotals(),
      toolMs: 0,
      activeToolIds: new Set(),
      toolsStartedAt: undefined,
      seen: new WeakSet(),
      entryCount: entries?.length,
      preexistingCompactionIds: new Set(
        entries?.filter((entry): entry is CompactionEntry => entry.type === "compaction").map((entry) => entry.id),
      ),
      compactionIds: new Set(),
    };
  };
  const reset = () => { run = undefined; };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("session_tree", reset);

  pi.on("before_agent_start", (_event, ctx) => { run = start(ctx); });
  pi.on("agent_start", (_event, ctx) => {
    // Retries and boundary continuations can start more loops before settlement.
    run ??= start(ctx);
  });

  pi.on("message_end", (event) => {
    if (!run || run.seen.has(event.message)) return;
    run.seen.add(event.message);
    if (event.message.role === "assistant" || event.message.role === "toolResult") {
      addUsage(run.totals, event.message.usage);
    }
  });

  pi.on("tool_execution_start", (event) => {
    if (!run) return;
    // Measure the union of tool intervals, including parallel and nested calls.
    if (run.activeToolIds.size === 0) run.toolsStartedAt = clock.now();
    run.activeToolIds.add(event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    if (!run || !run.activeToolIds.delete(event.toolCallId)) return;
    if (run.activeToolIds.size === 0 && run.toolsStartedAt !== undefined) {
      run.toolMs += clock.now() - run.toolsStartedAt;
      run.toolsStartedAt = undefined;
    }
  });

  pi.on("session_compact", (event) => {
    if (run && !run.preexistingCompactionIds.has(event.compactionEntry.id)) {
      addCompaction(run, event.compactionEntry);
    }
  });

  pi.on("agent_settled", (event, ctx) => {
    const completed = run;
    reset();
    if (!completed || !ctx.hasUI) return;
    // Boundary handlers may persist compactions without a session_compact event.
    if (completed.entryCount !== undefined) {
      for (const entry of ctx.sessionManager.getEntries().slice(completed.entryCount)) {
        if (entry.type === "compaction") addCompaction(completed, entry);
      }
    }
    const now = clock.now();
    // Include partial tool time if settlement arrives without an end event.
    const toolMs = completed.toolMs + (completed.toolsStartedAt === undefined ? 0 : now - completed.toolsStartedAt);
    ctx.ui.notify(
      formatNotification(now - completed.startedAt, toolMs, completed.totals, clock.date()),
      event.aborted ? "warning" : "info",
    );
  });
}
