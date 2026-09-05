import {
  addUsage,
  computeCost,
  COST_COMPONENT_UNITS,
  COST_COMPONENTS,
  COST_OPTIMIZATION_CATALOG,
  DEFAULT_RATE_CARD,
  scaleUsage,
  suggestOptimizations,
  ZERO_USAGE,
  type CostBreakdown,
  type CostComponent,
  type RateCard,
  type UsageQuantities,
} from "../../src/costModel.js";
import type { Failure, Family, Replay } from "./campaign.js";
import { bump, stableJson } from "./campaign.js";
import type { Rng } from "./rng.js";

/**
 * Family `cost`: sequences of addUsage / scaleUsage / computeCost /
 * suggestOptimizations over a running usage accumulator with legal and
 * near-legal quantities (boundaries, huge, negative, NaN, ±Infinity).
 *
 * Invariants (from `packages/analytics/src/costModel.ts` doc comments):
 *
 *  C-NO-THROW-LEGAL   legal (finite, ≥ 0) quantities / factors never throw
 *  C-INVALID-THROWS   negative or non-finite quantities throw
 *                     `cost_model.invalid_quantity`; negative/non-finite scale
 *                     factors throw `cost_model.invalid_scale_factor`
 *  C-SHAPE            components in COST_COMPONENTS order; unit/quantity/rate
 *                     echoed; every microUsd an integer; totalMicroUsd the exact
 *                     integer sum; totalUsdFormatted derived from the total
 *  C-FINITE           microUsd / totalMicroUsd are finite for finite input
 *  C-MONOTONE         adding non-negative usage never lowers any component cost
 *  C-LINEAR           |cost(a+b) − cost(a) − cost(b)| ≤ #components (rounding)
 *  C-ALGEBRA          addUsage is commutative with ZERO_USAGE identity;
 *                     scaleUsage(u,1) == u; scaleUsage(u,0) == ZERO_USAGE
 *  C-SUGGEST          suggestions ⊆ catalog, unique, only for components with
 *                     microUsd > 0, sorted by descending component cost, and
 *                     every one carries preservesCoreCorrectness === true
 */

export const COST_INVARIANTS = [
  "C-NO-THROW-LEGAL",
  "C-INVALID-THROWS",
  "C-SHAPE",
  "C-FINITE",
  "C-MONOTONE",
  "C-LINEAR",
  "C-ALGEBRA",
  "C-SUGGEST",
] as const;

export type CostOp =
  | { op: "reset" }
  | { op: "card"; card: RateCard | "default" }
  | { op: "add"; usage: UsageQuantities }
  | { op: "scale"; factor: number }
  | { op: "cost" }
  | { op: "suggest" }
  | { op: "algebra"; other: UsageQuantities };

const REALISTIC_MAX: Record<CostComponent, number> = {
  device_compute: 600_000,
  bandwidth: 5_000,
  storage: 50_000,
  media_processing: 300_000,
  server_cpu: 600_000,
  server_gpu: 60_000,
  coach_review: 600,
};

function quantity(rng: Rng, component: CostComponent, adversarial: boolean): number {
  if (adversarial) {
    return rng.pick([
      -1,
      -1e-9,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE,
      1e300,
      -0,
      Number.MIN_VALUE,
      2 ** 53,
    ]);
  }
  const max = REALISTIC_MAX[component];
  return rng.weighted<number>([
    [70, Math.round(rng.next() * max * 1000) / 1000],
    [10, 0],
    [10, rng.int(0, 10)],
    [10, 0.5],
  ]);
}

function usage(rng: Rng, adversarialChance: number): UsageQuantities {
  const out: Record<CostComponent, number> = { ...ZERO_USAGE };
  for (const component of COST_COMPONENTS) {
    out[component] = quantity(rng, component, rng.chance(adversarialChance));
  }
  return out;
}

function rateCard(rng: Rng): RateCard {
  return Object.fromEntries(
    COST_COMPONENTS.map((component) => [
      component,
      {
        usdPerUnit: rng.chance(0.15) ? 0 : Math.round(rng.next() * 10 * 1e6) / 1e6,
        provenance: "assumption" as const,
      },
    ]),
  ) as RateCard;
}

