import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { HardCaseEvent } from "./types.js";
import type { HardCaseEventLog } from "./queue.js";

/**
 * Append-only JSONL event log. One event per line, fsync-free by design
 * (single-writer operational tooling); the log is the source of truth and a
 * queue is rebuilt by replaying it. A corrupt or truncated line makes
 * `readAll` THROW — a damaged log is surfaced loudly, never silently
 * shortened.
 */
export class FileEventLog implements HardCaseEventLog {
  constructor(private readonly path: string) {}

  append(event: HardCaseEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
  }

  readAll(): HardCaseEvent[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n");
    const events: HardCaseEvent[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined || line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(
          `hard-case log ${this.path} corrupt at line ${i + 1}: unparseable JSON — refusing to drop events`,
        );
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as { seq?: unknown }).seq !== "number" ||
        typeof (parsed as { type?: unknown }).type !== "string"
      ) {
        throw new Error(
          `hard-case log ${this.path} corrupt at line ${i + 1}: not a hard-case event`,
        );
      }
      events.push(parsed as HardCaseEvent);
    }
    return events;
  }
}
