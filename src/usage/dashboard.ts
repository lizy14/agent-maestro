import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import {
  DashboardOptions,
  ModelPrice,
  analyze,
  enrichedRecords,
  exportCsv,
} from "./analytics";
import {
  CreditView,
  fetchCreditSnapshot,
  monthToDate,
  retainSnapshots,
  validSnapshot,
} from "./credits";
import { dashboardHtml } from "./dashboardHtml";
import { UsageFilter, filterRecords, parseSessionNames } from "./model";
import { CodexSessionNames, codexSessionIndex } from "./sessionNames";
import { UsageStore } from "./store";

export function registerUsageDashboard(
  context: vscode.ExtensionContext,
  store: UsageStore,
): void {
  let panel: vscode.WebviewPanel | undefined;
  let days = 30;
  let filter: UsageFilter = {};
  let generation = 0;
  let display: DashboardOptions = {};
  const sessionNames = new CodexSessionNames();
  let lastAutomaticNames = "";
  let lastCreditAttempt = 0;
  let creditBusy = false;
  let creditStatus =
    "Sync uses the official GitHub API through your existing CLI login. Monthly allowance must be configured; the API does not expose quota.";
  const creditView = (): CreditView => {
    const config = vscode.workspace.getConfiguration("agent-maestro");
    const scope = config.get<"user" | "organization">(
      "usage.githubCredits.scope",
      "user",
    );
    const org = config
      .get<string>("usage.githubCredits.organization", "")
      .toLowerCase();
    const all = context.globalState
      .get<unknown[]>("usage.creditSnapshots", [])
      .filter(validSnapshot);
    const lastAccount = context.globalState.get<string>(
      "usage.creditAccount",
      "",
    );
    return {
      enabled: config.get("usage.githubCredits.enabled", false),
      status: creditStatus,
      snapshots: all.filter(
        (row) =>
          row.scope === scope &&
          row.account === (scope === "organization" ? org : lastAccount),
      ),
    };
  };
  const syncCredits = async () => {
    if (creditBusy) {
      return;
    }
    creditBusy = true;
    lastCreditAttempt = Date.now();
    try {
      const config = vscode.workspace.getConfiguration("agent-maestro");
      const snapshot = await fetchCreditSnapshot(
        config.get("usage.githubCredits.scope", "user"),
        config.get("usage.githubCredits.organization", ""),
        config.get("usage.githubCredits.monthlyAllowance", 0),
      );
      await context.globalState.update(
        "usage.creditSnapshots",
        retainSnapshots(
          context.globalState.get<unknown[]>("usage.creditSnapshots", []),
          snapshot,
        ),
      );
      if (snapshot.scope === "user") {
        await context.globalState.update(
          "usage.creditAccount",
          snapshot.account,
        );
      }
      creditStatus =
        "Official GitHub billing usage synchronized. Allowance is user-configured, not discovered from GitHub.";
    } catch (error) {
      creditStatus =
        error instanceof Error ? error.message : "GitHub usage unavailable.";
    } finally {
      creditBusy = false;
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("agent-maestro.usage")) {
        lastCreditAttempt = 0;
        void refresh();
      }
    }),
  );
  const automaticNames = async () => {
    const config = vscode.workspace.getConfiguration("agent-maestro");
    if (!config.get("usage.autoSessionNames", true)) {
      sessionNames.clear();
      return { names: {}, status: "Automatic Codex session names disabled." };
    }
    try {
      const result = await sessionNames.read(
        codexSessionIndex(config.get<string>("usage.codexHome", "")),
      );
      const status =
        result.status === "loaded"
          ? Object.keys(result.names).length +
            " Codex session names found automatically."
          : result.status === "missing"
            ? "Codex session metadata not found on this extension host. Set Codex Home in session name settings for a different location."
            : "Codex session metadata is unavailable or exceeds 5 MiB. Check session name settings.";
      return { names: result.names, status };
    } catch {
      return {
        names: {},
        status:
          "Codex Home must be an absolute directory. Check session name settings.",
      };
    }
  };
  const pricing = () => ({
    overrides: vscode.workspace
      .getConfiguration("agent-maestro")
      .get<Record<string, ModelPrice>>("usage.priceOverrides", {}),
    aliases: vscode.workspace
      .getConfiguration("agent-maestro")
      .get<Record<string, string>>("usage.priceAliases", {}),
  });
  const refresh = async () => {
    const revision = ++generation;
    const current = panel;
    if (!current) {
      return;
    }
    try {
      const snapshot = await store.read();
      const automatic = await automaticNames();
      if (current !== panel || revision !== generation) {
        return;
      }
      const imported = context.globalState.get<Record<string, string>>(
        "usage.sessionNames",
        {},
      );
      const names = { ...automatic.names, ...imported };
      lastAutomaticNames = JSON.stringify(automatic);
      if (days) {
        filter.since =
          days === -1 ? monthToDate() : Date.now() - days * 86400000;
        filter.until = undefined;
      }
      current.webview.html = dashboardHtml(
        randomBytes(24).toString("hex"),
        snapshot.records,
        filterRecords(snapshot.records, filter),
        names,
        filter,
        days,
        vscode.workspace
          .getConfiguration("agent-maestro")
          .get("usage.enabled", true),
        snapshot.truncated,
        {
          ...display,
          pricing: pricing(),
          namesStatus: automatic.status,
          credits: creditView(),
        },
      );
    } catch {
      vscode.window.showErrorMessage(
        "Unable to read local usage history. Check storage permissions.",
      );
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("agent-maestro.openUsageDashboard", () => {
      if (panel) {
        panel.reveal();
        void refresh();
        return;
      }
      panel = vscode.window.createWebviewPanel(
        "agentMaestroUsage",
        "Agent Maestro Usage",
        vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [] },
      );
      const messages = panel.webview.onDidReceiveMessage(
        async (message: unknown) => {
          if (!message || typeof message !== "object") {
            return;
          }
          const data = message as {
            type?: string;
            days?: number;
            model?: string;
            session?: string;
            client?: string;
            outcome?: string;
            cache?: string;
            inputSize?: string;
            since?: number;
            until?: number;
            pivot?: DashboardOptions["pivot"];
            metric?: DashboardOptions["metric"];
            bucket?: DashboardOptions["bucket"];
          };
          if (
            ![-1, 0, 1, 7, 30].includes(data.days ?? -2) ||
            typeof data.model !== "string" ||
            data.model.length > 160 ||
            typeof data.session !== "string" ||
            data.session.length > 500
          ) {
            return;
          }
          if (
            !["", "Codex", "Claude", "Copilot", "Gemini", "Other"].includes(
              data.client ?? "",
            ) ||
            !["", "completed", "failed", "cancelled"].includes(
              data.outcome ?? "",
            ) ||
            !["", "hit", "miss", "unknown"].includes(data.cache ?? "") ||
            !["", "small", "medium", "large", "huge", "unknown"].includes(
              data.inputSize ?? "",
            ) ||
            ![
              "model",
              "session",
              "client",
              "endpoint",
              "cache",
              "modelCache",
              "inputBucket",
            ].includes(data.pivot ?? "modelCache") ||
            ![
              "tokens",
              "cost",
              "ttft",
              "latency",
              "throughput",
              "cache",
            ].includes(data.metric ?? "tokens") ||
            !["day", "hour"].includes(data.bucket ?? "day")
          ) {
            return;
          }
          if (
            data.days === 0 &&
            (typeof data.since !== "number" ||
              !Number.isFinite(data.since) ||
              data.since < 0 ||
              data.since > 8640000000000000 ||
              (data.until !== undefined &&
                (!Number.isFinite(data.until) ||
                  data.until < data.since ||
                  data.until > 8640000000000000)))
          ) {
            return;
          }
          days = data.days!;
          filter = {
            model: data.model,
            session: data.session,
            client: data.client,
            outcome: data.outcome,
            cache: data.cache,
            inputSize: data.inputSize,
            since:
              days === -1
                ? monthToDate()
                : days
                  ? Date.now() - days * 86400000
                  : data.since,
            until: days ? undefined : data.until,
          };
          display = {
            pivot: data.pivot,
            metric: data.metric,
            bucket: data.bucket,
          };
          try {
            if (data.type === "syncCredits") {
              await syncCredits();
              await refresh();
            }
            if (data.type === "creditSettings") {
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "agent-maestro.usage.githubCredits",
              );
            }
            if (data.type === "clearCredits") {
              const answer = await vscode.window.showWarningMessage(
                "Clear locally saved AI-credit usage snapshots?",
                { modal: true },
                "Clear",
              );
              if (answer === "Clear") {
                await context.globalState.update(
                  "usage.creditSnapshots",
                  undefined,
                );
                creditStatus = "Local credit history cleared.";
                await refresh();
              }
            }
            if (data.type === "refresh" || data.type === "filter") {
              await refresh();
            }
            if (data.type === "importNames") {
              const selected = await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { "Codex session metadata": ["jsonl"] },
                title:
                  "Select session_index.jsonl (imports IDs and titles only)",
              });
              if (!selected?.[0]) {
                return;
              }
              const stat = await vscode.workspace.fs.stat(selected[0]);
              if (stat.size > 5 * 1024 * 1024) {
                throw new Error("File exceeds 5 MiB");
              }
              const content = await vscode.workspace.fs.readFile(selected[0]);
              if (content.byteLength > 5 * 1024 * 1024) {
                throw new Error("File exceeds 5 MiB");
              }
              await context.globalState.update(
                "usage.sessionNames",
                parseSessionNames(Buffer.from(content).toString("utf8")),
              );
              await refresh();
            }
            if (data.type === "forgetNames") {
              await context.globalState.update("usage.sessionNames", undefined);
              await refresh();
            }
            if (data.type === "pricing") {
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "agent-maestro.usage.price",
              );
            }
            if (data.type === "nameSettings") {
              await vscode.commands.executeCommand(
                "workbench.action.openSettings",
                "@ext:Joouis.agent-maestro usage",
              );
            }
            if (data.type === "export" || data.type === "csv") {
              const selectedFilter = { ...filter };
              const selectedPricing = pricing();
              const destination = await vscode.window.showSaveDialog({
                filters:
                  data.type === "csv" ? { CSV: ["csv"] } : { JSON: ["json"] },
                saveLabel: "Export usage metrics",
              });
              if (!destination) {
                return;
              }
              const snapshot = await store.read();
              await vscode.workspace.fs.writeFile(
                destination,
                Buffer.from(
                  data.type === "csv"
                    ? exportCsv(
                        filterRecords(snapshot.records, selectedFilter),
                        selectedPricing,
                      )
                    : JSON.stringify(
                        {
                          version: 1,
                          exportedAt: new Date().toISOString(),
                          truncated: snapshot.truncated,
                          summary: analyze(
                            filterRecords(snapshot.records, selectedFilter),
                            selectedPricing,
                          ),
                          pricing:
                            "Current configured/catalog standard text API-equivalent estimate, not actual billing",
                          records: enrichedRecords(
                            filterRecords(snapshot.records, selectedFilter),
                            selectedPricing,
                          ),
                        },
                        null,
                        2,
                      ),
                ),
              );
              vscode.window.showInformationMessage("Usage metrics exported.");
            }
          } catch {
            vscode.window.showErrorMessage(
              "Unable to complete the dashboard action. Check the selected file and storage permissions.",
            );
          }
        },
      );
      let checking = false;
      const timer = setInterval(async () => {
        if (!panel?.visible || checking) {
          return;
        }
        checking = true;
        try {
          if (
            creditView().enabled &&
            Date.now() - lastCreditAttempt >= 30 * 60000
          ) {
            await syncCredits();
            await refresh();
          }
          if (JSON.stringify(await automaticNames()) !== lastAutomaticNames) {
            await refresh();
          }
        } finally {
          checking = false;
        }
      }, 30000);
      const visibility = panel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible) {
          void refresh();
        }
      });
      panel.onDidDispose(() => {
        clearInterval(timer);
        visibility.dispose();
        sessionNames.clear();
        lastAutomaticNames = "";
        messages.dispose();
        panel = undefined;
        generation++;
      });
      void refresh();
    }),
  );
  context.subscriptions.push({ dispose: () => panel?.dispose() });
}
