import { execFile } from "node:child_process";

export interface CreditTarget {
  scope: "user" | "organization";
  account: string;
}
export interface CreditSnapshot extends CreditTarget {
  capturedAt: number;
  month: string;
  gross: number;
  net: number;
  allowance?: number;
}
export interface CreditView {
  status: string;
  snapshots: CreditSnapshot[];
  enabled: boolean;
}
export function utcMonth(now: number): {
  key: string;
  start: number;
  end: number;
  year: number;
  month: number;
} {
  const date = new Date(now),
    year = date.getUTCFullYear(),
    month = date.getUTCMonth() + 1;
  return {
    key: year + "-" + String(month).padStart(2, "0"),
    year,
    month,
    start: Date.UTC(year, month - 1, 1),
    end: Date.UTC(year, month, 1),
  };
}
export function monthToDate(now = Date.now()): number {
  return utcMonth(now).start;
}
const number = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const accountName = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-z\d](?:[a-z\d-]{0,98}[a-z\d])?$/i.test(value);

export function creditEndpoint(target: CreditTarget, now: number): string {
  if (
    !accountName(target.account) ||
    !["user", "organization"].includes(target.scope)
  ) {
    throw new Error("Invalid GitHub billing target");
  }
  const date = utcMonth(now);
  return (
    (target.scope === "user" ? "users/" : "organizations/") +
    target.account +
    "/settings/billing/ai_credit/usage?year=" +
    date.year +
    "&month=" +
    date.month
  );
}

export function parseCreditReport(
  data: unknown,
  target: CreditTarget,
  now: number,
  allowance?: number,
): CreditSnapshot {
  if (!data || typeof data !== "object") {
    throw new Error("Invalid billing report");
  }
  const report = data as Record<string, unknown>;
  const period = report.timePeriod as
    | { year?: unknown; month?: unknown }
    | undefined;
  const date = utcMonth(now);
  const owner = target.scope === "user" ? report.user : report.organization;
  if (
    typeof owner !== "string" ||
    owner.toLowerCase() !== target.account.toLowerCase() ||
    period?.year !== date.year ||
    period?.month !== date.month ||
    !Array.isArray(report.usageItems)
  ) {
    throw new Error("Billing report does not match requested account/month");
  }
  let gross = 0,
    net = 0;
  for (const raw of report.usageItems) {
    if (!raw || typeof raw !== "object") {
      throw new Error("Invalid billing item");
    }
    const item = raw as Record<string, unknown>;
    if (
      typeof item.product !== "string" ||
      !/^copilot(?: ai credits)?$/i.test(item.product)
    ) {
      continue;
    }
    if (
      !["ai-credits", "credits"].includes(String(item.unitType)) ||
      !number(item.grossQuantity) ||
      !number(item.netQuantity)
    ) {
      throw new Error("Unexpected Copilot billing units");
    }
    gross += item.grossQuantity;
    net += item.netQuantity;
  }
  if (!number(gross) || !number(net)) {
    throw new Error("Invalid credit totals");
  }
  return {
    ...target,
    account: target.account.toLowerCase(),
    capturedAt: now,
    month: date.key,
    gross,
    net,
    allowance: number(allowance) && allowance > 0 ? allowance : undefined,
  };
}

export function validSnapshot(value: unknown): value is CreditSnapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as CreditSnapshot;
  return (
    ["user", "organization"].includes(row.scope) &&
    accountName(row.account) &&
    number(row.capturedAt) &&
    row.capturedAt < 8640000000000000 &&
    row.month === utcMonth(row.capturedAt).key &&
    number(row.net) &&
    number(row.gross) &&
    (row.allowance === undefined || number(row.allowance))
  );
}
export function retainSnapshots(
  existing: unknown[],
  next: CreditSnapshot,
): CreditSnapshot[] {
  const date = new Date(next.capturedAt),
    cutoff = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 23, 1);
  // Keep a cumulative sample per hour/account; never add successive totals.
  const key = (row: CreditSnapshot) =>
    [
      row.scope,
      row.account.toLowerCase(),
      row.month,
      Math.floor(row.capturedAt / 3600000),
    ].join(":");
  const rows = new Map<string, CreditSnapshot>();
  for (const row of [...existing, next]) {
    if (validSnapshot(row) && row.capturedAt >= cutoff) {
      rows.set(key(row), {
        scope: row.scope,
        account: row.account.toLowerCase(),
        month: row.month,
        capturedAt: row.capturedAt,
        gross: row.gross,
        net: row.net,
        allowance: row.allowance,
      });
    }
  }
  return [...rows.values()]
    .sort((a, b) => a.capturedAt - b.capturedAt)
    .slice(-2000);
}
export function creditProjection(snapshot: CreditSnapshot) {
  const month = utcMonth(snapshot.capturedAt),
    elapsed = snapshot.capturedAt - month.start;
  const projected =
    elapsed >= 86400000
      ? (snapshot.net * (month.end - month.start)) / elapsed
      : null;
  const limit =
    snapshot.allowance && snapshot.allowance > 0
      ? snapshot.allowance
      : undefined;
  return {
    usedPercent: limit ? (snapshot.net / limit) * 100 : null,
    projectedCredits: projected,
    projectedPercent:
      limit && projected !== null ? (projected / limit) * 100 : null,
    over: limit && projected !== null ? projected > limit : null,
    monthEnd: month.end,
  };
}

export type GitHubJson = (endpoint: string) => Promise<unknown>;
export function githubJson(endpoint: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      [
        "api",
        "--hostname",
        "github.com",
        endpoint,
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        "X-GitHub-Api-Version: 2026-03-10",
      ],
      { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const message =
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "GitHub CLI is not installed on this extension host."
              : /HTTP (401|403|404)|scope|authentication/i.test(stderr)
                ? "GitHub billing access is unavailable. Personal reports require a personally billed plan and billing permission (Plan read or CLI user scope); organization reports require administrator access. Existing login was not changed."
                : "GitHub billing request failed or timed out. Try again later.";
          reject(new Error(message));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid JSON from GitHub billing API"));
        }
      },
    );
  });
}
export async function fetchCreditSnapshot(
  scope: "user" | "organization",
  organization: string,
  allowance: number,
  now = Date.now(),
  request: GitHubJson = githubJson,
): Promise<CreditSnapshot> {
  let account = organization;
  if (scope === "user") {
    const identity = await request("user");
    account =
      identity && typeof identity === "object"
        ? (identity as { login: string }).login
        : "";
  }
  const target = { scope, account };
  const report = await request(creditEndpoint(target, now));
  return parseCreditReport(report, target, now, allowance);
}
