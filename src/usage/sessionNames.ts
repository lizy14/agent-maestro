import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { parseSessionNames } from "./model";

const MAX_BYTES = 5 * 1024 * 1024;
export function sameFileIdentity(
  left: { ino: number; dev: number },
  right: { ino: number; dev: number },
): boolean {
  // Windows lstat can report dev=0 while fstat reports the volume serial.
  return (
    left.ino === right.ino &&
    (left.dev === right.dev || left.dev === 0 || right.dev === 0)
  );
}
export interface SessionNamesResult {
  names: Record<string, string>;
  status: "loaded" | "missing" | "unavailable" | "too-large";
  file: string;
}

export function codexSessionIndex(
  configuredHome?: string,
  environmentHome = process.env.CODEX_HOME,
  userHome = os.homedir(),
): string {
  const root =
    configuredHome?.trim() ||
    environmentHome?.trim() ||
    path.join(userHome, ".codex");
  const expanded =
    root === "~"
      ? userHome
      : root.startsWith("~/") || root.startsWith("~\\")
        ? path.join(userHome, root.slice(2))
        : root;
  // Never resolve a relative environment value against an untrusted workspace.
  if (!path.isAbsolute(expanded)) {
    throw new Error("Codex home must be absolute");
  }
  return path.join(expanded, "session_index.jsonl");
}

export class CodexSessionNames {
  private cached?: {
    file: string;
    stamp: string;
    names: Record<string, string>;
  };
  clear(): void {
    this.cached = undefined;
  }

  async read(file: string): Promise<SessionNamesResult> {
    const empty = (
      status: SessionNamesResult["status"],
    ): SessionNamesResult => {
      this.clear();
      return { file, names: Object.create(null), status };
    };
    let handle: fs.FileHandle | undefined;
    try {
      const entry = await fs.lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        return empty("unavailable");
      }
      if (entry.size > MAX_BYTES) {
        return empty("too-large");
      }
      const stamp = [entry.size, entry.mtimeMs, entry.ctimeMs, entry.ino].join(
        ":",
      );
      if (this.cached?.file === file && this.cached.stamp === stamp) {
        return { file, names: this.cached.names, status: "loaded" };
      }
      handle = await fs.open(file, "r");
      const stat = await handle.stat();
      if (!sameFileIdentity(entry, stat)) {
        return empty("unavailable");
      }
      if (!stat.isFile()) {
        return empty("unavailable");
      }
      if (stat.size > MAX_BYTES) {
        return empty("too-large");
      }
      // Fixed allocation also bounds a file that grows during the read.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) {
          break;
        }
        length += bytesRead;
      }
      if (length > MAX_BYTES) {
        return empty("too-large");
      }
      const text = buffer.toString("utf8", 0, length);
      const lastNewline = text.lastIndexOf("\n");
      const names = parseSessionNames(
        lastNewline < 0 ? "" : text.slice(0, lastNewline),
      );
      this.cached = { file, stamp, names };
      return { file, names, status: "loaded" };
    } catch (error) {
      return empty(
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "missing"
          : "unavailable",
      );
    } finally {
      await handle?.close();
    }
  }
}
