import * as fs from "fs";
import * as vscode from "vscode";

import { DSH_MANAGED_BLOCK_END, DSH_MANAGED_BLOCK_START } from "./dshSettings";
import { logger } from "./logger";
import {
  CatalogTarget,
  appendCatalogModels,
  findCatalogTargets,
  hasPopulatedCatalog,
  writeCatalogUpdate,
} from "./modelCatalogs";
import { modelRouteId } from "./modelIdentity";

export const REMOVAL_INVENTORY_KEY = "agent-maestro.lastHealthyModelInventory";
export const REMOVAL_CONFIRM_DELAY_MS = 30000;
export interface ModelInventoryEntry {
  vendor: string;
  id: string;
  routeId: string;
}
export interface RemovalCandidate {
  id: string;
  name: string;
}
export interface MissingEvidence {
  since: number;
  lastSeenMissing: number;
  observations: number;
}
export function newerSeriesModel(
  old: ModelInventoryEntry,
  current: ModelInventoryEntry[],
): ModelInventoryEntry | undefined {
  const signature = (id: string) => {
    if (
      !/^(?:gpt-|claude-|gemini-|grok-|mai-)/.test(id) ||
      /^(?:auto|copilot-utility|copilot-dictation)/.test(id)
    ) {
      return undefined;
    }
    const parts = id.match(/\d+|\D+/g);
    if (!parts || !parts.some((part) => /^\d+$/.test(part))) {
      return undefined;
    }
    return {
      family: parts.map((part) => (/^\d+$/.test(part) ? "#" : part)).join(""),
      version: parts.filter((part) => /^\d+$/.test(part)).map(Number),
    };
  };
  const before = signature(old.id);
  if (!before) {
    return undefined;
  }
  return current.find((model) => {
    if (model.vendor !== old.vendor) {
      return false;
    }
    const next = signature(model.id);
    if (
      !next ||
      before.family !== next.family ||
      before.version.length !== next.version.length
    ) {
      return false;
    }
    for (let i = 0; i < before.version.length; i++) {
      if (next.version[i] !== before.version[i]) {
        return next.version[i] > before.version[i];
      }
    }
    return false;
  });
}
export function removalConfidence(
  evidence: MissingEvidence,
  successor: ModelInventoryEntry | undefined,
  now: number,
): { eligible: boolean; reason: string } {
  const duration = now - evidence.since;
  if (
    successor &&
    evidence.observations >= 2 &&
    duration >= REMOVAL_CONFIRM_DELAY_MS
  ) {
    return {
      eligible: true,
      reason: `Missing in ${evidence.observations} spaced checks; newer same-series route available: ${successor.vendor} / ${successor.id}`,
    };
  }
  return {
    eligible: evidence.observations >= 3 && duration >= 5 * 60 * 1000,
    reason: `Missing in ${evidence.observations} spaced checks over ${Math.floor(duration / 1000)} seconds (requires 3 checks and 5 minutes without a same-series successor)`,
  };
}
export interface CatalogRemovalPlan {
  target: CatalogTarget;
  original: string;
  candidates: RemovalCandidate[];
  blockedReason?: string;
}

export function modelInventory(
  models: vscode.LanguageModelChat[],
): ModelInventoryEntry[] {
  return [
    ...new Map(
      models.map((model) => [
        JSON.stringify([model.vendor, model.id]),
        { vendor: model.vendor, id: model.id, routeId: modelRouteId(model) },
      ]),
    ).values(),
  ];
}

/** Keep the pre-loss inventory as the baseline: an outage must not become the new normal. */
export function inventoryRemovalBlock(
  previous: ModelInventoryEntry[],
  current: ModelInventoryEntry[],
): string | undefined {
  if (!current.length) {
    return "VS Code currently reports no models";
  }
  if (!previous.length) {
    return undefined;
  }
  const present = new Set(
    current.map((item) => JSON.stringify([item.vendor, item.id])),
  );
  const lost = previous.filter(
    (item) => !present.has(JSON.stringify([item.vendor, item.id])),
  );
  if (lost.length >= Math.ceil(previous.length / 2)) {
    return "At least half of the previous model inventory is missing";
  }
  for (const vendor of new Set(previous.map((item) => item.vendor))) {
    const before = previous.filter((item) => item.vendor === vendor);
    const remaining = current.filter((item) => item.vendor === vendor);
    const missing = before.filter(
      (item) => !present.has(JSON.stringify([item.vendor, item.id])),
    ).length;
    if (!remaining.length || missing >= Math.ceil(before.length / 2)) {
      return `Provider ${vendor} lost at least half of its previously available models`;
    }
  }
  return undefined;
}

