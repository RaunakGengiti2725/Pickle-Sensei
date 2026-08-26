import type pg from "pg";
import type { IJobQueue } from "@pickle/queue";
import type { ApiConfig } from "./config.js";
import type { IObjectStore } from "./modules/media/objectStore.js";

/** Shared per-process context injected into every module. */
export interface AppContext {
  config: ApiConfig;
  pool: pg.Pool | null;
  queue: IJobQueue;
  objectStore: IObjectStore | null;
}
