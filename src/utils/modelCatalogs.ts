import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";

import {
  DSH_MANAGED_BLOCK_END,
  DSH_MANAGED_BLOCK_START,
  DshModelConfig,
  createDshManagedBlock,
  getDshSettingsPath,
} from "./dshSettings";
import { modelDisplayName, modelRouteId } from "./modelIdentity";

export interface CatalogTarget {
  workspace?: string;
  path: string;
  kind: "dsh" | "workbuddy";
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}
export const CATALOG_TARGETS_KEY = "agent-maestro.modelCatalogTargets";

export function modelToDshConfig(
  model: vscode.LanguageModelChat,
): DshModelConfig {
  const runtime = model as vscode.LanguageModelChat & {
    maxOutputTokens?: number;
    capabilities?: { imageInput?: boolean; supportsImageToText?: boolean };
  };
  return {
    modelId: modelRouteId(model),
    modelName: modelDisplayName(model),
    modelContextWindow:
      Number.isSafeInteger(model.maxInputTokens) && model.maxInputTokens > 0
        ? model.maxInputTokens
        : undefined,
    modelMaxOutputTokens:
      Number.isSafeInteger(runtime.maxOutputTokens) &&
      runtime.maxOutputTokens! > 0
        ? runtime.maxOutputTokens
        : undefined,
    modelInput:
      runtime.capabilities?.imageInput === true ||
      runtime.capabilities?.supportsImageToText === true
        ? ["text", "image"]
        : ["text"],
  };
}

export async function rememberCatalogTargets(
  context: vscode.ExtensionContext,
  targets: CatalogTarget[],
): Promise<void> {
  const existing =
    context.globalState?.get<CatalogTarget[]>(CATALOG_TARGETS_KEY, []) ?? [];
  const merged = new Map(existing.map((target) => [target.path, target]));
  targets.forEach((target) => {
    const folder = vscode.workspace.workspaceFolders?.find((folder) =>
      target.path.startsWith(`${folder.uri.fsPath}${path.sep}`),
    );
    merged.set(target.path, {
      ...target,
      ...(folder ? { workspace: folder.uri.fsPath } : {}),
    });
  });
  await context.globalState?.update(CATALOG_TARGETS_KEY, [...merged.values()]);
}

export function findCatalogTargets(
  context: vscode.ExtensionContext,
): CatalogTarget[] {
  const targets = new Map<string, CatalogTarget>();
  const add = (filePath: string, kind: CatalogTarget["kind"]) =>
    targets.set(filePath, { path: filePath, kind });
  const home = path.dirname(getDshSettingsPath());
  add(getDshSettingsPath(), "dsh");
  try {
    for (const profile of fs.readdirSync(path.join(home, "profiles"), {
      withFileTypes: true,
    })) {
      if (profile.isDirectory() && !profile.isSymbolicLink()) {
        add(
          path.join(home, "profiles", profile.name, "cordis.patch.yml"),
          "dsh",
        );
      }
    }
  } catch {
    /* No initialized profiles. */
  }
  for (const root of [
    os.homedir(),
    ...(vscode.workspace.workspaceFolders ?? [])
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) => folder.uri.fsPath),
  ]) {
    for (const dir of [".codebuddy", ".workbuddy"]) {
      add(path.join(root, dir, "models.json"), "workbuddy");
    }
  }
  for (const target of context.globalState.get<CatalogTarget[]>(
    CATALOG_TARGETS_KEY,
    [],
  )) {
    if (
      target &&
      path.isAbsolute(target.path) &&
      ["dsh", "workbuddy"].includes(target.kind) &&
      (!target.workspace ||
        vscode.workspace.workspaceFolders?.some((folder) =>
          samePath(folder.uri.fsPath, target.workspace!),
        ))
    ) {
      add(target.path, target.kind);
    }
  }
  return [...targets.values()].filter((target) => {
    try {
      const stat = fs.lstatSync(target.path);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
}

function isMaestroUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.pathname === "/api/openai/v1/chat/completions"
    );
  } catch {
    return false;
  }
}

