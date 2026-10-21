import { CreditView, creditProjection, utcMonth } from "./credits";

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function creditsHtml(
  view: CreditView | undefined,
  now = Date.now(),
): string {
  const current = utcMonth(now),
    rows = (view?.snapshots ?? [])
      .filter((row) => row.month === current.key)
      .sort((a, b) => a.capturedAt - b.capturedAt);
  const latest = rows.at(-1),
    number = (n: number | null | undefined) =>
      n === null || n === undefined
        ? "—"
        : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
  const intro =
    '<section><h2>GitHub Copilot AI credits — month to date (UTC)</h2><div class="actions"><button id="syncCredits">Sync GitHub credits</button><button id="creditSettings">Credit settings</button><button id="clearCredits">Clear credit history</button></div><p class="muted">' +
    escape(
      view?.status ??
        "Not connected. Sync uses your existing GitHub CLI login; it never changes login scopes or reads credential files.",
    ) +
    "</p>";
  if (!latest) {
    return (
      intro +
      '<p>No account usage snapshot for this UTC month. Unavailable usage is not zero.</p><p class="muted">The official API exposes usage, not your remaining allowance. Set monthly AI-credit allowance in Credit settings for a percentage/projection; organization billing requires administrator access.</p></section>'
    );
  }
  const projection = creditProjection(latest),
    stale = now - latest.capturedAt > 2 * 3600000;
  const verdict =
    projection.over === null
      ? "Projection unavailable"
      : projection.over
        ? "Projected above 100%"
        : "Projected at or below 100%";
  const cards = [
    [
      "Net AI-credit usage",
      number(latest.net),
      number(latest.gross) + " gross before discounts",
    ],
    [
      "Configured monthly allowance",
      number(latest.allowance),
      "User-supplied; not an API-discovered quota",
    ],
    [
      "Used",
      number(projection.usedPercent) +
        (projection.usedPercent === null ? "" : "%"),
      "Measured as of snapshot",
    ],
    [
      "Projected month end",
      number(projection.projectedPercent) +
        (projection.projectedPercent === null ? "" : "%"),
      number(projection.projectedCredits) + " credits · " + verdict,
    ],
  ]
    .map(
      ([title, value, detail]) =>
        '<div class="card"><span>' +
        escape(title) +
        "</span><strong>" +
        escape(value) +
        "</strong><small>" +
        escape(detail) +
        "</small></div>",
    )
    .join("");
  const max = Math.max(
    1,
    latest.allowance ?? 0,
    projection.projectedCredits ?? 0,
    ...rows.map((r) => r.net),
  );
  const x = (time: number) =>
      40 + (540 * (time - current.start)) / (current.end - current.start),
    y = (credits: number) => 160 - (140 * credits) / max;
  const points = rows.map((r) => x(r.capturedAt) + "," + y(r.net)).join(" ");
  const actual =
    '<polyline fill="none" stroke="var(--vscode-charts-blue,#6aa5ff)" stroke-width="2" points="' +
    points +
    '"/>' +
    rows
      .map(
        (r) =>
          '<circle class="input" cx="' +
          x(r.capturedAt) +
          '" cy="' +
          y(r.net) +
          '" r="3"><title>' +
          escape(
            new Date(r.capturedAt).toISOString() +
              ": " +
              number(r.net) +
              " credits",
          ) +
          "</title></circle>",
      )
      .join("");
  const forecast =
    projection.projectedCredits !== null
      ? '<line stroke="var(--vscode-charts-green,#52c7a1)" stroke-dasharray="5 4" x1="' +
        x(latest.capturedAt) +
        '" y1="' +
        y(latest.net) +
        '" x2="580" y2="' +
        y(projection.projectedCredits) +
        '"/>'
      : "";
  const limit = latest.allowance
    ? '<line stroke="var(--vscode-charts-orange,#e9a04f)" x1="40" x2="580" y1="' +
      y(latest.allowance) +
      '" y2="' +
      y(latest.allowance) +
      '"/><text class="axis" x="45" y="' +
      Math.max(10, y(latest.allowance) - 5) +
      '">100% configured allowance</text>'
    : "";
  return (
    intro +
    "<p>" +
    escape(latest.scope + ": " + latest.account) +
    " · " +
    escape(new Date(latest.capturedAt).toISOString()) +
    (stale ? " · STALE SNAPSHOT" : "") +
    '</p><div class="cards">' +
    cards +
    '</div><svg viewBox="0 0 600 185" role="img" aria-label="AI-credit usage snapshots and month-end projection">' +
    actual +
    forecast +
    limit +
    '<text class="axis" x="40" y="180">' +
    current.key +
    '-01</text><text class="axis" x="490" y="180">Month end UTC</text></svg><p class="muted">Blue: persisted cumulative usage samples (not summed). Dashed green: linear month-to-date run-rate projection; orange: configured allowance. Projection starts after 24 hours and assumes unchanged pace; it is not a forecast of your invoice. API reporting can lag and includes account-wide Copilot usage billed at the selected scope, not just Maestro. Quota changes, discounts and irregular usage affect comparisons. ' +
    (view?.enabled
      ? "Refreshes at most every 30 minutes while visible."
      : "Automatic polling disabled.") +
    "</p></section>"
  );
}
