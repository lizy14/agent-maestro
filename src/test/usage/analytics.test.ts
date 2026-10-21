import * as assert from "assert";

import {
  analyze,
  cacheState,
  callThroughput,
  emissionRate,
  estimateCost,
  exportCsv,
  modelPrice,
  pivotRows,
} from "../../usage/analytics";
import { dashboardHtml } from "../../usage/dashboardHtml";
import { UsageRecord, filterRecords, parseRecord } from "../../usage/model";

const row = (extra: Partial<UsageRecord> = {}): UsageRecord => ({
  version: 1,
  id: "a",
  requestId: "request",
  model: "test",
  client: "Codex",
  endpoint: "/v1/responses",
  startedAt: Date.now(),
  durationMs: 2000,
  firstTokenMs: 500,
  lastTokenMs: 1500,
  contentChunks: 2,
  outcome: "completed",
  inputTokens: 1000,
  outputTokens: 100,
  cachedTokens: 800,
  cacheWriteTokens: 50,
  reasoningTokens: 0,
  ...extra,
});
const pricing = {
  overrides: {
    test: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  },
};
suite("Usage performance and USD analytics", () => {
  test("cost separates uncached/cache-write/cache-read input and never double counts reasoning", () => {
    const estimate = estimateCost(row({ reasoningTokens: 20 }), pricing)!;
    assert.ok(Math.abs(estimate.totalUsd - 0.001585) < 1e-12);
    assert.ok(Math.abs(estimate.savingsUsd - 0.001415) < 1e-12);
    assert.strictEqual(estimate.outputUsd, 0.001);
    assert.ok(estimate.source.startsWith("Configured"));
  });
  test("unknown pricing/cache data is excluded; explicit zero prices are valid", () => {
    assert.strictEqual(estimateCost(row()), undefined);
    assert.strictEqual(
      estimateCost(row({ cachedTokens: undefined }), pricing),
      undefined,
    );
    assert.strictEqual(
      estimateCost(row({ cachedTokens: 1000, cacheWriteTokens: 1 }), pricing),
      undefined,
    );
    assert.strictEqual(
      estimateCost(row(), { overrides: { test: { input: 2, output: 10 } } }),
      undefined,
    );
    assert.strictEqual(
      estimateCost(row({ cacheWriteTokens: 0 }), {
        overrides: { test: { input: 0, output: 0, cacheRead: 0 } },
      })!.totalUsd,
      0,
    );
    assert.strictEqual(
      modelPrice("test", 100, {
        overrides: { test: { input: NaN, output: 10 } },
      }),
      undefined,
    );
  });
  test("catalog uses exact aliases and long-context thresholds", () => {
    const standard = modelPrice("gpt-6.1-sol", 1000)!;
    const long = modelPrice("gpt-6.1-sol", 300000)!;
    assert.ok(standard && long);
    assert.ok(long.rates.input > standard.rates.input);
    assert.strictEqual(modelPrice("gpt-6.1-sol-custom", 1000), undefined);
    assert.deepStrictEqual(
      modelPrice("custom", 1000, { aliases: { custom: "gpt-6.1-sol" } }),
      standard,
    );
    assert.strictEqual(modelPrice("__proto__", 1000), undefined);
  });
  test("official Copilot fallback preserves exact rates, thresholds and promotional expiry", () => {
    const now = Date.UTC(2026, 9, 21);
    assert.deepStrictEqual(modelPrice("gpt-6.1-sol", 272000, {}, now)!.rates, {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: 2.5,
    });
    assert.deepStrictEqual(modelPrice("gpt-6.1-sol", 272001, {}, now)!.rates, {
      input: 4,
      output: 15,
      cacheRead: 0.2,
      cacheWrite: 5,
    });
    assert.strictEqual(
      modelPrice("claude-sonnet-4-6", 1000, {}, now)!.rates.cacheWrite,
      3.75,
    );
    assert.ok(
      modelPrice("gpt-6-astra", 1000, {}, now)!.source.includes(
        "docs.github.com",
      ),
    );
    assert.strictEqual(
      modelPrice("gemini-4-argon", 1000, {}, Date.UTC(2026, 11, 1)),
      undefined,
    );
    assert.ok(modelPrice("gemini-4-argon", 1000, {}, Date.UTC(2026, 10, 30)));
    assert.strictEqual(modelPrice("gpt-5.5", 1000, {}, now), undefined);
    assert.strictEqual(
      modelPrice(
        "gpt-6.1-sol",
        500000,
        { overrides: { "gpt-6.1-sol": { input: 1, output: 2 } } },
        now,
      )!.rates.input,
      1,
    );
  });
  test("throughput excludes failed/zero-time and emission excludes reasoning or buffered calls", () => {
    assert.strictEqual(callThroughput(row()), 50);
    assert.strictEqual(emissionRate(row()), 100);
    for (const extra of [
      { outcome: "failed" as const },
      { durationMs: 0 },
      { outputTokens: undefined },
    ]) {
      assert.strictEqual(callThroughput(row(extra)), undefined);
    }
    for (const extra of [
      { reasoningTokens: 1 },
      { reasoningTokens: undefined },
      { contentChunks: 1 },
      { lastTokenMs: 500 },
      { firstTokenMs: undefined },
      { outcome: "cancelled" as const },
    ]) {
      assert.strictEqual(emissionRate(row(extra)), undefined);
    }
  });
  test("cache cohort pivots preserve unknowns and use per-call percentiles", () => {
    const rows = [
      row({ id: "hit", firstTokenMs: 100 }),
      row({ id: "miss", cachedTokens: 0, firstTokenMs: 900 }),
      row({ id: "unknown", cachedTokens: undefined, firstTokenMs: undefined }),
    ];
    assert.deepStrictEqual(rows.map(cacheState), ["hit", "miss", "unknown"]);
    const summary = analyze(rows, pricing);
    assert.strictEqual(summary.requestHitRate, 0.5);
    assert.strictEqual(summary.ttftP50, 100);
    assert.strictEqual(summary.ttftP95, 900);
    assert.strictEqual(summary.pricedCalls, 2);
    const groups = pivotRows(rows, "modelCache", pricing);
    assert.strictEqual(groups.length, 3);
    assert.strictEqual(
      groups.reduce((n, g) => n + g.calls, 0),
      3,
    );
    assert.deepStrictEqual(
      filterRecords(rows, {
        cache: "unknown",
        client: "Codex",
        outcome: "completed",
      }),
      [rows[2]],
    );
    assert.strictEqual(filterRecords(rows, { until: 1 }).length, 0);
    assert.strictEqual(analyze([]).costUsd, null);
  });
  test("CSV quotes delimiters and protects spreadsheet formulas", () => {
    const csv = exportCsv([row({ model: '=FORMULA("x")', sessionId: "a,b" })]);
    assert.ok(csv.includes('"\'=FORMULA(""x"")"'));
    assert.ok(csv.includes('"a,b"'));
    assert.ok(!csv.includes("undefined"));
  });
  test("old journals preserve missing timing and the UI exposes richer controls without scripts from labels", () => {
    const old = parseRecord(
      row({ lastTokenMs: undefined, contentChunks: undefined }),
    )!;
    assert.strictEqual(emissionRate(old), undefined);
    const html = dashboardHtml("nonce", [old], [old], {}, {}, 30, true, false, {
      pricing,
      pivot: "modelCache",
      metric: "cost",
    });
    for (const label of [
      "Estimated USD",
      "Configure prices",
      "Export CSV",
      "Performance and cost pivot",
      "Time to first content distribution",
      "not GPU decode speed",
      "TTFT versus uncached input",
    ]) {
      assert.ok(html.includes(label), label);
    }
    assert.ok(html.includes('id="cache"'));
    assert.ok(html.includes('id="metric"'));
  });
});
