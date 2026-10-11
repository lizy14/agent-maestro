import * as fs from "fs";
import * as vscode from "vscode";

import { chatModelsCache } from "./chatModels";
import { logger } from "./logger";
import {
  CatalogTarget,
  appendCatalogModels,
  findCatalogTargets,
  hasPopulatedCatalog,
  writeCatalogUpdate,
} from "./modelCatalogs";
import { modelNotificationLabel, modelRouteId } from "./modelIdentity";

export const MODEL_SNAPSHOT_KEY = "agent-maestro.observedLanguageModels";
export function modelIdentity(
  model: Pick<vscode.LanguageModelChat, "vendor" | "id">,
): string {
  return JSON.stringify([model.vendor, model.id]);
}

export function registerModelCatalogWatcher(
  context: vscode.ExtensionContext,
): vscode.Disposable {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let pending = false;
  const check = async () => {
    if (disposed) {
      return;
    }
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      const all = await vscode.lm.selectChatModels();
      if (disposed) {
        return;
      }
      if (!all.length) {
        await chatModelsCache.refresh(all);
        return;
      }
      const previous = context.globalState.get<string[]>(MODEL_SNAPSHOT_KEY);
      const current = all.map(modelIdentity);
      // Keep seen identities through transient removals/sign-out to avoid repeat prompts.
      const seen = new Set(previous ?? []);
      const additions = [
        ...new Map(
          all
            .filter((model) => !seen.has(modelIdentity(model)))
            .map((model) => [modelIdentity(model), model]),
        ).values(),
      ];
      await chatModelsCache.refresh(all);
      await context.globalState.update(MODEL_SNAPSHOT_KEY, [
        ...new Set([...seen, ...current]),
      ]);
      if (disposed || !previous || !additions.length) {
        return;
      }
      const supported = await chatModelsCache.getChatModels();
      const additionsById = new Set(
        additions
          .filter((model) =>
            supported.some(
              (candidate) => modelIdentity(candidate) === modelIdentity(model),
            ),
          )
          .map(modelRouteId),
      );
      const snapshots: {
        target: CatalogTarget;
        original: string;
        updated: string;
        models: vscode.LanguageModelChat[];
      }[] = [];
      const manual: CatalogTarget[] = [];
      for (const target of findCatalogTargets(context)) {
        try {
          const original = fs.readFileSync(target.path, "utf8");
          if (!hasPopulatedCatalog(target, original)) {
            continue;
          }
          try {
            const updated = appendCatalogModels(
              target,
              original,
              supported.filter((model) =>
                additionsById.has(modelRouteId(model)),
              ),
            );
            if (updated !== original) {
              const missing = supported.filter(
                (model) =>
                  additionsById.has(modelRouteId(model)) &&
                  appendCatalogModels(target, original, [model]) !== original,
              );
              snapshots.push({ target, original, updated, models: missing });
            }
          } catch {
            if (additionsById.size) {
              manual.push(target);
            }
          }
        } catch (error) {
          logger.warn(
            `Cannot inspect model catalog ${target.path}: ${String(error)}`,
          );
        }
      }
      const missingModels = [
        ...new Map(
          snapshots
            .flatMap((snapshot) => snapshot.models)
            .map((model) => [modelIdentity(model), model]),
        ).values(),
      ];
      const shownModels = missingModels.length ? missingModels : additions;
      const names = shownModels
        .slice(0, 4)
        .map(modelNotificationLabel)
        .join(", ");
      const details = snapshots
        .map(
          (snapshot) =>
            `${snapshot.target.path}\n  Add: ${snapshot.models.map(modelNotificationLabel).join(", ")}`,
        )
        .join("\n\n");
      if (!snapshots.length && !manual.length) {
        if (!additionsById.size && findCatalogTargets(context).length) {
          await vscode.window.showInformationMessage(
            `New VS Code models detected: ${names}. These providers are not currently supported by Agent Maestro's proxy; existing client lists were not changed.`,
          );
        }
        return;
      }
      const choice = await vscode.window.showInformationMessage(
        `New VS Code models available: ${names}${shownModels.length > 4 ? ` and ${shownModels.length - 4} more` : ""}. Update ${snapshots.length} already configured DSH / CodeBuddy / WorkBuddy model list(s)?${manual.length ? ` ${manual.length} catalog(s) require manual merging.` : ""}`,
        ...(snapshots.length
          ? ["Update model lists", "Show update details"]
          : []),
        ...(manual.length ? ["Review configuration"] : []),
        "Not now",
      );
      if (disposed) {
        return;
      }
      let confirmed = choice;
      if (choice === "Show update details") {
        confirmed = await vscode.window.showInformationMessage(
          "Review model catalog additions",
          {
            modal: true,
            detail: `${details}${manual.length ? `\n\nManual review: ${manual.map((target) => target.path).join(", ")}` : ""}\n\nOnly the listed missing IDs will be appended; catalogs already containing them are untouched.`,
          },
          "Update model lists",
          "Not now",
        );
      }
      if (disposed) {
        return;
      }
      if (confirmed === "Update model lists") {
        let count = 0;
        for (const snapshot of snapshots) {
          try {
            if (
              !findCatalogTargets(context).some(
                (target) => target.path === snapshot.target.path,
              )
            ) {
              throw new Error(
                "Catalog target is no longer available in this workspace",
              );
            }
            writeCatalogUpdate(
              snapshot.target,
              snapshot.original,
              snapshot.updated,
            );
            count++;
          } catch (error) {
            logger.warn(
              `Catalog update skipped ${snapshot.target.path}: ${String(error)}`,
            );
            await vscode.window.showWarningMessage(
              `Model catalog was not updated: ${snapshot.target.path}. ${String(error)}`,
            );
          }
        }
        await vscode.window.showInformationMessage(
          `Updated ${count} existing model list(s). Existing defaults and credentials were preserved. Reopen the client model picker to see new options.`,
        );
      } else if (confirmed === "Review configuration") {
        for (const target of manual) {
          await vscode.window.showTextDocument(
            await vscode.workspace.openTextDocument(
              vscode.Uri.file(target.path),
            ),
          );
        }
      }
    } catch (error) {
      logger.warn(`Model catalog discovery failed: ${String(error)}`);
    } finally {
      running = false;
      if (pending && !disposed) {
        pending = false;
        schedule();
      }
    }
  };
  const schedule = () => {
    if (disposed) {
      return;
    }
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = undefined;
      void check();
    }, 750);
  };
  const event = vscode.lm.onDidChangeChatModels(schedule);
  const disposable = new vscode.Disposable(() => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
    }
    event.dispose();
  });
  context.subscriptions.push(disposable);
  schedule();
  return disposable;
}
