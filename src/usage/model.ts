export interface UsageRecord {
  version: 1;
  id: string;
  requestId: string;
  startedAt: number;
  durationMs: number;
  firstTokenMs?: number;
  endpoint: string;
  model: string;
  client: string;
  sessionId?: string;
  sessionName?: string;
  outcome: "completed" | "failed" | "cancelled";
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export function boundedLabel(value: unknown, limit = 160): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const label = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return label ? label.slice(0, limit) : undefined;
}

export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

// Reconstruct only the schema's allowlisted fields, including when reading disk.
export function parseRecord(value: unknown): UsageRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    !boundedLabel(row.id) ||
    !boundedLabel(row.requestId) ||
    count(row.startedAt) === undefined ||
    count(row.durationMs) === undefined ||
    !["completed", "failed", "cancelled"].includes(String(row.outcome))
  ) {
    return undefined;
  }
  return {
    version: 1,
    id: boundedLabel(row.id)!,
    requestId: boundedLabel(row.requestId)!,
    startedAt: row.startedAt as number,
    durationMs: row.durationMs as number,
    firstTokenMs: count(row.firstTokenMs),
    endpoint: boundedLabel(row.endpoint) ?? "unknown",
    model: boundedLabel(row.model) ?? "unknown",
    client: boundedLabel(row.client) ?? "other",
    sessionId: boundedLabel(row.sessionId),
    sessionName: boundedLabel(row.sessionName),
    outcome: row.outcome as UsageRecord["outcome"],
    inputTokens: count(row.inputTokens),
    outputTokens: count(row.outputTokens),
    cachedTokens: count(row.cachedTokens),
    cacheWriteTokens: count(row.cacheWriteTokens),
    reasoningTokens: count(row.reasoningTokens),
  };
}

export interface UsageFilter {
  since?: number;
  model?: string;
  session?: string;
}
export function sessionKey(row: UsageRecord): string {
  return row.sessionId
    ? JSON.stringify([row.client, row.sessionId])
    : "uncorrelated";
}
export function filterRecords(
  rows: UsageRecord[],
  filter: UsageFilter,
): UsageRecord[] {
  return rows.filter(
    (row) =>
      (!filter.since || row.startedAt >= filter.since) &&
      (!filter.model || row.model === filter.model) &&
      (!filter.session || sessionKey(row) === filter.session),
  );
}

export function summarize(rows: UsageRecord[]) {
  const known = rows.filter(
    (row) => row.inputTokens !== undefined && row.outputTokens !== undefined,
  );
  const cacheKnown = rows.filter(
    (row) =>
      row.inputTokens !== undefined &&
      row.cachedTokens !== undefined &&
      row.cachedTokens <= row.inputTokens,
  );
  const sum = (
    items: UsageRecord[],
    key:
      | "inputTokens"
      | "outputTokens"
      | "cachedTokens"
      | "cacheWriteTokens"
      | "reasoningTokens",
  ) => items.reduce((total, row) => total + (row[key] ?? 0), 0);
  const cacheInput = sum(cacheKnown, "inputTokens");
  const latencies = rows.map((row) => row.durationMs).sort((a, b) => a - b);
  return {
    calls: rows.length,
    completed: rows.filter((row) => row.outcome === "completed").length,
    failed: rows.filter((row) => row.outcome === "failed").length,
    cancelled: rows.filter((row) => row.outcome === "cancelled").length,
    reportedCalls: known.length,
    cacheReportedCalls: cacheKnown.length,
    inputTokens: sum(known, "inputTokens"),
    outputTokens: sum(known, "outputTokens"),
    cachedTokens: sum(cacheKnown, "cachedTokens"),
    cacheWriteTokens: sum(rows, "cacheWriteTokens"),
    reasoningTokens: sum(rows, "reasoningTokens"),
    cacheHitRate: cacheInput
      ? sum(cacheKnown, "cachedTokens") / cacheInput
      : null,
    averageMs: rows.length
      ? Math.round(rows.reduce((n, row) => n + row.durationMs, 0) / rows.length)
      : null,
    p95Ms: latencies.length
      ? latencies[Math.ceil(latencies.length * 0.95) - 1]
      : null,
  };
}

export function groupRecords(
  rows: UsageRecord[],
  key: (row: UsageRecord) => string,
) {
  const groups = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const name = key(row);
    let group = groups.get(name);
    if (!group) {
      group = [];
      groups.set(name, group);
    }
    group.push(row);
  }
  return [...groups].map(([name, records]) => ({
    name,
    ...summarize(records),
  }));
}

export function parseSessionNames(text: string): Record<string, string> {
  const names: Record<string, string> = Object.create(null);
  let imported = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length > 4096) {
      continue;
    }
    try {
      const row = JSON.parse(line);
      const id = boundedLabel(row.id);
      const title = boundedLabel(row.thread_name ?? row.title);
      if (id && title && (Object.hasOwn(names, id) || imported < 10000)) {
        if (!Object.hasOwn(names, id)) {
          imported++;
        }
        names[id] = title;
      }
    } catch {
      /* Ignore incomplete metadata lines. */
    }
  }
  return names;
}