export function generateCostOps(rng: Rng, length: number): CostOp[] {
  const ops: CostOp[] = [{ op: "reset" }];
  while (ops.length < length) {
    const kind = rng.weighted<CostOp["op"]>([
      [30, "add"],
      [12, "scale"],
      [22, "cost"],
      [12, "suggest"],
      [12, "algebra"],
      [6, "card"],
      [6, "reset"],
    ]);
    switch (kind) {
      case "reset":
        ops.push({ op: "reset" });
        break;
      case "card":
        ops.push({ op: "card", card: rng.chance(0.5) ? "default" : rateCard(rng) });
        break;
      case "add":
        ops.push({ op: "add", usage: usage(rng, 0.04) });
        break;
      case "scale":
        ops.push({
          op: "scale",
          factor: rng.weighted<number>([
            [60, Math.round(rng.next() * 40 * 1000) / 1000],
            [10, 1],
            [10, 0],
            [8, Number.NaN],
            [6, -1],
            [6, Number.POSITIVE_INFINITY],
          ]),
        });
        break;
      case "cost":
        ops.push({ op: "cost" });
        break;
      case "suggest":
        ops.push({ op: "suggest" });
        break;
      case "algebra":
        ops.push({ op: "algebra", other: usage(rng, 0) });
        break;
    }
  }
  return ops;
}

function isLegalUsage(u: UsageQuantities): boolean {
  return COST_COMPONENTS.every((c) => Number.isFinite(u[c]) && u[c] >= 0);
}

function sameUsage(a: UsageQuantities, b: UsageQuantities): boolean {
  return COST_COMPONENTS.every((c) => Object.is(a[c], b[c]) || a[c] === b[c]);
}

function checkShape(breakdown: CostBreakdown, usageIn: UsageQuantities, card: RateCard): string[] {
  const problems: string[] = [];
  if (breakdown.components.length !== COST_COMPONENTS.length)
    problems.push(`components ${breakdown.components.length}`);
  let sum = 0;
  breakdown.components.forEach((c, i) => {
    if (c.component !== COST_COMPONENTS[i]) problems.push(`order [${i}] ${c.component}`);
    if (c.unit !== COST_COMPONENT_UNITS[c.component])
      problems.push(`${c.component} unit ${c.unit}`);
    if (c.quantity !== usageIn[c.component])
      problems.push(`${c.component} quantity ${c.quantity} != ${usageIn[c.component]}`);
    if (c.usdPerUnit !== card[c.component].usdPerUnit)
      problems.push(`${c.component} rate ${c.usdPerUnit}`);
    if (c.provenance !== card[c.component].provenance)
      problems.push(`${c.component} provenance ${c.provenance}`);
    if (Number.isFinite(c.microUsd) && !Number.isInteger(c.microUsd))
      problems.push(`${c.component} microUsd ${c.microUsd} not integer`);
    sum += c.microUsd;
  });
  if (breakdown.totalMicroUsd !== sum)
    problems.push(`total ${breakdown.totalMicroUsd} != Σ ${sum}`);
  const expectedFormatted = `$${(breakdown.totalMicroUsd / 1_000_000).toFixed(6)}`;
  if (breakdown.totalUsdFormatted !== expectedFormatted)
    problems.push(`formatted ${breakdown.totalUsdFormatted} != ${expectedFormatted}`);
  return problems;
}

