import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface BuddyModel {
  id: string;
  name?: string;
  url?: string;
  apiKey?: string;
  [key: string]: unknown;
}
export interface BuddySettings {
  models?: BuddyModel[];
  availableModels?: string[];
  [key: string]: unknown;
}
export interface BuddySnapshot {
  path: string;
  original?: string;
  settings: BuddySettings;
}

export function readBuddySettings(filePath: string): BuddySnapshot {
  let original: string;
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Not a regular settings file: ${filePath}`);
    }
    original = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: filePath, settings: {} };
    }
    throw error;
  }
  const settings: unknown = JSON.parse(original);
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error(`Invalid settings object: ${filePath}`);
  }
  const config = settings as BuddySettings;
  if (
    config.models !== undefined &&
    (!Array.isArray(config.models) ||
      config.models.some(
        (model) =>
          !model ||
          typeof model !== "object" ||
          typeof model.id !== "string" ||
          !model.id ||
          (model.name !== undefined && typeof model.name !== "string"),
      ))
  ) {
    throw new Error(`Invalid models array: ${filePath}`);
  }
  const ids = (config.models ?? []).map((model) => model.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Duplicate model IDs: ${filePath}`);
  }
  if (
    config.availableModels !== undefined &&
    (!Array.isArray(config.availableModels) ||
      config.availableModels.some((id) => typeof id !== "string"))
  ) {
    throw new Error(`Invalid availableModels whitelist: ${filePath}`);
  }
  return { path: filePath, original, settings: config };
}

export function isMaestroBuddyModel(model: BuddyModel): boolean {
  if (
    !model.name?.endsWith(" (Agent Maestro)") ||
    typeof model.url !== "string"
  ) {
    return false;
  }
  try {
    const url = new URL(model.url);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === "/api/openai/v1/chat/completions"
    );
  } catch {
    return false;
  }
}

/** Preserve custom rows, unavailable models and per-product secrets/settings. */
export function mergeBuddySettings(
  existing: BuddySettings,
  incoming: BuddyModel[],
): BuddySettings {
  const models = (existing.models ?? []).map((model) => ({ ...model }));
  const indexes = new Map(models.map((model, i) => [model.id, i]));
  const template = models.find(isMaestroBuddyModel);
  for (const model of incoming) {
    const index = indexes.get(model.id);
    if (index === undefined) {
      indexes.set(model.id, models.length);
      models.push({
        supportsToolCall: true,
        supportsImages: false,
        ...model,
        ...(template?.apiKey !== undefined ? { apiKey: template.apiKey } : {}),
      });
    } else if (isMaestroBuddyModel(models[index])) {
      const old = models[index];
      models[index] = {
        ...old,
        ...model,
        ...(old.apiKey !== undefined ? { apiKey: old.apiKey } : {}),
        ...(old.vendor !== undefined ? { vendor: old.vendor } : {}),
      };
    }
    // An unrelated provider owning the same ID is never silently rerouted.
  }
  return { ...existing, models };
}

export function writeBuddySettings(
  snapshot: BuddySnapshot,
  settings: BuddySettings,
): boolean {
  const serialized = JSON.stringify(settings, null, 2) + "\n";
  let current: string | undefined;
  try {
    const stat = fs.lstatSync(snapshot.path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Settings file is no longer a regular file");
    }
    current = fs.readFileSync(snapshot.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  if (current !== snapshot.original) {
    throw new Error(`Settings changed during setup: ${snapshot.path}`);
  }
  if (
    current !== undefined &&
    JSON.stringify(JSON.parse(current)) === JSON.stringify(settings)
  ) {
    return false;
  }
  fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
  if (snapshot.original !== undefined) {
    fs.writeFileSync(`${snapshot.path}.${Date.now()}.bak`, snapshot.original, {
      encoding: "utf8",
      flag: "wx",
    });
    if (
      fs.lstatSync(snapshot.path).isSymbolicLink() ||
      fs.readFileSync(snapshot.path, "utf8") !== snapshot.original
    ) {
      throw new Error(`Settings changed while backing up: ${snapshot.path}`);
    }
  }
  if (snapshot.original === undefined) {
    fs.writeFileSync(snapshot.path, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
  } else {
    const temporary = `${snapshot.path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      fs.writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
      created = true;
      if (
        fs.lstatSync(snapshot.path).isSymbolicLink() ||
        fs.readFileSync(snapshot.path, "utf8") !== snapshot.original
      ) {
        throw new Error(
          `Settings changed before replacement: ${snapshot.path}`,
        );
      }
      // Same-directory rename avoids exposing truncated JSON; this is optimistic,
      // not an OS-level compare-and-swap against other processes.
      fs.renameSync(temporary, snapshot.path);
      created = false;
    } finally {
      if (created) {
        fs.unlinkSync(temporary);
      }
    }
  }
  return true;
}
