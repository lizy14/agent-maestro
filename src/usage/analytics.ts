import type { CreditView } from "./credits";
import { UsageRecord, sessionKey, summarize } from "./model";
import catalog from "./prices.json";

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}
export interface PricingOptions {
  overrides?: Record<string, ModelPrice>;
  aliases?: Record<string, string>;
}
export const PRICE_DATE = catalog.retrieved;
interface CatalogPrice {
  rates: ModelPrice;
  threshold?: number;
  longContext?: ModelPrice;
  validUntil?: string;
}
const prices = catalog.models as Record<string, CatalogPrice>;
const aliases = catalog.aliases as Record<string, string>;
const rate = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function modelPrice(
  model: string,
  input: number,
  options: PricingOptions = {},
  at = Date.now(),
): { rates: ModelPrice; source: string } | undefined {
  const alias =
    options.aliases && Object.hasOwn(options.aliases, model)
      ? options.aliases[model]
      : model;
  if (typeof alias !== "string") {
    return undefined;
  }
  const override =
    options.overrides && Object.hasOwn(options.overrides, alias)
      ? options.overrides[alias]
      : undefined;
  if (override) {
    if (
      !rate(override.input) ||
      !rate(override.output) ||
      (override.cacheRead !== undefined && !rate(override.cacheRead)) ||
      (override.cacheWrite !== undefined && !rate(override.cacheWrite))
    ) {
      return undefined;
    }
    return {
      rates: override,
      source: "Configured USD / million tokens: " + alias,
    };
  }
  const canonical = Object.hasOwn(aliases, alias) ? aliases[alias] : alias;
  if (!Object.hasOwn(prices, canonical)) {
    return undefined;
  }
  const entry = prices[canonical];
  if (
    entry.validUntil &&
    at >= Date.parse(entry.validUntil + "T00:00:00Z") + 86400000
  ) {
    return undefined;
  }
  const long =
    entry.threshold !== undefined &&
    input > entry.threshold &&
    entry.longContext;
  return {
    rates: long || entry.rates,
    source:
      "GitHub Copilot official model rates " +
      PRICE_DATE +
      ": " +
      canonical +
      (long ? " (long context)" : "") +
      " — " +
      catalog.source,
  };
}

export type CacheState = "hit" | "miss" | "unknown";
export function cacheState(row: UsageRecord): CacheState {
  if (
    row.inputTokens === undefined ||
    row.inputTokens <= 0 ||
    row.cachedTokens === undefined ||
    row.cachedTokens > row.inputTokens
  ) {
    return "unknown";
  }
  return row.cachedTokens > 0 ? "hit" : "miss";
}
export function inputBucket(row: UsageRecord): string {
  if (row.inputTokens === undefined) {
    return "Unknown input";
  }
  return row.inputTokens < 8000
    ? "<8k"
    : row.inputTokens < 32000
      ? "8kâ€“32k"
      : row.inputTokens < 128000
        ? "32kâ€“128k"
        : "128k+";
}

export function estimateCost(row: UsageRecord, options: PricingOptions = {}) {
  const input = row.inputTokens,
    output = row.outputTokens;
  if (
    input === undefined ||
    output === undefined ||
    row.cachedTokens === undefined
  ) {
    return undefined;
  }
  const cached = row.cachedTokens,
    writes = row.cacheWriteTokens ?? 0;
  if (cached + writes > input) {
    return undefined;
  }
  const price = modelPrice(row.model, input, options, row.startedAt);
  if (
    !price ||
    (cached > 0 && price.rates.cacheRead === undefined) ||
    (writes > 0 && price.rates.cacheWrite === undefined)
  ) {
    return undefined;
  }
  const inputUsd =
    ((input - cached - writes) * price.rates.input +
      cached * (price.rates.cacheRead ?? 0) +
      writes * (price.rates.cacheWrite ?? 0)) /
    1e6;
  const outputUsd = (output * price.rates.output) / 1e6;
  const uncachedUsd = (input * price.rates.input) / 1e6;
  return {
    totalUsd: inputUsd + outputUsd,
    inputUsd,
    outputUsd,
    savingsUsd: uncachedUsd - inputUsd,
    source: price.source,
    rates: price.rates,
  };
}