export async function runCostOps(ops: readonly CostOp[]): Promise<Replay> {
  const failures: Failure[] = [];
  const trace: string[] = [];
  const coverage: Record<string, number> = {};
  const fail = (invariant: string, step: number, detail: string) =>
    failures.push({ invariant, step, detail });

  let current: UsageQuantities = ZERO_USAGE;
  let card: RateCard = DEFAULT_RATE_CARD;
  let lastBreakdown: CostBreakdown | null = null;
  let lastBreakdownUsage: UsageQuantities | null = null;

  const safeCost = (u: UsageQuantities, step: number): CostBreakdown | null => {
    const legal = isLegalUsage(u);
    try {
      const breakdown = computeCost(u, card);
      bump(coverage, legal ? "computeCost.legal.ok" : "computeCost.invalid.accepted");
      if (!legal) {
        fail(
          "C-INVALID-THROWS",
          step,
          `computeCost accepted ${stableJson(u)} → total ${breakdown.totalMicroUsd}`,
        );
        return null;
      }
      const problems = checkShape(breakdown, u, card);
      if (problems.length > 0) fail("C-SHAPE", step, problems.join("; "));
      const nonFinite = breakdown.components
        .filter((c) => !Number.isFinite(c.microUsd))
        .map((c) => `${c.component}=${c.microUsd}(q=${c.quantity})`);
      if (nonFinite.length > 0 || !Number.isFinite(breakdown.totalMicroUsd)) {
        fail(
          "C-FINITE",
          step,
          `non-finite cost: ${nonFinite.join(",")} total=${breakdown.totalMicroUsd} formatted=${breakdown.totalUsdFormatted}`,
        );
      }
      return breakdown;
    } catch (error) {
      const message = String(error);
      bump(coverage, legal ? "computeCost.legal.threw" : "computeCost.invalid.rejected");
      if (legal) {
        fail("C-NO-THROW-LEGAL", step, `computeCost(${stableJson(u)}) threw ${message}`);
      } else if (!message.includes("cost_model.invalid_quantity")) {
        fail("C-INVALID-THROWS", step, `wrong error for ${stableJson(u)}: ${message}`);
      }
      return null;
    }
  };

  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    if (!op) continue;
    try {
      switch (op.op) {
        case "reset":
          current = ZERO_USAGE;
          lastBreakdown = null;
          lastBreakdownUsage = null;
          trace.push("reset");
          break;
        case "card":
          card = op.card === "default" ? DEFAULT_RATE_CARD : op.card;
          lastBreakdown = null;
          lastBreakdownUsage = null;
          trace.push(`card ${op.card === "default" ? "default" : stableJson(op.card)}`);
          break;
        case "add": {
          const next = addUsage(current, op.usage);
          trace.push(`add ${stableJson(op.usage)} → ${stableJson(next)}`);
          for (const c of COST_COMPONENTS) {
            const expected = current[c] + op.usage[c];
            if (!Object.is(next[c], expected) && next[c] !== expected)
              fail("C-ALGEBRA", step, `add ${c}: ${next[c]} != ${expected}`);
          }
          const before = isLegalUsage(current) ? safeCost(current, step) : null;
          current = next;
          const after = isLegalUsage(current) ? safeCost(current, step) : null;
          if (before && after && isLegalUsage(op.usage)) {
            before.components.forEach((c, i) => {
              const a = after.components[i];
              if (a && a.microUsd < c.microUsd)
                fail(
                  "C-MONOTONE",
                  step,
                  `${c.component} ${c.microUsd} → ${a.microUsd} after adding ${op.usage[c.component]}`,
                );
            });
            const delta = safeCost(op.usage, step);
            if (delta && after.totalMicroUsd <= Number.MAX_SAFE_INTEGER) {
              bump(coverage, "add.linearityChecked");
              const gap = Math.abs(
                after.totalMicroUsd - before.totalMicroUsd - delta.totalMicroUsd,
              );
              if (gap > COST_COMPONENTS.length)
                fail(
                  "C-LINEAR",
                  step,
                  `|${after.totalMicroUsd} − ${before.totalMicroUsd} − ${delta.totalMicroUsd}| = ${gap}`,
                );
            }
          }
          break;
        }
        case "scale": {
          const legal = Number.isFinite(op.factor) && op.factor >= 0;
          try {
            const next = scaleUsage(current, op.factor);
            trace.push(`scale ${op.factor} → ${stableJson(next)}`);
            bump(coverage, legal ? "scale.legal.ok" : "scale.invalid.accepted");
            if (!legal) {
              fail("C-INVALID-THROWS", step, `scaleUsage accepted factor ${op.factor}`);
              break;
            }
            for (const c of COST_COMPONENTS) {
              const expected = current[c] * op.factor;
              if (!Object.is(next[c], expected) && next[c] !== expected)
                fail("C-ALGEBRA", step, `scale ${c}: ${next[c]} != ${expected}`);
            }
            if (op.factor === 1 && !sameUsage(next, current))
              fail("C-ALGEBRA", step, `scale(u,1) != u: ${stableJson(next)}`);
            if (op.factor === 0 && isLegalUsage(current) && !sameUsage(next, ZERO_USAGE))
              fail("C-ALGEBRA", step, `scale(u,0) != ZERO: ${stableJson(next)}`);
            current = next;
          } catch (error) {
            const message = String(error);
            trace.push(`scale ${op.factor} threw`);
            bump(coverage, legal ? "scale.legal.threw" : "scale.invalid.rejected");
            if (legal)
              fail(
                "C-NO-THROW-LEGAL",
                step,
                `scaleUsage(${stableJson(current)}, ${op.factor}) threw ${message}`,
              );
            else if (!message.includes("cost_model.invalid_scale_factor"))
              fail("C-INVALID-THROWS", step, `wrong error for factor ${op.factor}: ${message}`);
          }
          break;
        }
        case "cost": {
          const breakdown = safeCost(current, step);
          trace.push(`cost ${breakdown ? breakdown.totalMicroUsd : "throw"}`);
          if (breakdown) {
            if (
              lastBreakdown &&
              lastBreakdownUsage &&
              sameUsage(lastBreakdownUsage, current) &&
              stableJson(lastBreakdown) !== stableJson(breakdown)
            ) {
              fail(
                "C-SHAPE",
                step,
                `computeCost not deterministic for same usage: ${stableJson(lastBreakdown)} vs ${stableJson(breakdown)}`,
              );
            }
            lastBreakdown = breakdown;
            lastBreakdownUsage = current;
          }
          break;
        }
        case "suggest": {
          const breakdown = safeCost(current, step);
          if (!breakdown) {
            trace.push("suggest skipped");
            break;
          }
          const suggestions = suggestOptimizations(breakdown);
          trace.push(`suggest ${suggestions.map((s) => s.id).join(",")}`);
          bump(coverage, "suggest.calls");
          bump(coverage, "suggest.items", suggestions.length);
          const costOf = new Map(breakdown.components.map((c) => [c.component, c.microUsd]));
          const problems: string[] = [];
          const ids = new Set<string>();
          suggestions.forEach((s, i) => {
            if (!COST_OPTIMIZATION_CATALOG.includes(s)) problems.push(`${s.id} not in catalog`);
            if (ids.has(s.id)) problems.push(`duplicate ${s.id}`);
            ids.add(s.id);
            if (s.preservesCoreCorrectness !== true)
              problems.push(`${s.id} preservesCoreCorrectness`);
            if ((costOf.get(s.targetComponent) ?? 0) <= 0)
              problems.push(`${s.id} for zero-cost ${s.targetComponent}`);
            const prev = suggestions[i - 1];
            if (
              prev &&
              (costOf.get(prev.targetComponent) ?? 0) < (costOf.get(s.targetComponent) ?? 0)
            )
              problems.push(`order ${prev.id} < ${s.id}`);
          });
          for (const entry of COST_OPTIMIZATION_CATALOG) {
            if ((costOf.get(entry.targetComponent) ?? 0) > 0 && !ids.has(entry.id))
              problems.push(`missing ${entry.id}`);
          }
          if (problems.length > 0) fail("C-SUGGEST", step, problems.join("; "));
          break;
        }
        case "algebra": {
          const ab = addUsage(current, op.other);
          const ba = addUsage(op.other, current);
          const withZero = addUsage(current, ZERO_USAGE);
          trace.push(`algebra ${stableJson(ab)}`);
          if (!sameUsage(ab, ba))
            fail("C-ALGEBRA", step, `add not commutative: ${stableJson(ab)} vs ${stableJson(ba)}`);
          if (!sameUsage(withZero, current)) {
            fail(
              "C-ALGEBRA",
              step,
              `add(u, ZERO) != u: ${stableJson(withZero)} vs ${stableJson(current)}`,
            );
          }
          break;
        }
      }
    } catch (error) {
      fail("C-NO-THROW-LEGAL", step, `${op.op} threw unexpectedly ${String(error)}`);
    }
  }
  await Promise.resolve();
  return { trace: trace.join("\n"), failures, coverage };
}

export const costFamily: Family<CostOp> = {
  name: "cost",
  generate: generateCostOps,
  run: runCostOps,
};
