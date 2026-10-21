import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { UsageRecord, parseRecord } from "./model";

const DAY = 86400000;
const SEGMENT_BYTES = 1024 * 1024;
const MAX_BYTES = 100 * SEGMENT_BYTES;
const MAX_RECORDS = 50000;
const JOURNAL = /^usage-\d+-[a-f0-9-]+-\d+\.jsonl$/;

export class UsageStore {
  private queue = Promise.resolve();
  private readonly writer = randomUUID();
  private segment = 0;
  private bytes = 0;
  private file = "";
  private day = "";
  private lastPrune = 0;
  private pending = 0;
  constructor(
    readonly directory: string,
    private readonly onError: () => void = () => {},
  ) {}

  append(record: UsageRecord): void {
    const safe = parseRecord(record);
    if (!safe || this.pending >= 1000) {
      if (this.pending >= 1000) {
        this.onError();
      }
      return;
    }
    this.pending++;
    this.queue = this.queue
      .then(async () => {
        await fs.mkdir(this.directory, { recursive: true });
        const line = JSON.stringify(safe) + "\n";
        const day = new Date().toISOString().slice(0, 10);
        if (
          !this.file ||
          this.day !== day ||
          this.bytes + Buffer.byteLength(line) > SEGMENT_BYTES
        ) {
          this.file = path.join(
            this.directory,
            "usage-" +
              Date.now() +
              "-" +
              this.writer +
              "-" +
              this.segment++ +
              ".jsonl",
          );
          this.bytes = 0;
          this.day = day;
        }
        await fs.appendFile(this.file, line, { encoding: "utf8", mode: 0o600 });
        this.bytes += Buffer.byteLength(line);
        if (Date.now() - this.lastPrune > 60000) {
          await this.prune();
          this.lastPrune = Date.now();
        }
      })
      .catch(() => {
        this.onError();
      })
      .finally(() => {
        this.pending--;
      });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private async files() {
    await fs.mkdir(this.directory, { recursive: true });
    const names = (await fs.readdir(this.directory)).filter((name) =>
      JOURNAL.test(name),
    );
    const files = await Promise.all(
      names.map(async (name) => {
        try {
          const stat = await fs.lstat(path.join(this.directory, name));
          return stat.isFile() && !stat.isSymbolicLink()
            ? { name, size: stat.size, modified: stat.mtimeMs }
            : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return files
      .filter((file): file is NonNullable<typeof file> => !!file)
      .sort((a, b) => b.modified - a.modified);
  }

  private async prune(): Promise<void> {
    let retained = 0;
    for (const file of await this.files()) {
      retained += file.size;
      const age = Date.now() - file.modified;
      // Other VS Code windows can still append to their current segment.
      if (age > 30 * DAY || (retained > MAX_BYTES && age > 3600000)) {
        await fs.unlink(path.join(this.directory, file.name)).catch(() => {});
      }
    }
  }

  async read(): Promise<{ records: UsageRecord[]; truncated: boolean }> {
    await this.flush();
    await this.prune();
    const records: UsageRecord[] = [];
    const ids = new Set<string>();
    let bytes = 0;
    let truncated = false;
    for (const file of await this.files()) {
      if (bytes + file.size > MAX_BYTES) {
        truncated = true;
        break;
      }
      if (file.size > SEGMENT_BYTES + 8192) {
        truncated = true;
        continue;
      }
      bytes += file.size;
      let text: string;
      try {
        text = await fs.readFile(path.join(this.directory, file.name), "utf8");
      } catch {
        continue;
      }
      // An append may be in progress; only newline-terminated records are durable.
      if (!text.includes("\n")) {
        continue;
      }
      for (const line of text
        .slice(0, text.lastIndexOf("\n"))
        .split("\n")
        .reverse()) {
        if (!line || line.length > 8192) {
          continue;
        }
        try {
          const row = parseRecord(JSON.parse(line));
          if (
            row &&
            row.startedAt >= Date.now() - 30 * DAY &&
            !ids.has(row.id)
          ) {
            records.push(row);
            ids.add(row.id);
          }
        } catch {
          /* A damaged record must not hide the rest of the journal. */
        }
      }
      if (records.length > MAX_RECORDS) {
        records.sort((a, b) => b.startedAt - a.startedAt);
        records.length = MAX_RECORDS;
        truncated = true;
      }
    }
    return {
      records: records.sort((a, b) => b.startedAt - a.startedAt),
      truncated,
    };
  }
}