function quantile(values: number[], q: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)]
    : null;
}
export function callThroughput(row: UsageRecord): number | undefined {
  return row.outcome === "completed" &&
    row.outputTokens !== undefined &&
    row.durationMs > 0
    ? (row.outputTokens * 1000) / row.durationMs
    : undefined;
}
// Chunk delivery is not GPU decode telemetry. Exclude hidden reasoning, missing
// timing and one-chunk responses rather than reporting misleading infinity.
export function emissionRate(row: UsageRecord): number | undefined {
  if (
    row.outcome !== "completed" ||
    row.outputTokens === undefined ||
    row.reasoningTokens !== 0 ||
    row.firstTokenMs === undefined ||
    row.lastTokenMs === undefined ||
    (row.contentChunks ?? 0) < 2 ||
    row.lastTokenMs <= row.firstTokenMs
  ) {
    return undefined;
  }
  return (row.outputTokens * 1000) / (row.lastTokenMs - row.firstTokenMs);
}
export function analyze(rows: UsageRecord[], pricing: PricingOptions = {}) {
  const base = summarize(rows),
    costs = rows
      .map((r) => estimateCost(r, pricing))
      .filter((c): c is NonNullable<typeof c> => !!c);
  const ttft = rows
    .map((r) => r.firstTokenMs)
    .filter((n): n is number => n !== undefined);
  const rates = rows
    .map(callThroughput)
    .filter((n): n is number => n !== undefined);
  const emissions = rows
    .map(emissionRate)
    .filter((n): n is number => n !== undefined);
  const hits = rows.filter((r) => cacheState(r) === "hit").length,
    misses = rows.filter((r) => cacheState(r) === "miss").length;
  return {
    ...base,
    pricedCalls: costs.length,
    costUsd: costs.length ? costs.reduce((n, c) => n + c.totalUsd, 0) : null,
    savingsUsd: costs.length
      ? costs.reduce((n, c) => n + c.savingsUsd, 0)
      : null,
    hits,
    misses,
    cacheUnknown: rows.length - hits - misses,
    requestHitRate: hits + misses ? hits / (hits + misses) : null,
    ttftCalls: ttft.length,
    ttftP50: quantile(ttft, 0.5),
    ttftP95: quantile(ttft, 0.95),
    p50Ms: quantile(
      rows.map((r) => r.durationMs),
      0.5,
    ),
    p99Ms: quantile(
      rows.map((r) => r.durationMs),
      0.99,
    ),
    tpsCalls: rates.length,
    tpsP50: quantile(rates, 0.5),
    tpsP95: quantile(rates, 0.95),
    emissionCalls: emissions.length,
    emissionP50: quantile(emissions, 0.5),
    cacheWrites: rows.reduce((n, r) => n + (r.cacheWriteTokens ?? 0), 0),
  };
}
export type Pivot =
  | "model"
  | "session"
  | "client"
  | "endpoint"
  | "cache"
  | "modelCache"
  | "inputBucket";
export type TrendMetric =
  | "tokens"
  | "cost"
  | "ttft"
  | "latency"
  | "throughput"
  | "cache";
export interface DashboardOptions {
  pricing?: PricingOptions;
  pivot?: Pivot;
  metric?: TrendMetric;
  bucket?: "day" | "hour";
  namesStatus?: string;
  credits?: CreditView;
}
export function enrichedRecords(
  rows: UsageRecord[],
  pricing: PricingOptions = {},
) {
  return rows.map((row) => ({
    ...row,
    cacheState: cacheState(row),
    inputBucket: inputBucket(row),
    estimatedCost: estimateCost(row, pricing),
    outputTokensPerSecond: callThroughput(row),
    observedEmissionTokensPerSecond: emissionRate(row),
  }));
}
export function exportCsv(
  rows: UsageRecord[],
  pricing: PricingOptions = {},
): string {
  const cell = (value: unknown) =>
    '"' +
    String(value ?? "")
      .replace(/^[=+\-@]/, "'$&")
      .replaceAll('"', '""') +
    '"';
  const headers = [
    "id",
    "requestId",
    "startedAt",
    "model",
    "client",
    "sessionId",
    "outcome",
    "cacheState",
    "inputTokens",
    "cachedTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "ttftMs",
    "durationMs",
    "outputTokensPerSecond",
    "observedEmissionTokensPerSecond",
    "estimatedUsd",
    "priceSource",
  ];
  const lines = enrichedRecords(rows, pricing).map((row) =>
    [
      row.id,
      row.requestId,
      new Date(row.startedAt).toISOString(),
      row.model,
      row.client,
      row.sessionId,
      row.outcome,
      row.cacheState,
      row.inputTokens,
      row.cachedTokens,
      row.cacheWriteTokens,
      row.outputTokens,
      row.reasoningTokens,
      row.firstTokenMs,
      row.durationMs,
      row.outputTokensPerSecond,
      row.observedEmissionTokensPerSecond,
      row.estimatedCost?.totalUsd,
      row.estimatedCost?.source,
    ]
      .map(cell)
      .join(","),
  );
  return [headers.map(cell).join(","), ...lines].join("\r\n");
}
export function pivotRows(
  rows: UsageRecord[],
  pivot: Pivot,
  pricing: PricingOptions = {},
) {
  const groups = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const key =
      pivot === "session"
        ? sessionKey(row)
        : pivot === "modelCache"
          ? row.model + " / " + cacheState(row)
          : pivot === "inputBucket"
            ? inputBucket(row)
            : pivot === "cache"
              ? cacheState(row)
              : row[pivot];
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(row);
  }
  return [...groups]
    .map(([name, group]) => ({ name, ...analyze(group, pricing) }))
    .sort((a, b) => b.calls - a.calls);
}
