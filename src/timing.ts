import type { Usage } from "@earendil-works/pi-ai";

export interface UsageTotals {
  input: number;
  cached: number;
  output: number;
  cost: number;
}

export type ReportedUsage = Partial<Omit<Usage, "cost">> & {
  cost?: Partial<Usage["cost"]>;
};

export function createUsageTotals(): UsageTotals {
  return { input: 0, cached: 0, output: 0, cost: 0 };
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

export function addUsage(totals: UsageTotals, usage?: ReportedUsage): void {
  if (!usage) return;
  // Pi reports input, cacheRead, and cacheWrite as disjoint token buckets.
  totals.input += nonNegative(usage.input) + nonNegative(usage.cacheRead) + nonNegative(usage.cacheWrite);
  totals.cached += nonNegative(usage.cacheRead);
  totals.output += nonNegative(usage.output);
  totals.cost += nonNegative(usage.cost?.total);
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(nonNegative(milliseconds) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}

export function formatCompletionTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hour = date.getHours();
  return `${pad(hour % 12 || 12)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hour >= 12 ? "PM" : "AM"}`;
}

const tokens = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatSummary(elapsedMs: number, toolMs: number, totals: UsageTotals, completedAt: Date): string {
  return `${formatDuration(elapsedMs)} · tools ${formatDuration(toolMs)} · in ${tokens.format(totals.input)} (${tokens.format(totals.cached)} cached), out ${tokens.format(totals.output)} · $${totals.cost.toFixed(4)} · ${formatCompletionTime(completedAt)}`;
}
