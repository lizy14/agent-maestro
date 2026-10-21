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
  const t = summarize(rows);
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
    ["Mean latency", ms(t.averageMs), "P95 " + ms(t.p95Ms)],
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
  const localDay = (row: UsageRecord) => {
    const d = new Date(row.startedAt);
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  };
  const daily = groupRecords(rows, localDay).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const max = Math.max(1, ...daily.map((day) => day.inputTokens));
  const width = 600 / Math.max(1, daily.length);
  const bars = daily
    .map((day, i) => {
      const h = (150 * day.inputTokens) / max,
        cached = (150 * day.cachedTokens) / max;
      return (
        "<g><title>" +
        escapeHtml(
          day.name +
            ": " +
            number(day.inputTokens) +
            " input; " +
            number(day.cachedTokens) +
            " cached",
        ) +
        '</title><rect class="input" x="' +
        (i * width + 2) +
        '" y="' +
        (160 - h) +
        '" width="' +
        Math.max(1, width * 0.55) +
        '" height="' +
        h +
        '"/><rect class="cache" x="' +
        (i * width + width * 0.6) +
        '" y="' +
        (160 - cached) +
        '" width="' +
        Math.max(1, width * 0.3) +
        '" height="' +
        cached +
        '"/></g>'
      );
    })
    .join("");
  return (
    '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;nonce-' +
    nonce +
    "&#39;; script-src &#39;nonce-" +
    nonce +
    '&#39;;"><title>Agent Maestro Usage</title><style nonce="' +
    nonce +
    '">' +
    "body{margin:0;padding:28px;background:var(--vscode-editor-background,#181b23);color:var(--vscode-editor-foreground,#e6e9f0);font:14px var(--vscode-font-family,system-ui)}*{box-sizing:border-box}h1{font-size:26px;margin:6px 0}h2{font-size:17px;margin:0 0 16px}header{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}.muted,small{color:var(--vscode-descriptionForeground,#a3adbd);line-height:1.6}.eyebrow{font-size:11px;text-transform:uppercase;letter-spacing:.13em;color:var(--vscode-textLink-foreground,#79b8ff)}.actions,.filters{display:flex;gap:10px;flex-wrap:wrap}.filters{margin:24px 0;align-items:end}label{display:flex;flex-direction:column;gap:6px}button,select{font:inherit;padding:8px 10px;border-radius:5px;border:1px solid var(--vscode-widget-border,#41495b);color:inherit;background:var(--vscode-dropdown-background,#252b38)}select{max-width:330px}button{cursor:pointer}button:hover{background:var(--vscode-list-hoverBackground,#343e50)}:focus-visible{outline:2px solid var(--vscode-focusBorder,#79b8ff)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}.card,section{border:1px solid var(--vscode-widget-border,#373f50);border-radius:8px;padding:18px;background:var(--vscode-sideBar-background,#1e2430)}.card strong{display:block;font-size:28px;font-weight:600;margin:10px 0}.card small{font-size:12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:20px 0}section{margin-top:16px}.grid section{margin:0}.table-wrap{overflow:auto;max-height:420px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;padding:10px;border-bottom:1px solid var(--vscode-widget-border,#373f50);white-space:nowrap}th{font-weight:500;color:var(--vscode-descriptionForeground,#a3adbd)}td:first-child{white-space:normal;overflow-wrap:anywhere;min-width:110px;max-width:330px}svg{width:100%;height:180px}.input{fill:var(--vscode-charts-blue,#6aa5ff)}.cache{fill:var(--vscode-charts-green,#52c7a1)}footer{font-size:12px;margin-top:22px}.empty{padding:24px;text-align:center}@media(max-width:800px){body{padding:16px}.grid{grid-template-columns:1fr}}" +
    '</style></head><body><header><div><div class="eyebrow">Agent Maestro / Local analytics</div><h1>Usage dashboard</h1><div class="muted">Model calls routed through this extension host. No external telemetry.</div></div><div class="actions"><button id="refresh">Refresh</button><button id="import">Import Codex session names</button><button id="forget">Forget imported names</button><button id="export">Export JSON</button></div></header><div class="filters"><label>Period<select id="period">' +
    options(
      [
        ["1", "Last 24 hours"],
        ["7", "Last 7 days"],
        ["30", "Last 30 days"],
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
    "</select></label></div>" +
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
    '<div class="grid"><section><h2>Daily input tokens (local time)</h2><p class="muted">Blue: all input · Green: reported cache reads</p><svg viewBox="0 0 600 170" role="img" aria-label="Daily input and cached token chart">' +
    bars +
    '</svg><div class="muted">' +
    escapeHtml(
      daily.length
        ? daily[0].name + " → " + daily[daily.length - 1].name
        : "No daily data",
    ) +
    "</div></section><section><h2>Models</h2>" +
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
    "</section></div>" +
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
        "First token",
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
          ms(r.firstTokenMs),
          ms(r.durationMs),
        ]),
    ) +
    "</section>" +
    '<footer class="muted">Provider-reported tokens only; missing counts are —. Reasoning is included in output. Cache hit is cached input ÷ input on calls with reported cache counts. No cost estimates. Retention: 30 days / approximately 100 MiB; newest 50,000 records. Only traffic passing through Maestro is observed.</footer><script nonce="' +
    nonce +
    '">' +
    'const vscode=acquireVsCodeApi();const filters=()=>({days:Number(document.getElementById("period").value),model:document.getElementById("model").value,session:document.getElementById("session").value});for(const id of ["period","model","session"]){document.getElementById(id).addEventListener("change",()=>vscode.postMessage({type:"filter",...filters()}));}for(const [id,type] of [["refresh","refresh"],["import","importNames"],["forget","forgetNames"],["export","export"]]){document.getElementById(id).addEventListener("click",()=>vscode.postMessage({type,...filters()}));}' +
    "</script></body></html>"
  );
}