interface CatalogRow {
  id: string;
  name: string;
  start?: number;
  end?: number;
  owned: boolean;
}
interface ParsedCatalog {
  rows: CatalogRow[];
  protectedIds: Set<string>;
  json?: Record<string, any>;
  lines?: string[];
}

function maestroUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === "/api/openai/v1/chat/completions"
    );
  } catch {
    return false;
  }
}
function stringValues(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringValues(item, into));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => stringValues(item, into));
  }
}
function scalar(value: string): string {
  if (value.startsWith('"')) {
    return JSON.parse(value);
  }
  if (/^'(?:[^']|'')*'$/.test(value)) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[a-zA-Z0-9_.:/-]+$/.test(value)) {
    return value;
  }
  throw new Error("Unsupported default/model reference; merge manually");
}

function parseRemovalCatalog(
  target: CatalogTarget,
  content: string,
): ParsedCatalog {
  if (!hasPopulatedCatalog(target, content)) {
    throw new Error("No populated Maestro catalog");
  }
  if (target.kind === "workbuddy") {
    const config = JSON.parse(content);
    if (
      !config ||
      !Array.isArray(config.models) ||
      config.models.some(
        (row: any) =>
          !row || typeof row.id !== "string" || typeof row.name !== "string",
      )
    ) {
      throw new Error("Unsupported model catalog");
    }
    if (
      new Set(config.models.map((row: any) => row.id)).size !==
      config.models.length
    ) {
      throw new Error("Duplicate model IDs");
    }
    const protectedIds = new Set<string>();
    for (const [key, value] of Object.entries(config)) {
      if (key !== "models") {
        stringValues(value, protectedIds);
      }
    }
    // Related-model references are also protected, even when they live on a custom row.
    for (const row of config.models) {
      const { id: _id, name: _name, ...other } = row;
      stringValues(other, protectedIds);
    }
    return {
      json: config,
      protectedIds,
      rows: config.models.map((row: any) => ({
        id: row.id,
        name: row.name,
        owned: maestroUrl(row.url) && row.name.endsWith(" (Agent Maestro)"),
      })),
    };
  }
  // Reuse the strict generated-section checks before doing any destructive splice.
  appendCatalogModels(target, content, []);
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(DSH_MANAGED_BLOCK_START);
  const end = lines.indexOf(DSH_MANAGED_BLOCK_END);
  if (start < 0 || end <= start) {
    throw new Error("Missing managed block");
  }
  const modern = lines[start + 1] === "- id: llm-pi-ai";
  const indent = modern ? "          " : "        ";
  const header = modern ? "        models:" : "      models:";
  const section = lines.indexOf(header, start);
  if (section < 0 || section >= end) {
    throw new Error("Missing model catalog");
  }
  let finish = section + 1;
  while (
    finish < end &&
    (lines[finish].startsWith(indent) || !lines[finish].trim())
  ) {
    finish++;
  }
  const rows: CatalogRow[] = [];
  for (let i = section + 1; i < finish; i++) {
    if (!lines[i].startsWith(`${indent}- id: `)) {
      continue;
    }
    if (rows.length) {
      rows[rows.length - 1].end = i;
    }
    const id = JSON.parse(lines[i].slice(`${indent}- id: `.length));
    rows.push({ id, name: id, start: i, end: finish, owned: false });
  }
  for (const row of rows) {
    const rowLines = lines.slice(row.start! + 1, row.end);
    const fields = rowLines
      .map(
        (line) =>
          line.match(
            new RegExp(`^${indent}  (name|input|contextWindow|maxTokens):`),
          )?.[1],
      )
      .filter((field): field is string => !!field);
    if (new Set(fields).size !== fields.length) {
      throw new Error("Duplicate DSH model fields require manual removal");
    }
    const nameLine = lines
      .slice(row.start! + 1, row.end)
      .find((line) => line.startsWith(`${indent}  name: `));
    if (nameLine) {
      row.name = JSON.parse(nameLine.slice(`${indent}  name: `.length));
    }
    row.owned = row.name.endsWith(" (Agent Maestro)");
  }
  const protectedIds = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (i > section && i < finish) {
      continue;
    }
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }
    const listScalar = line.match(
      /^\s*-\s+("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[a-zA-Z0-9_.:/-]+)\s*$/,
    );
    if (listScalar) {
      protectedIds.add(scalar(listScalar[1]));
      continue;
    }
    // Protect defaults and other scalar references anywhere outside the generated list.
    const match = line.match(/:\s*(\S.*?)\s*$/);
    if (match && !/^[{[&*!|>]/.test(match[1])) {
      protectedIds.add(scalar(match[1]));
    } else if (match) {
      throw new Error("Complex surrounding YAML requires manual removal");
    }
  }
  return { lines, rows, protectedIds };
}

export function planCatalogRemoval(
  target: CatalogTarget,
  original: string,
  absentRouteIds: ReadonlySet<string>,
): CatalogRemovalPlan {
  const parsed = parseRemovalCatalog(target, original);
  const owned = parsed.rows.filter((row) => row.owned);
  for (const reference of parsed.protectedIds) {
    if (reference.endsWith("[1m]")) {
      parsed.protectedIds.add(reference.slice(0, -4));
    }
  }
  const absentOwned = owned.filter((row) => absentRouteIds.has(row.id));
  if (absentOwned.length && absentOwned.length >= Math.ceil(owned.length / 2)) {
    return {
      target,
      original,
      candidates: [],
      blockedReason:
        "At least half of this catalog's Maestro models appear unavailable",
    };
  }
  return {
    target,
    original,
    candidates: absentOwned
      .filter((row) => !parsed.protectedIds.has(row.id))
      .map(({ id, name }) => ({ id, name })),
  };
}

export function removeCatalogModels(
  plan: CatalogRemovalPlan,
  selectedIds: ReadonlySet<string>,
): string {
  if (plan.blockedReason) {
    throw new Error(plan.blockedReason);
  }
  const parsed = parseRemovalCatalog(plan.target, plan.original);
  for (const reference of parsed.protectedIds) {
    if (reference.endsWith("[1m]")) {
      parsed.protectedIds.add(reference.slice(0, -4));
    }
  }
  const allowed = new Set(plan.candidates.map((row) => row.id));
  const ids = new Set(
    [...selectedIds].filter(
      (id) => allowed.has(id) && !parsed.protectedIds.has(id),
    ),
  );
  if (!ids.size) {
    return plan.original;
  }
  const remainingOwned = parsed.rows.filter(
    (row) => row.owned && !ids.has(row.id),
  );
  if (
    !remainingOwned.length ||
    ids.size >= Math.ceil(parsed.rows.filter((row) => row.owned).length / 2)
  ) {
    throw new Error("Refusing to remove most or all catalog models");
  }
  if (parsed.json) {
    parsed.json.models = parsed.json.models.filter(
      (row: any) => !ids.has(row.id),
    );
    return `${JSON.stringify(parsed.json, null, 2)}\n`;
  }
  const lines = parsed.lines!;
  for (const row of [...parsed.rows].reverse()) {
    if (ids.has(row.id)) {
      lines.splice(row.start!, row.end! - row.start!);
    }
  }
  return lines.join(plan.original.includes("\r\n") ? "\r\n" : "\n");
}

export class ModelRemovalMonitor {
  private missingSince = new Map<string, MissingEvidence>();
  private handled = new Set<string>();
  private warned = "";
  constructor(
    private context: vscode.ExtensionContext,
    private now: () => number = Date.now,
  ) {}

  async check(
    models: vscode.LanguageModelChat[],
    scheduleRecheck: () => void,
    disposed: () => boolean,
  ): Promise<void> {
    const current = modelInventory(models);
    const previous = this.context.globalState.get<ModelInventoryEntry[]>(
      REMOVAL_INVENTORY_KEY,
      [],
    );
    const reason = inventoryRemovalBlock(previous, current);
    if (reason) {
      this.missingSince.clear();
      if (previous.length && this.warned !== reason) {
        this.warned = reason;
        logger.warn(
          `Model removal disabled: ${reason}. Existing catalogs were retained.`,
        );
      }
      return;
    }
    this.warned = "";
    const present = new Set(current.map((item) => item.routeId));
    for (const id of this.missingSince.keys()) {
      if (present.has(id)) {
        this.missingSince.delete(id);
      }
    }
    for (const key of this.handled) {
      if (present.has(key.slice(key.indexOf("\0") + 1))) {
        this.handled.delete(key);
      }
    }
    const missing = previous.filter((item) => !present.has(item.routeId));
    // Retain absent identities until they reappear; never trust a decaying baseline.
    const baseline = [
      ...new Map(
        [...previous, ...current].map((item) => [item.routeId, item]),
      ).values(),
    ];
    await this.context.globalState.update(REMOVAL_INVENTORY_KEY, baseline);
    const stable = new Set<string>();
    const confidence = new Map<string, string>();
    for (const item of missing) {
      let evidence = this.missingSince.get(item.routeId);
      if (!evidence) {
        evidence = {
          since: this.now(),
          lastSeenMissing: this.now(),
          observations: 1,
        };
        this.missingSince.set(item.routeId, evidence);
      } else if (
        this.now() - evidence.lastSeenMissing >=
        REMOVAL_CONFIRM_DELAY_MS
      ) {
        evidence.observations++;
        evidence.lastSeenMissing = this.now();
      }
      const result = removalConfidence(
        evidence,
        newerSeriesModel(item, current),
        this.now(),
      );
      confidence.set(item.routeId, result.reason);
      if (result.eligible) {
        stable.add(item.routeId);
      }
    }
    if (missing.some((item) => !stable.has(item.routeId))) {
      scheduleRecheck();
    }
    if (!stable.size || disposed()) {
      return;
    }
    const plans: CatalogRemovalPlan[] = [];
    for (const target of findCatalogTargets(this.context)) {
      try {
        const original = fs.readFileSync(target.path, "utf8");
        const plan = planCatalogRemoval(target, original, stable);
        plan.candidates = plan.candidates.filter(
          (row) => !this.handled.has(`${target.path}\0${row.id}`),
        );
        if (plan.candidates.length) {
          plans.push(plan);
        } else if (plan.blockedReason) {
          logger.warn(
            `Removal disabled for ${target.path}: ${plan.blockedReason}`,
          );
        }
      } catch (error) {
        logger.debug(
          `Catalog removal inspection skipped ${target.path}: ${String(error)}`,
        );
      }
    }
    if (!plans.length) {
      return;
    }
    plans.forEach((plan) =>
      plan.candidates.forEach((row) =>
        this.handled.add(`${plan.target.path}\0${row.id}`),
      ),
    );
    const action = await vscode.window.showInformationMessage(
      `Previously available VS Code models are currently unavailable in ${plans.length} configured model list(s). Review optional removal? Defaults and custom models are protected.`,
      "Review unavailable models",
      "Keep entries",
    );
    if (action !== "Review unavailable models" || disposed()) {
      return;
    }
    const options = plans.flatMap((plan) =>
      plan.candidates.map((row) => ({
        label: row.name,
        description: row.id,
        detail: `${plan.target.path}\n${confidence.get(row.id) ?? ""}`,
        picked: false,
        plan,
        id: row.id,
      })),
    );
    const selected = await vscode.window.showQuickPick(options, {
      canPickMany: true,
      title: "Select unavailable model entries to remove",
      placeHolder:
        "Nothing is selected by default. Temporary provider failures can hide models.",
    });
    if (!selected?.length || disposed()) {
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      "Remove the selected unavailable model entries?",
      {
        modal: true,
        detail:
          selected
            .map((row) => `${row.id}\n${row.plan.target.path}`)
            .join("\n\n") +
          "\n\nFiles will be backed up. Defaults, references and unrelated settings will be retained.",
      },
      "Remove selected entries",
    );
    if (confirm !== "Remove selected entries" || disposed()) {
      return;
    }
    // Query again after all user interactions. Never delete a reappeared model.
    const verified = modelInventory(await vscode.lm.selectChatModels());
    if (disposed()) {
      return;
    }
    const blocked = inventoryRemovalBlock(baseline, verified);
    if (blocked) {
      await vscode.window.showWarningMessage(
        `No models were removed: ${blocked}. This may be a provider/sign-in outage.`,
      );
      return;
    }
    const live = new Set(verified.map((item) => item.routeId));
    let count = 0;
    for (const plan of plans) {
      const ids = new Set(
        selected
          .filter((row) => row.plan === plan && !live.has(row.id))
          .map((row) => row.id),
      );
      if (!ids.size) {
        continue;
      }
      try {
        if (
          !findCatalogTargets(this.context).some(
            (target) => target.path === plan.target.path,
          )
        ) {
          throw new Error("Catalog is no longer available in this workspace");
        }
        const updated = removeCatalogModels(plan, ids);
        writeCatalogUpdate(plan.target, plan.original, updated);
        if (updated !== plan.original) {
          count++;
        }
      } catch (error) {
        logger.warn(
          `Unavailable-model removal skipped ${plan.target.path}: ${String(error)}`,
        );
        await vscode.window.showWarningMessage(
          `Model entries were not removed from ${plan.target.path}: ${String(error)}`,
        );
      }
    }
    await vscode.window.showInformationMessage(
      `Removed selected unavailable entries from ${count} model list(s). Reappeared models and defaults were kept.`,
    );
  }
}
