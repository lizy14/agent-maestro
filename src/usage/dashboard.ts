import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

import { dashboardHtml } from "./dashboardHtml";
import { UsageFilter, filterRecords, parseSessionNames } from "./model";
import { UsageStore } from "./store";

export function registerUsageDashboard(
  context: vscode.ExtensionContext,
  store: UsageStore,
): void {
  let panel: vscode.WebviewPanel | undefined;
  let days = 30;
  let filter: UsageFilter = {};
  let generation = 0;
  const refresh = async () => {
    const revision = ++generation;
    const current = panel;
    if (!current) {
      return;
    }
    try {
      const snapshot = await store.read();
      if (current !== panel || revision !== generation) {
        return;
      }
      const names = context.globalState.get<Record<string, string>>(
        "usage.sessionNames",
        {},
      );
      filter.since = Date.now() - days * 86400000;
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
          };
          if (
            ![1, 7, 30].includes(data.days ?? 0) ||
            typeof data.model !== "string" ||
            data.model.length > 160 ||
            typeof data.session !== "string" ||
            data.session.length > 500
          ) {
            return;
          }
          days = data.days!;
          filter = {
            model: data.model,
            session: data.session,
            since: Date.now() - days * 86400000,
          };
          try {
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
            if (data.type === "export") {
              const destination = await vscode.window.showSaveDialog({
                filters: { JSON: ["json"] },
                saveLabel: "Export usage metrics",
              });
              if (!destination) {
                return;
              }
              const snapshot = await store.read();
              await vscode.workspace.fs.writeFile(
                destination,
                Buffer.from(
                  JSON.stringify(
                    {
                      version: 1,
                      exportedAt: new Date().toISOString(),
                      truncated: snapshot.truncated,
                      records: filterRecords(snapshot.records, filter),
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
      panel.onDidDispose(() => {
        messages.dispose();
        panel = undefined;
        generation++;
      });
      void refresh();
    }),
  );
  context.subscriptions.push({ dispose: () => panel?.dispose() });
}
