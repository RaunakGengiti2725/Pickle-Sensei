import { writeFileSync } from 'node:fs';
import type { PlanLine, StatementRecord } from './nodeSqliteDriver';
import { explainQueryPlan } from './nodeSqliteDriver';

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export function stats(samples: readonly number[]): Stats {
  if (samples.length === 0) {
    return { n: 0, min: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => {
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return round(sorted[index] ?? 0);
  };
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    n: sorted.length,
    min: round(sorted[0] ?? 0),
    p50: at(0.5),
    p95: at(0.95),
    max: round(sorted[sorted.length - 1] ?? 0),
    mean: round(total / sorted.length),
  };
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export interface PlanReport {
  sql: string;
  params: unknown[];
  lines: string[];
  /** A bare `SCAN <table>` line: the whole table is read without an index. */
  fullScan: string[];
  /** `USE TEMP B-TREE FOR ORDER BY` — a sort that no index satisfies. */
  tempBtree: boolean;
  /** Index / covering index names the planner picked. */
  indexes: string[];
}

const PLANNED_PREFIX = /^(SELECT|DELETE|UPDATE|INSERT|WITH)\b/i;

export function isPlannable(sql: string): boolean {
  return PLANNED_PREFIX.test(normalizeSql(sql));
}

export function planFor(sql: string, params: unknown[]): PlanReport {
  const lines: PlanLine[] = explainQueryPlan(sql, params);
  const details = lines.map(line => line.detail);
  const fullScan = details.filter(detail => /^SCAN \w+$/.test(detail));
  const indexes = details
    .map(detail => /USING (?:COVERING )?INDEX (\w+)/.exec(detail)?.[1] ?? null)
    .filter((name): name is string => name !== null);
  return {
    sql: normalizeSql(sql),
    params,
    lines: details,
    fullScan,
    tempBtree: details.some(detail => detail.includes('USE TEMP B-TREE')),
    indexes,
  };
}

/** One plan per distinct SQL text in `records` (first params seen win). */
export function plansForRecords(
  records: readonly StatementRecord[],
): PlanReport[] {
  const seen = new Map<string, StatementRecord>();
  for (const record of records) {
    const key = normalizeSql(record.sql);
    if (!isPlannable(key) || seen.has(key)) continue;
    seen.set(key, record);
  }
  return [...seen.values()].map(record => planFor(record.sql, record.params));
}

export function sqlBreakdown(
  records: readonly StatementRecord[],
): Array<{ sql: string; count: number; totalMs: number; rows: number }> {
  const byShape = new Map<
    string,
    { sql: string; count: number; totalMs: number; rows: number }
  >();
  for (const record of records) {
    const key = normalizeSql(record.sql);
    const entry = byShape.get(key) ?? {
      sql: key,
      count: 0,
      totalMs: 0,
      rows: 0,
    };
    entry.count += 1;
    entry.totalMs += record.durationMs;
    entry.rows += record.rowCount;
    byShape.set(key, entry);
  }
  return [...byShape.values()]
    .map(entry => ({ ...entry, totalMs: round(entry.totalMs) }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

export function heapSnapshot(): {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
} {
  const gc = (globalThis as { gc?: () => void }).gc;
  gc?.();
  const usage = process.memoryUsage();
  const mb = (bytes: number): number => round(bytes / (1024 * 1024), 2);
  return {
    rssMb: mb(usage.rss),
    heapUsedMb: mb(usage.heapUsed),
    heapTotalMb: mb(usage.heapTotal),
    externalMb: mb(usage.external),
  };
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function planTable(plans: readonly PlanReport[]): string {
  const rows = plans.map(plan => {
    const flags = [
      plan.fullScan.length > 0 ? `FULL SCAN(${plan.fullScan.join('; ')})` : '',
      plan.tempBtree ? 'TEMP B-TREE' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `| \`${plan.sql.replace(/\|/g, '\\|')}\` | ${plan.lines
      .map(line => `\`${line}\``)
      .join('<br>')} | ${plan.indexes.join(', ') || '—'} | ${flags || 'ok'} |`;
  });
  return [
    '| SQL | EXPLAIN QUERY PLAN | index | flags |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}
