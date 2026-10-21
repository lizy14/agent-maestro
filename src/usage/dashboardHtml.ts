import {
  DashboardOptions,
  PRICE_DATE,
  analyze,
  cacheState,
  callThroughput,
  emissionRate,
  estimateCost,
  pivotRows,
} from "./analytics";
import { creditsHtml } from "./creditsHtml";
import {
  UsageFilter,
  UsageRecord,
  groupRecords,
  sessionKey,
  summarize,
} from "./model";

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

export function dashboardHtml(
  nonce: string,
  all: UsageRecord[],
  rows: UsageRecord[],
  names: Record<string, string>,
  filter: UsageFilter,
  days: number,
  enabled: boolean,
  truncated: boolean,
  display: DashboardOptions = {},
): string {
  const number = (n: number | undefined | null) =>
    n === null || n === undefined ? "—" : n.toLocaleString();
  const pct = (n: number | null) =>
    n === null ? "—" : (100 * n).toFixed(1) + "%";
  const ms = (n: number | undefined | null) =>
    n === null || n === undefined ? "—" : (n / 1000).toFixed(2) + "s";
  const label = (row: UsageRecord) =>
    row.sessionName ??
    (row.client === "Codex" ? names[row.sessionId ?? ""] : undefined) ??
    row.sessionId ??
    "Uncorrelated";
  const table = (headers: string[], body: unknown[][]) =>
    '<div class="table-wrap"><table><thead><tr>' +
    headers.map((h) => '<th scope="col">' + escapeHtml(h) + "</th>").join("") +
    "</tr></thead><tbody>" +
    body
      .map(
        (cells) =>
          "<tr>" +
          cells.map((c) => "<td>" + escapeHtml(c) + "</td>").join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>";
  const options = (items: [string, string][], selected = "") =>
    items
      .map(
        ([value, text]) =>
          '<option value="' +
          escapeHtml(value) +
          '"' +
          (value === selected ? " selected" : "") +
          ">" +
          escapeHtml(text) +
          "</option>",
      )
      .join("");
  const pricing = display.pricing ?? {};
  const pivot = display.pivot ?? "modelCache";
  const metric = display.metric ?? "tokens";
  const money = (n: number | null | undefined) =>
    n === null || n === undefined
      ? "—"
      : new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
          minimumFractionDigits: 4,
          maximumFractionDigits: 4,
        }).format(n);
  const speed = (n: number | null | undefined) =>
    n === null || n === undefined ? "—" : n.toFixed(1);
  const t = analyze(rows, pricing);
  const cards = [
    [
      "Model calls",
      number(t.calls),
      number(t.failed) + " failed · " + number(t.cancelled) + " cancelled",
    ],
    [
      "Input tokens",
      number(t.reportedCalls ? t.inputTokens : undefined),
      number(t.reportedCalls) + " calls with reported usage",
    ],
    [
      "Output tokens",
      number(t.reportedCalls ? t.outputTokens : undefined),
      "Reasoning is included in output",
    ],
    [
      "Cache hit rate",
      pct(t.cacheHitRate),
      number(t.cacheReportedCalls ? t.cachedTokens : undefined) +
        " cached · " +
        number(t.cacheReportedCalls) +
        " measured calls",
    ],
    [
      "Estimated USD",
      money(t.costUsd),
      number(t.pricedCalls) +
        "/" +
        number(t.calls) +
        " priced calls · API-equivalent",
    ],
    [
      "Cache savings estimate",
      money(t.savingsUsd),
      "Versus uncached input at selected rates",
    ],
    [
      "Observed TTFT P50",
      ms(t.ttftP50),
      "P95 " + ms(t.ttftP95) + " · " + number(t.ttftCalls) + " measured",
    ],
    [
      "Output throughput P50",
      speed(t.tpsP50) + " tok/s",
      "Output ÷ full call time · " + number(t.tpsCalls) + " measured",
    ],
    [
      "Stream emission P50",
      speed(t.emissionP50) + " tok/s",
      number(t.emissionCalls) + " eligible · not GPU decode speed",
    ],
    [
      "Mean latency",
      ms(t.averageMs),
      "P50 " + ms(t.p50Ms) + " · P95 " + ms(t.p95Ms) + " · P99 " + ms(t.p99Ms),
    ],
    [
      "Calls with cache reads",
      pct(t.requestHitRate),
      number(t.hits) +
        " hit · " +
        number(t.misses) +
        " miss · " +
        number(t.cacheUnknown) +
        " unknown",
    ],
  ]
    .map(
      ([title, value, detail]) =>
        '<div class="card"><span>' +
        title +
        "</span><strong>" +
        value +
        "</strong><small>" +
        detail +
        "</small></div>",
    )
    .join("");
  const models = groupRecords(rows, (row) => row.model).sort(
    (a, b) => b.calls - a.calls,
  );
  const sessions = groupRecords(rows, sessionKey).sort(
    (a, b) => b.calls - a.calls,
  );
  const representatives = new Map<string, UsageRecord>();
  for (const row of all) {
    if (!representatives.has(sessionKey(row))) {
      representatives.set(sessionKey(row), row);
    }
  }
  const bucket = display.bucket ?? "day";
  const localBucket = (row: UsageRecord) => {
    const d = new Date(row.startedAt);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0") +
      (bucket === "hour"
        ? " " + String(d.getHours()).padStart(2, "0") + ":00"
        : "")
    );
  };
  const grouped = new Map<string, UsageRecord[]>();
  for (const row of rows) {
    const key = localBucket(row);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key)!.push(row);
  }
  const daily = [...grouped]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, rs]) => ({ name, ...analyze(rs, pricing) }));
  const value = (point: ReturnType<typeof analyze>): number | null =>
    metric === "cost"
      ? point.costUsd
      : metric === "ttft"
        ? point.ttftP50
        : metric === "latency"
          ? point.p95Ms
          : metric === "throughput"
            ? point.tpsP50
            : metric === "cache"
              ? point.cacheHitRate === null
                ? null
                : 100 * point.cacheHitRate
              : point.reportedCalls
                ? point.inputTokens
                : null;
  const chartFormat = (n: number | null) =>
    metric === "cost"
      ? money(n)
      : metric === "ttft" || metric === "latency"
        ? ms(n)
        : metric === "throughput"
          ? speed(n) + " tok/s"
          : metric === "cache"
            ? n === null
              ? "—"
              : n.toFixed(1) + "%"
            : number(n);
  const chartTitle = {
    tokens: "Input and cache reads",
    cost: "Estimated USD",
    ttft: "Observed TTFT P50",
    latency: "Call latency P95",
    throughput: "Output throughput P50",
    cache: "Token cache hit rate",
  }[metric];
  const maximum = Math.max(0, ...daily.map((d) => value(d) ?? 0)) || 1;
  const width = 540 / Math.max(1, daily.length);
  const bars = daily
    .map((day, i) => {
      const n = value(day),
        h = (145 * (n ?? 0)) / maximum;
      const label = day.name + ": " + chartFormat(n);
      const main =
        '<rect class="input" x="' +
        (50 + i * width) +
        '" y="' +
        (155 - h) +
        '" width="' +
        Math.max(0.3, width * 0.62) +
        '" height="' +
        h +
        '"/>';
      const cache =
        metric === "tokens"
          ? '<rect class="cache" x="' +
            (50 + i * width + width * 0.64) +
            '" y="' +
            (155 - (145 * day.cachedTokens) / maximum) +
            '" width="' +
            Math.max(0.2, width * 0.3) +
            '" height="' +
            (145 * day.cachedTokens) / maximum +
            '"/>'
          : "";
      return (
        "<g><title>" + escapeHtml(label) + "</title>" + main + cache + "</g>"
      );
    })
    .join("");
  const axes =
    '<text class="axis" x="1" y="14">' +
    escapeHtml(chartFormat(maximum)) +
    '</text><text class="axis" x="28" y="156">0</text>';
  const pivots = pivotRows(rows, pivot, pricing);
  const pivotTable = table(
    [
      "Group",
      "Calls",
      "Input",
      "Cached",
      "Output",
      "Est. USD",
      "Cache hit",
      "Usage / cache coverage",
      "TTFT P50 / P95",
      "TTFT samples",
      "Latency P50 / P95",
      "Output tok/s P50",
      "Emission tok/s P50",
      "Throughput / emission samples",
    ],
    pivots.map((g) => [
      pivot === "session" ? label(representatives.get(g.name)!) : g.name,
      number(g.calls),
      number(g.reportedCalls ? g.inputTokens : undefined),
      number(g.cacheReportedCalls ? g.cachedTokens : undefined),
      number(g.reportedCalls ? g.outputTokens : undefined),
      money(g.costUsd) + " (" + g.pricedCalls + "/" + g.calls + ")",
      pct(g.cacheHitRate),
      g.reportedCalls +
        "/" +
        g.calls +
        " · " +
        g.cacheReportedCalls +
        "/" +
        g.calls,
      ms(g.ttftP50) + " / " + ms(g.ttftP95),
      number(g.ttftCalls),
      ms(g.p50Ms) + " / " + ms(g.p95Ms),
      speed(g.tpsP50),
      speed(g.emissionP50),
      g.tpsCalls + " / " + g.emissionCalls,
    ]),
  );
  const histogramBounds = [100, 250, 500, 1000, 2000, 5000, 10000, Infinity];
  const histogram = histogramBounds.map((bound, i) => ({
    label:
      i === 7 ? ">10s" : (i ? histogramBounds[i - 1] : 0) + "–" + bound + " ms",
    count: rows.filter(
      (r) =>
        r.firstTokenMs !== undefined &&
        r.firstTokenMs > (i ? histogramBounds[i - 1] : -1) &&
        r.firstTokenMs <= bound,
    ).length,
  }));
  const histMax = Math.max(1, ...histogram.map((h) => h.count));
  const histBars = histogram
    .map(
      (h, i) =>
        "<g><title>" +
        escapeHtml(h.label + ": " + h.count + " calls") +
        '</title><rect class="input" x="' +
        (i * 75 + 3) +
        '" y="' +
        (145 - (125 * h.count) / histMax) +
        '" width="55" height="' +
        (125 * h.count) / histMax +
        '"/><text class="axis" x="' +
        (i * 75 + 3) +
        '" y="165">' +
        escapeHtml(h.label) +
        '</text><text class="axis" x="' +
        (i * 75 + 3) +
        '" y="' +
        (139 - (125 * h.count) / histMax) +
        '">' +
        h.count +
        "</text></g>",
    )
    .join("");
  const timed = rows.filter(
    (r) =>
      r.firstTokenMs !== undefined &&
      r.inputTokens !== undefined &&
      r.cachedTokens !== undefined &&
      r.cachedTokens <= r.inputTokens,
  );
  const points = timed.filter(
    (_, i) => i % Math.max(1, Math.ceil(timed.length / 500)) === 0,
  );
  const maxX = Math.max(
      1,
      ...points.map((r) => r.inputTokens! - r.cachedTokens!),
    ),
    maxY = Math.max(1, ...points.map((r) => r.firstTokenMs!));
  const scatter = points
    .map(
      (r) =>
        '<circle class="' +
        (cacheState(r) === "hit" ? "cache" : "input") +
        '" cx="' +
        (50 + (530 * (r.inputTokens! - r.cachedTokens!)) / maxX) +
        '" cy="' +
        (145 - (130 * r.firstTokenMs!) / maxY) +
        '" r="3"><title>' +
        escapeHtml(
          r.model +
            " / " +
            cacheState(r) +
            " / " +
            number(r.inputTokens! - r.cachedTokens!) +
            " uncached input / " +
            ms(r.firstTokenMs),
        ) +
        "</title></circle>",
    )
    .join("");
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;nonce-' +
    nonce +
    "&#39;; script-src &#39;nonce-" +
    nonce +
    '&#39;;"><title>Agent Maestro Usage</title><style nonce="' +
    nonce +
    '">' +
    "body{margin:0;padding:28px;background:var(--vscode-editor-background,#181b23);color:var(--vscode-editor-foreground,#e6e9f0);font:14px var(--vscode-font-family,system-ui)}*{box-sizing:border-box}h1{font-size:26px;margin:6px 0}h2{font-size:17px;margin:0 0 16px}header{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.muted,small{color:var(--vscode-descriptionForeground,#a3adbd);line-height:1.6}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.13em;color:var(--vscode-textLink-foreground,#79b8ff)}.actions,.filters{display:flex;gap:10px;flex-wrap:wrap}.filters{margin:24px 0;align-items:end}label{display:flex;flex-direction:column;gap:6px}button,select,input{font:inherit;padding:8px 10px;border-radius:5px;border:1px solid var(--vscode-widget-border,#41495b);color:inherit;background:var(--vscode-dropdown-background,#252b38)}select{max-width:330px}button{cursor:pointer}button:hover{background:var(--vscode-list-hoverBackground,#343e50)}:focus-visible{outline:2px solid var(--vscode-focusBorder,#79b8ff)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card,section{border:1px solid var(--vscode-widget-border,#373f50);border-radius:8px;padding:18px;background:var(--vscode-sideBar-background,#1e2430)}.card strong{display:block;font-size:28px;font-weight:600;margin:10px 0}.card small{font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}section{margin-top:16px}.grid section{margin:0}.table-wrap{overflow:auto;max-height:420px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--vscode-widget-border,#373f50);white-space:nowrap}th{font-weight:500;color:var(--vscode-descriptionForeground,#a3adbd)}td:first-child{white-space:normal;overflow-wrap:anywhere;min-width:110px;max-width:330px}svg{width:100%;height:180px}.axis{font-size:9px;fill:var(--vscode-descriptionForeground,#a3adbd)}.input{fill:var(--vscode-charts-blue,#6aa5ff)}.cache{fill:var(--vscode-charts-green,#52c7a1)}footer{font-size:12px;margin-top:22px}.empty{padding:24px;text-align:center}@media(max-width:800px){body{padding:16px}.grid{grid-template-columns:1fr}}" +
    '</style></head><body><header><div><div class="eyebrow">Agent Maestro / Local analytics</div><h1>Usage dashboard</h1><div class="muted">Model calls routed through this extension host. No external telemetry.</div></div><div class="actions"><button id="refresh">Refresh</button><button id="nameSettings">Session name settings</button><button id="import">Choose metadata file</button><button id="forget">Forget imported names</button><button id="pricing">Configure prices</button><button id="export">Export JSON</button><button id="csv">Export CSV</button></div></header><div class="filters"><label>Period<select id="period">' +
    options(
      [
        ["1", "Last 24 hours"],
        ["7", "Last 7 days"],
        ["30", "Last 30 days"],
        ["-1", "Month to date (UTC)"],
        ["0", "Custom range"],
      ],
      String(days),
    ) +
    '</select></label><label>Model<select id="model">' +
    options(
      [
        ["", "All models"],
        ...[...new Set(all.map((row) => row.model))]
          .sort()
          .map((m) => [m, m] as [string, string]),
      ],
      filter.model,
    ) +
    '</select></label><label>Session<select id="session">' +
    options(
      [
        ["", "All sessions"],
        ...[...representatives].map(
          ([key, r]) => [key, label(r) + " · " + r.client] as [string, string],
        ),
      ],
      filter.session,
    ) +
    '</select></label><label>Client<select id="client">' +
    options(
      [
        ["", "All clients"],
        ...[...new Set(all.map((r) => r.client))]
          .sort()
          .map((c) => [c, c] as [string, string]),
      ],
      filter.client,
    ) +
    '</select></label><label>Outcome<select id="outcome">' +
    options(
      [
        ["", "All outcomes"],
        ["completed", "Completed"],
        ["failed", "Failed"],
        ["cancelled", "Cancelled"],
      ],
      filter.outcome,
    ) +
    '</select></label><label>Cache cohort<select id="cache">' +
    options(
      [
        ["", "All cache states"],
        ["hit", "Some cached input"],
        ["miss", "Zero cached input"],
        ["unknown", "Unknown cache"],
      ],
      filter.cache,
    ) +
    '</select></label><label>Input size<select id="inputSize">' +
    options(
      [
        ["", "All input sizes"],
        ["small", "<8k"],
        ["medium", "8k–32k"],
        ["large", "32k–128k"],
        ["huge", "128k+"],
        ["unknown", "Unknown input"],
      ],
      filter.inputSize,
    ) +
    '</select></label><label>From (local)<input id="from" type="datetime-local" value="' +
    escapeHtml(
      filter.since
        ? new Date(
            filter.since - new Date(filter.since).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    ) +
    '"></label><label>To (local)<input id="to" type="datetime-local" value="' +
    escapeHtml(
      filter.until
        ? new Date(
            filter.until - new Date(filter.until).getTimezoneOffset() * 60000,
          )
            .toISOString()
            .slice(0, 16)
        : "",
    ) +
    '"></label><button id="dates">Apply dates</button></div>' +
    '<p class="muted">' +
    escapeHtml(display.namesStatus ?? "") +
    "</p>" +
    '<p class="muted" role="status">' +
    (enabled ? "Collection enabled. " : "Collection disabled. ") +
    (truncated ? "Showing a capped history window. " : "") +
    number(rows.length - t.reportedCalls) +
    " calls have unavailable token counts. Updated " +
    escapeHtml(new Date().toLocaleTimeString()) +
    '.</p><div class="cards">' +
    cards +
    "</div>" +
    (rows.length
      ? ""
      : '<p class="empty">No calls in this view. Send a request through Agent Maestro or change the filters.</p>') +
    creditsHtml(display.credits) +
    '<div class="filters"><label>Trend<select id="metric">' +
    options(
      [
        ["tokens", "Input and cached tokens"],
        ["cost", "Estimated USD"],
        ["ttft", "TTFT P50"],
        ["latency", "Latency P95"],
        ["throughput", "Output tokens/sec P50"],
        ["cache", "Token cache hit %"],
      ],
      metric,
    ) +
    '</select></label><label>Time buckets<select id="bucket">' +
    options(
      [
        ["day", "Daily"],
        ["hour", "Hourly"],
      ],
      bucket,
    ) +
    '</select></label><label>Pivot by<select id="pivot">' +
    options(
      [
        ["model", "Model"],
        ["modelCache", "Model × cache"],
        ["cache", "Cache hit/miss"],
        ["inputBucket", "Input size"],
        ["session", "Session"],
        ["client", "Client"],
        ["endpoint", "Endpoint"],
      ],
      pivot,
    ) +
    "</select></label></div>" +
    "<section><h2>" +
    escapeHtml(chartTitle) +
    " (" +
    bucket +
    ', local time)</h2><svg viewBox="0 0 600 175" role="img" aria-label="Usage trend">' +
    axes +
    bars +
    '</svg><p class="muted">' +
    escapeHtml(
      daily.length
        ? daily[0].name + " → " + daily[daily.length - 1].name
        : "No data",
    ) +
    " · Blue: selected metric; green: cache reads on token chart. Only buckets with samples are drawn; hover for exact values.</p></section>" +
    "<section><h2>Performance and cost pivot</h2>" +
    pivotTable +
    "</section>" +
    '<div class="grid"><section><h2>Time to first content distribution</h2><svg viewBox="0 0 600 180" role="img" aria-label="TTFT histogram">' +
    histBars +
    '</svg><p class="muted">' +
    t.ttftCalls +
    " measured calls; " +
    (rows.length - t.ttftCalls) +
    ' unavailable.</p></section><section><h2>TTFT versus uncached input</h2><svg viewBox="0 0 600 175" role="img" aria-label="TTFT versus uncached input scatter"><text class="axis" x="1" y="14">' +
    escapeHtml(ms(maxY)) +
    "</text>" +
    scatter +
    '<text class="axis" x="50" y="169">0</text><text class="axis" x="480" y="169">' +
    escapeHtml(number(maxX)) +
    ' tokens</text></svg><p class="muted">Green: cache hit; blue: miss. ' +
    points.length +
    " displayed of " +
    timed.length +
    " eligible calls. Filter by model and input size before comparing.</p></section></div>" +
    "<section><h2>Models</h2>" +
    table(
      ["Model", "Calls", "Input", "Output", "Cache hit"],
      models.map((m) => [
        m.name,
        number(m.calls),
        number(m.reportedCalls ? m.inputTokens : undefined),
        number(m.reportedCalls ? m.outputTokens : undefined),
        pct(m.cacheHitRate),
      ]),
    ) +
    "</section>" +
    "<section><h2>Sessions</h2>" +
    table(
      [
        "Session / client",
        "Calls",
        "Input",
        "Output",
        "Cached",
        "Cache hit",
        "Mean latency",
      ],
      sessions.map((s) => {
        const r = representatives.get(s.name)!;
        return [
          label(r) + " · " + r.client,
          number(s.calls),
          number(s.reportedCalls ? s.inputTokens : undefined),
          number(s.reportedCalls ? s.outputTokens : undefined),
          number(s.cacheReportedCalls ? s.cachedTokens : undefined),
          pct(s.cacheHitRate),
          ms(s.averageMs),
        ];
      }),
    ) +
    "</section>" +
    "<section><h2>Recent model calls</h2>" +
    table(
      [
        "Time / session",
        "Model",
        "Outcome",
        "Input",
        "Output",
        "Cached",
        "Reasoning",
        "Cache writes",
        "Est. USD",
        "Output tok/s",
        "Emission tok/s",
        "First content",
        "Duration",
      ],
      rows
        .slice(0, 100)
        .map((r) => [
          new Date(r.startedAt).toLocaleString() + " / " + label(r),
          r.model,
          r.outcome,
          number(r.inputTokens),
          number(r.outputTokens),
          number(r.cachedTokens),
          number(r.reasoningTokens),
          number(r.cacheWriteTokens),
          money(estimateCost(r, pricing)?.totalUsd),
          speed(callThroughput(r)),
          speed(emissionRate(r)),
          ms(r.firstTokenMs),
          ms(r.durationMs),
        ]),
    ) +
    "</section>" +
    '<footer class="muted">Provider-reported tokens only; missing counts are —. Reasoning is included in output. Cache hit is cached input ÷ input on calls with reported cache counts. USD uses GitHub Copilot official documented rates or configured overrides, not an invoice; priced coverage excludes unknown models/cache usage. Configure per-model USD-per-million overrides or aliases for BYOK. Official GitHub rate snapshot: ' +
    PRICE_DATE +
    '. TTFT includes queue/network/hidden reasoning and is not prefill time. Emission is output tokens divided by first-to-last content time only for completed multi-chunk calls with reported zero reasoning; it is not GPU decode speed. Percentiles pool calls, not per-session averages. Retention: 31 days / approximately 100 MiB; newest 50,000 records. Only traffic passing through Maestro is observed.</footer><script nonce="' +
    nonce +
    '">' +
    'const vscode=acquireVsCodeApi();const value=id=>document.getElementById(id).value;const filters=()=>({days:Number(value("period")),model:value("model"),session:value("session"),client:value("client"),outcome:value("outcome"),cache:value("cache"),inputSize:value("inputSize"),metric:value("metric"),bucket:value("bucket"),pivot:value("pivot"),since:value("from")?new Date(value("from")).getTime():undefined,until:value("to")?new Date(value("to")).getTime():undefined});for(const id of ["period","model","session","client","outcome","cache","inputSize","metric","bucket","pivot"]){document.getElementById(id).addEventListener("change",()=>vscode.postMessage({type:"filter",...filters()}));}document.getElementById("dates").addEventListener("click",()=>vscode.postMessage({type:"filter",...filters(),days:0}));for(const [id,type] of [["syncCredits","syncCredits"],["creditSettings","creditSettings"],["clearCredits","clearCredits"],["refresh","refresh"],["nameSettings","nameSettings"],["import","importNames"],["forget","forgetNames"],["pricing","pricing"],["export","export"],["csv","csv"]]){document.getElementById(id).addEventListener("click",()=>vscode.postMessage({type,...filters()}));}' +
    "</script></body></html>"
  );
}