export function hasPopulatedCatalog(
  target: CatalogTarget,
  content: string,
): boolean {
  if (target.kind === "workbuddy") {
    try {
      const config = JSON.parse(content);
      return (
        Array.isArray(config.models) &&
        config.models.some((model: { url?: unknown }) =>
          isMaestroUrl(model?.url),
        )
      );
    } catch {
      return false;
    }
  }
  return (
    /apiKeyEnv:\s*AGENT_MAESTRO_API_KEY/.test(content) &&
    /agent-maestro:/.test(content) &&
    /models:/.test(content)
  );
}

/** Append only: existing model settings, defaults, endpoints and unrelated entries stay intact. */
export function appendCatalogModels(
  target: CatalogTarget,
  content: string,
  models: vscode.LanguageModelChat[],
): string {
  if (!hasPopulatedCatalog(target, content)) {
    throw new Error("No existing Agent Maestro model catalog");
  }
  if (target.kind === "workbuddy") {
    const config = JSON.parse(content);
    const template = config.models.find((model: { url?: unknown }) =>
      isMaestroUrl(model?.url),
    );
    const ids = new Set(
      config.models.map((model: { id?: unknown }) => model.id),
    );
    if (
      config.models.some(
        (model: { id?: unknown } | null) =>
          !model || typeof model.id !== "string",
      ) ||
      ids.size !== config.models.length
    ) {
      throw new Error("Malformed or duplicate catalog IDs");
    }
    let changed = false;
    for (const model of models) {
      if (ids.has(modelRouteId(model))) {
        continue;
      }
      const dsh = modelToDshConfig(model);
      const runtime = model as vscode.LanguageModelChat & {
        capabilities?: {
          toolCalling?: boolean | number;
          supportsToolCalling?: boolean;
        };
      };
      config.models.push({
        id: modelRouteId(model),
        name: dsh.modelName,
        vendor: "OpenAI",
        apiKey: template.apiKey ?? "Powered by Agent Maestro",
        url: template.url,
        ...(dsh.modelContextWindow
          ? { maxInputTokens: dsh.modelContextWindow }
          : {}),
        ...(dsh.modelMaxOutputTokens
          ? { maxOutputTokens: dsh.modelMaxOutputTokens }
          : {}),
        supportsImages: dsh.modelInput?.includes("image") ?? false,
        supportsToolCall:
          runtime.capabilities?.toolCalling !== undefined
            ? runtime.capabilities.toolCalling !== false &&
              runtime.capabilities.toolCalling !== 0
            : (runtime.capabilities?.supportsToolCalling ?? true),
      });
      ids.add(modelRouteId(model));
      changed = true;
    }
    if (!changed) {
      return content;
    }
    // Notification updates leave any independently chosen whitelist unchanged.
    return `${JSON.stringify(config, null, 2)}\n`;
  }
  const lines = content.split(/\r?\n/);
  const starts = lines.flatMap((line, i) =>
    line === DSH_MANAGED_BLOCK_START ? [i] : [],
  );
  const ends = lines.flatMap((line, i) =>
    line === DSH_MANAGED_BLOCK_END ? [i] : [],
  );
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new Error(
      "DSH catalog requires a single managed block; use Configure DSH Settings for manual merging",
    );
  }
  const block = lines.slice(starts[0] + 1, ends[0]);
  if (block[0] !== "- id: llm-pi-ai" && block[0] !== "llm-pi-ai:") {
    throw new Error("Unrecognized managed DSH format");
  }
  const outside = [...lines.slice(0, starts[0]), ...lines.slice(ends[0] + 1)];
  if (
    outside.some((line) =>
      /^\s*(?:-\s*)?(?:id|name):.*(?:llm-pi-ai|agent-default-model)/.test(line),
    )
  ) {
    throw new Error("Conflicting DSH target overrides outside managed block");
  }
  for (const line of outside) {
    if (
      /^\s*(?:-\s*)?(?:["'].*\\|(?:id|name):\s*["'].*\\)|^\s*-\s*[&*!{[]/.test(
        line,
      )
    ) {
      throw new Error("Ambiguous outside DSH target; merge manually");
    }
  }
  const modern = block[0] === "- id: llm-pi-ai";
  const section = modern ? "        models:" : "      models:";
  const modelIndent = modern ? "          " : "        ";
  const indexes = block.flatMap((line, i) => (line === section ? [i] : []));
  if (indexes.length !== 1) {
    throw new Error("Ambiguous DSH model catalog");
  }
  const providerIndent = modern ? "      " : "    ";
  const providerHeader = block
    .slice(0, indexes[0])
    .filter(
      (line) =>
        line.startsWith(providerIndent) &&
        !line.startsWith(`${providerIndent} `) &&
        line.endsWith(":"),
    );
  if (providerHeader.at(-1) !== `${providerIndent}agent-maestro:`) {
    throw new Error("Model catalog does not belong to Agent Maestro");
  }
  const begin = indexes[0] + 1;
  let finish = begin;
  while (
    finish < block.length &&
    (block[finish].startsWith(modelIndent) || !block[finish].trim())
  ) {
    finish++;
  }
  const region = block.slice(begin, finish);
  let inputList = false;
  for (const line of region) {
    if (!line.trim()) {
      continue;
    }
    if (line.startsWith(`${modelIndent}- id: `)) {
      inputList = false;
      continue;
    }
    const suffix = line.slice(modelIndent.length);
    if (
      /^  name: "(?:[^"\\]|\\.)*"$/.test(suffix) ||
      /^  (?:contextWindow|maxTokens): [1-9][0-9]*$/.test(suffix)
    ) {
      inputList = false;
      continue;
    }
    if (suffix === "  input:") {
      inputList = true;
      continue;
    }
    if (inputList && /^    - (?:text|image)$/.test(suffix)) {
      continue;
    }
    throw new Error("Customized DSH catalog requires manual merging");
  }
  if (
    !block.slice(0, indexes[0]).some((line) => /^\s*agent-maestro:$/.test(line))
  ) {
    throw new Error("Missing Maestro provider section");
  }
  if (
    modern &&
    block.filter((line) => /^-/.test(line)).join("\n") !==
      "- id: llm-pi-ai\n- id: agent-default-model"
  ) {
    throw new Error("Unexpected plugin entries in managed block");
  }
  const ids = new Set<string>();
  for (const line of region) {
    if (!line.startsWith(`${modelIndent}- id: `)) {
      continue;
    }
    try {
      const id = JSON.parse(line.slice(`${modelIndent}- id: `.length));
      if (typeof id !== "string") {
        throw new Error();
      }
      if (ids.has(id)) {
        throw new Error();
      }
      ids.add(id);
    } catch {
      throw new Error(
        "DSH model IDs require generated quoted scalars; merge manually",
      );
    }
  }
  if (!ids.size) {
    throw new Error("DSH model catalog is empty or unsupported");
  }
  if (
    region.some((line) => /\t|!!|[&*]|^\s*-\s*\{|^\s*[^:]+:\s*[|>]/.test(line))
  ) {
    throw new Error("Customized DSH model YAML requires manual merging");
  }
  const additions = [
    ...new Map(
      models
        .filter((model) => !ids.has(modelRouteId(model)))
        .map((model) => [modelRouteId(model), model]),
    ).values(),
  ];
  if (!additions.length) {
    return content;
  }
  const generated = createDshManagedBlock({
    baseURL: "http://127.0.0.1/unused",
    modelId: modelRouteId(additions[0]),
    models: additions.map(modelToDshConfig),
    format: modern ? "profile-patch" : "legacy-settings",
  }).split("\n");
  const generatedStart = generated.indexOf(section) + 1;
  const generatedEnd = modern
    ? generated.indexOf("- id: agent-default-model")
    : generated.indexOf(DSH_MANAGED_BLOCK_END);
  block.splice(finish, 0, ...generated.slice(generatedStart, generatedEnd));
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  return [
    ...lines.slice(0, starts[0] + 1),
    ...block,
    ...lines.slice(ends[0]),
  ].join(newline);
}

export function writeCatalogUpdate(
  target: CatalogTarget,
  original: string,
  updated: string,
): void {
  if (updated === original) {
    return;
  }
  if (
    vscode.workspace.textDocuments.some(
      (document) =>
        samePath(document.uri.fsPath, target.path) && document.isDirty,
    )
  ) {
    throw new Error("Catalog has unsaved editor changes");
  }
  if (
    fs.lstatSync(target.path).isSymbolicLink() ||
    fs.readFileSync(target.path, "utf8") !== original
  ) {
    throw new Error("Catalog changed while awaiting confirmation; retry");
  }
  fs.copyFileSync(
    target.path,
    `${target.path}.${Date.now()}.bak`,
    fs.constants.COPYFILE_EXCL,
  );
  fs.writeFileSync(target.path, updated, "utf8");
}
