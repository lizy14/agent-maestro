import * as assert from "assert";

import {
  creditEndpoint,
  creditProjection,
  fetchCreditSnapshot,
  monthToDate,
  parseCreditReport,
  retainSnapshots,
} from "../../usage/credits";
import { creditsHtml } from "../../usage/creditsHtml";
import { dashboardHtml } from "../../usage/dashboardHtml";

const now = Date.UTC(2026, 9, 16, 12),
  target = { scope: "user" as const, account: "example" };
const report = (net = 600) => ({
  timePeriod: { year: 2026, month: 10 },
  user: "example",
  usageItems: [
    {
      product: "Copilot AI Credits",
      unitType: "ai-credits",
      grossQuantity: 700,
      netQuantity: net,
    },
    {
      product: "Actions",
      unitType: "minutes",
      grossQuantity: 20,
      netQuantity: 20,
    },
  ],
});
suite("GitHub AI-credit usage and projections", () => {
  test("month to date uses UTC boundaries including leap years", () => {
    assert.strictEqual(
      monthToDate(Date.UTC(2026, 9, 1, 0, 30)),
      Date.UTC(2026, 9, 1),
    );
    const snapshot = parseCreditReport(report(), target, now, 1000);
    const projection = creditProjection(snapshot);
    assert.strictEqual(projection.usedPercent, 60);
    assert.strictEqual(projection.projectedCredits, 1200);
    assert.strictEqual(projection.projectedPercent, 120);
    assert.strictEqual(projection.over, true);
    const leap = {
      ...snapshot,
      month: "2028-02",
      capturedAt: Date.UTC(2028, 1, 15, 12),
      net: 500,
    };
    assert.strictEqual(creditProjection(leap).projectedCredits, 1000);
  });
  test("unknown allowance and first day never imply safe budget", () => {
    const snapshot = parseCreditReport(report(), target, now, 0);
    assert.strictEqual(creditProjection(snapshot).usedPercent, null);
    assert.strictEqual(creditProjection(snapshot).over, null);
    assert.strictEqual(
      creditProjection({
        ...snapshot,
        allowance: 1000,
        capturedAt: Date.UTC(2026, 9, 1, 12),
      }).projectedCredits,
      null,
    );
    assert.strictEqual(
      creditProjection({ ...snapshot, allowance: 1200 }).over,
      false,
    );
  });
  test("validates account/month/units; excludes unrelated products and never adds net to gross", () => {
    const snapshot = parseCreditReport(report(), target, now, 1000);
    assert.strictEqual(snapshot.gross, 700);
    assert.strictEqual(snapshot.net, 600);
    assert.throws(() =>
      parseCreditReport({ ...report(), user: "someone-else" }, target, now),
    );
    assert.throws(() =>
      parseCreditReport(
        { ...report(), timePeriod: { year: 2026, month: 9 } },
        target,
        now,
      ),
    );
    assert.throws(() =>
      parseCreditReport(
        {
          ...report(),
          usageItems: [
            {
              product: "Copilot",
              unitType: "requests",
              grossQuantity: 1,
              netQuantity: 1,
            },
          ],
        },
        target,
        now,
      ),
    );
    assert.throws(() =>
      creditEndpoint({ ...target, account: "../other" }, now),
    );
  });
  test("snapshots replace the same account/hour, isolate months and allow corrections", () => {
    const first = parseCreditReport(report(), target, now, 1000);
    const second = { ...first, capturedAt: now + 1000, net: 550 };
    const rows = retainSnapshots([first, { invalid: true }], second);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].net, 550);
    const next = {
      ...second,
      capturedAt: Date.UTC(2026, 10, 2),
      month: "2026-11",
      net: 20,
    };
    assert.strictEqual(retainSnapshots(rows, next).length, 2);
    assert.ok(
      !JSON.stringify(
        retainSnapshots([{ ...first, token: "never-store" }], second),
      ).includes("never-store"),
    );
  });
  test("uses official CLI endpoints without requesting or exposing tokens", async () => {
    const endpoints: string[] = [];
    const result = await fetchCreditSnapshot(
      "user",
      "",
      1000,
      now,
      async (endpoint) => {
        endpoints.push(endpoint);
        return endpoint === "user" ? { login: "example" } : report();
      },
    );
    assert.strictEqual(result.net, 600);
    assert.deepStrictEqual(endpoints, [
      "user",
      "users/example/settings/billing/ai_credit/usage?year=2026&month=10",
    ]);
    await assert.rejects(
      fetchCreditSnapshot("user", "", 1000, now, async () => {
        throw new Error("access denied");
      }),
      /access denied/,
    );
  });
  test("unavailable report and month rollover are not displayed as zero; MTD option exists", () => {
    assert.ok(
      creditsHtml(undefined, now).includes("Unavailable usage is not zero"),
    );
    const snapshot = parseCreditReport(report(), target, now, 1000);
    assert.ok(
      creditsHtml(
        { enabled: false, status: "Ready", snapshots: [snapshot] },
        now,
      ).includes("Projected above 100%"),
    );
    assert.ok(
      creditsHtml(
        { enabled: false, status: "Ready", snapshots: [snapshot] },
        Date.UTC(2026, 10, 1),
      ).includes("No account usage snapshot"),
    );
    const html = dashboardHtml("nonce", [], [], {}, {}, -1, true, false);
    assert.ok(html.includes("Month to date (UTC)"));
    assert.ok(html.includes("syncCredits"));
  });
});
