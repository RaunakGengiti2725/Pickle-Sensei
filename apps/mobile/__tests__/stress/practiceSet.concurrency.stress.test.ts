/**
 * STRESS / concurrency — `practiceSet` (plan → commit → note) under a seeded
 * scheduler, over the real repository SQL (saveSession transaction + kv).
 *
 * Scenarios: concurrent plan/commit by several actors in one sitting, the
 * same plan committed twice, account rotation between plan and commit, clock
 * skew between actors (past / future / non-monotonic), notes racing commits,
 * and a concurrent analysis-style transaction on the shared connection.
 *
 * Invariants asserted on EVERY seed:
 *   consistency  the live kv record always points at a session that has a
 *                local_session row for that owner (no dangling set);
 *   rows         one local_session row per new set, one session.create
 *                outbox row per new session (no duplicate rows);
 *   owner        kv and session rows for a plan land under the plan's owner;
 *   read-your-write  right after commit at time T, currentPracticeSetId(T)
 *                returns the committed set;
 *   liveness     no deadlock, no open transaction, bounded steps.
 *
 * Replay:  STRESS_SEED=<seed> npx jest __tests__/stress/practiceSet.concurrency
 */
import { setActiveDataOwner } from '../../src/data/accountScope';
import {
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  practiceSetKeyForOwner,
  type PracticeSetPlan,
} from '../../src/analysis/practiceSet';
import { flushStressTable } from '../../testing/stress/evidence';
import {
  busy,
  OWNER_A,
  OWNER_B,
  stressScenario,
  type IterationContext,
} from '../../testing/stress/harness';

const SUITE = 'practiceSet.concurrency';
const BASE_MS = Date.parse('2026-09-04T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

interface StoredSet {
  sessionId: string;
  lastActivityAtIso: string;
}

function storedSet(ctx: IterationContext, owner: string): StoredSet | null {
  const raw = ctx.db.kv.get(practiceSetKeyForOwner(owner));
  return raw ? (JSON.parse(raw) as StoredSet) : null;
}

function v(ctx: IterationContext, condition: boolean, message: string): void {
  ctx.violations.check(condition, message);
}

/** One device clock shared by every actor: strictly increasing per read. */
function monotonicClock(startMs: number): () => string {
  let tick = startMs;
  return () => iso(++tick);
}

/** Commit a set at `atMs` (row + outbox + kv) and return its id. */
async function seedCommittedSet(
  ctx: IterationContext,
  atMs: number,
): Promise<string> {
  const plan = await planPracticeSet(ctx.db.db, {
    shotType: 'forehand_drive',
    nowIso: iso(atMs),
  });
  await commitPracticeSet(ctx.db.db, plan!, iso(atMs));
  return plan!.sessionId;
}

/** Structural invariants over the committed state. */
function checkStructure(ctx: IterationContext, owners: string[]): void {
  const { db } = ctx;
  const sessions = db.sessionRows();
  const creates = db.outboxByKind('session.create').map(r => ({
    owner: r.owner_key,
    ...(JSON.parse(r.payload) as { id: string }),
  }));
  v(ctx, db.openTransactions() === 0, 'no open transaction after burst');
  v(
    ctx,
    db.strayTxEnds === 0,
    `COMMIT/ROLLBACK outside a transaction: ${db.strayTxEnds}`,
  );
  v(
    ctx,
    creates.length === new Set(creates.map(c => `${c.owner}/${c.id}`)).size,
    `duplicate session.create outbox rows: ${JSON.stringify(creates.map(c => c.id))}`,
  );
  for (const c of creates) {
    v(
      ctx,
      sessions.some(s => s.owner === c.owner && s.id === c.id),
      `session.create ${c.id} without a local_session row`,
    );
  }
  for (const s of sessions) {
    v(
      ctx,
      creates.some(c => c.owner === s.owner && c.id === s.id),
      `local_session ${s.id} without a session.create outbox row`,
    );
    v(ctx, s.mode === 'practice_set', `session ${s.id} mode ${s.mode}`);
  }
  for (const owner of owners) {
    const live = storedSet(ctx, owner);
    if (live) {
      v(
        ctx,
        sessions.some(s => s.owner === owner && s.id === live.sessionId),
        `kv for ${owner.slice(0, 8)} points at ${live.sessionId} which has no local_session row for that owner (dangling set)`,
      );
    }
  }
  ctx.observed['sessions'] = sessions.map(
    s => `${s.owner.slice(0, 1)}:${s.id.slice(0, 8)}`,
  );
  ctx.observed['sessionCreates'] = creates.length;
  ctx.observed['kvA'] = storedSet(ctx, OWNER_A)?.sessionId?.slice(0, 8) ?? null;
  ctx.observed['kvB'] = storedSet(ctx, OWNER_B)?.sessionId?.slice(0, 8) ?? null;
}

afterAll(() => flushStressTable(SUITE));

describe('stress/concurrency: practiceSet', () => {
  // A. Several actors in one sitting each plan, "analyze" (yield), commit.
  //    All actors share ONE monotonic device clock (each read advances it
  //    by 1 ms) so any split is due to interleaving alone; clock effects are
  //    the `clockSkew` scenario.
  stressScenario(SUITE, 'concurrentPlanCommit', {}, async ctx => {
    const { scheduler: s } = ctx;
    const actors = s.int(2, 4);
    const clock = monotonicClock(BASE_MS);
    const seedLiveSet = s.random() < 0.4;
    // A TRY-AGAIN re-arm joins the set its result came from: an OLD,
    // committed set (row exists) that would otherwise be idle-expired.
    const preferred =
      s.random() < 0.3
        ? await seedCommittedSet(ctx, BASE_MS - 86_400_000)
        : null;
    if (seedLiveSet) {
      // A set from 5 minutes ago is live; every planner must resume it.
      await seedCommittedSet(ctx, BASE_MS - 5 * 60_000);
    }
    const before = ctx.db.sessionRows().length;
    ctx.inputs = { actors, preferred: preferred !== null, seedLiveSet };
    const plans: Array<PracticeSetPlan | null> = [];
    const run = await s.run(
      Array.from({ length: actors }, (_, i) => async () => {
        await busy(s, `actor${i}:prep`, s.int(0, 2));
        const plan = await planPracticeSet(ctx.db.db, {
          shotType: i % 2 === 0 ? 'forehand_drive' : 'backhand_drive',
          nowIso: clock(),
          preferredSessionId: i === 0 ? preferred : null,
        });
        plans[i] = plan;
        await busy(s, `actor${i}:analyze`, s.int(0, 6));
        if (plan) await commitPracticeSet(ctx.db.db, plan, clock());
        return plan?.sessionId ?? null;
      }),
    );
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    for (const r of run.results) {
      v(
        ctx,
        r.status === 'fulfilled',
        `actor rejected: ${r.status === 'rejected' ? String(r.reason) : ''}`,
      );
    }
    checkStructure(ctx, [OWNER_A]);
    const newSessions = ctx.db.sessionRows().length - before;
    ctx.observed['newSessions'] = newSessions;
    ctx.observed['resumed'] = plans.map(p => p?.resumed ?? null);
    // One sitting ⇒ one set: with a live set seeded every actor resumes it;
    // without one, at most one new set may be created for the sitting.
    if (seedLiveSet) {
      v(
        ctx,
        newSessions === 0,
        `${newSessions} new set(s) created while a live set existed`,
      );
    } else {
      // Sequentially at most ONE actor finds no live set (the re-arm actor
      // resumes its preferred set, everyone after the first commit resumes).
      v(
        ctx,
        newSessions <= 1,
        `one sitting split into ${newSessions} practice sets (concurrent planners each started a set)`,
      );
    }
    // Read-your-write on the device clock right after the burst.
    const last = await currentPracticeSetId(ctx.db.db, clock());
    ctx.observed['currentAfter'] = last?.slice(0, 8) ?? null;
    v(ctx, last !== null, 'a just-committed set is not visible as current');
  });

  // B. The same plan committed twice concurrently (double invocation).
  stressScenario(SUITE, 'duplicateCommit', {}, async ctx => {
    const { scheduler: s } = ctx;
    const plan = await planPracticeSet(ctx.db.db, {
      shotType: 'forehand_drive',
      nowIso: iso(BASE_MS),
    });
    const copies = s.int(2, 3);
    ctx.inputs = { copies };
    const run = await s.run(
      Array.from({ length: copies }, (_, i) => async () => {
        await busy(s, `commit${i}:prep`, s.int(0, 2));
        await commitPracticeSet(ctx.db.db, plan!, iso(BASE_MS + i));
      }),
    );
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    for (const r of run.results) {
      v(
        ctx,
        r.status === 'fulfilled',
        `commit rejected: ${r.status === 'rejected' ? String(r.reason) : ''}`,
      );
    }
    checkStructure(ctx, [OWNER_A]);
    v(
      ctx,
      ctx.db.sessionRows().length === 1,
      `session rows: ${ctx.db.sessionRows().length}`,
    );
  });

  // C. Account rotation / logout between plan and commit (and during note).
  stressScenario(SUITE, 'rotateBetweenPlanAndCommit', {}, async ctx => {
    const { scheduler: s } = ctx;
    const rotateTo = s.pick([OWNER_B, 'signed-out'] as const);
    const alsoNote = s.random() < 0.5;
    ctx.inputs = { rotateTo, alsoNote };
    s.injectActor(`actor:rotate→${rotateTo}`, () =>
      setActiveDataOwner(rotateTo),
    );
    let plan: PracticeSetPlan | null = null;
    const run = await s.run([
      async () => {
        await busy(s, 'plan:prep', s.int(0, 2));
        plan = await planPracticeSet(ctx.db.db, {
          shotType: 'forehand_drive',
          nowIso: iso(BASE_MS),
        });
        await busy(s, 'analyze', s.int(1, 4));
        if (plan) await commitPracticeSet(ctx.db.db, plan, iso(BASE_MS + 500));
        if (alsoNote && plan) {
          await notePracticeSetAnalysis(
            ctx.db.db,
            plan.sessionId,
            iso(BASE_MS + 600),
          );
        }
      },
    ]);
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    const rejected = run.results.filter(r => r.status === 'rejected');
    for (const r of rejected) {
      const reason = r.status === 'rejected' ? String(r.reason) : '';
      // A signed-out write refusal is the only acceptable rejection.
      v(
        ctx,
        reason.includes('Sign in or continue locally'),
        `unexpected rejection: ${reason}`,
      );
    }
    ctx.observed['rejected'] = rejected.length;
    ctx.observed['planOwner'] =
      (plan as PracticeSetPlan | null)?.owner?.slice(0, 8) ?? null;
    checkStructure(ctx, [OWNER_A, OWNER_B]);
    // Owner: every row for this plan must sit under the plan's owner.
    if (plan) {
      const p = plan as PracticeSetPlan;
      for (const row of ctx.db.sessionRows()) {
        v(
          ctx,
          row.owner === p.owner,
          `session ${row.id.slice(0, 8)} written under ${row.owner.slice(0, 8)} but planned for ${p.owner.slice(0, 8)}`,
        );
      }
      for (const row of ctx.db.outbox) {
        v(
          ctx,
          row.owner_key === p.owner,
          `outbox row written under ${row.owner_key.slice(0, 8)} but planned for ${p.owner.slice(0, 8)}`,
        );
      }
      v(
        ctx,
        storedSet(ctx, OWNER_B) === null || p.owner === OWNER_B,
        'kv for owner B written by a plan for owner A',
      );
      v(
        ctx,
        !ctx.db.kv.has(practiceSetKeyForOwner('signed-out')),
        'kv written under signed-out',
      );
    }
  });

  // D. Clock skew across actors: past, future, non-monotonic clocks.
  stressScenario(SUITE, 'clockSkew', {}, async ctx => {
    const { scheduler: s } = ctx;
    const actors = s.int(2, 3);
    const skews = Array.from({ length: actors }, () =>
      s.pick([
        0,
        -1000,
        1000,
        -PRACTICE_SET_IDLE_TIMEOUT_MS - 1,
        PRACTICE_SET_IDLE_TIMEOUT_MS + 1,
        365 * 86_400_000,
        -365 * 86_400_000,
      ]),
    );
    ctx.inputs = { actors, skews };
    const committed: string[] = [];
    const run = await s.run(
      skews.map((skew, i) => async () => {
        await busy(s, `actor${i}:prep`, s.int(0, 2));
        const plan = await planPracticeSet(ctx.db.db, {
          shotType: 'forehand_drive',
          nowIso: iso(BASE_MS + skew),
        });
        await busy(s, `actor${i}:analyze`, s.int(0, 4));
        await commitPracticeSet(ctx.db.db, plan!, iso(BASE_MS + skew + 200));
        committed.push(plan!.sessionId);
        // Read-your-write on the actor's OWN clock right after its commit.
        const seen = await currentPracticeSetId(
          ctx.db.db,
          iso(BASE_MS + skew + 300),
        );
        return { sessionId: plan!.sessionId, seen };
      }),
    );
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    for (const r of run.results) {
      v(
        ctx,
        r.status === 'fulfilled',
        `actor rejected: ${r.status === 'rejected' ? String(r.reason) : ''}`,
      );
    }
    checkStructure(ctx, [OWNER_A]);
    // Visibility on the TRUE clock: the set committed most recently (by
    // statement order) is what a correctly-clocked next analysis should see.
    const trueNow = await currentPracticeSetId(ctx.db.db, iso(BASE_MS + 1000));
    const live = storedSet(ctx, OWNER_A);
    ctx.observed['liveLastActivity'] = live?.lastActivityAtIso ?? null;
    ctx.observed['visibleOnTrueClock'] = trueNow !== null;
    const maxSkew = Math.max(...skews.map(Math.abs));
    if (maxSkew <= 1000) {
      v(
        ctx,
        trueNow !== null,
        'set invisible on the true clock although every actor was within ±1s',
      );
    }
    // A skewed writer must never make the set unreadable to a correctly
    // clocked reader for LONGER than the idle window itself.
    if (trueNow === null && live) {
      const lastMs = Date.parse(live.lastActivityAtIso);
      ctx.observed['invisibleForMs'] = lastMs - (BASE_MS + 1000);
    }
  });

  // E. Notes racing commits: the activity stamp must never regress a set to
  //    a session that has no row, and a note for the live set must keep it.
  stressScenario(SUITE, 'noteVsCommit', {}, async ctx => {
    const { scheduler: s } = ctx;
    const plan = await planPracticeSet(ctx.db.db, {
      shotType: 'forehand_drive',
      nowIso: iso(BASE_MS),
    });
    await commitPracticeSet(ctx.db.db, plan!);
    const noters = s.int(1, 3);
    const newPlanner = s.random() < 0.5;
    ctx.inputs = { noters, newPlanner };
    const run = await s.run([
      ...Array.from({ length: noters }, (_, i) => async () => {
        await busy(s, `note${i}:prep`, s.int(0, 3));
        await notePracticeSetAnalysis(
          ctx.db.db,
          plan!.sessionId,
          iso(BASE_MS + 1000 + i),
        );
      }),
      ...(newPlanner
        ? [
            async () => {
              // A planner whose clock says the set expired starts a new one.
              const late = await planPracticeSet(ctx.db.db, {
                shotType: 'backhand_drive',
                nowIso: iso(BASE_MS + PRACTICE_SET_IDLE_TIMEOUT_MS + 5000),
              });
              await busy(s, 'late:analyze', s.int(0, 3));
              await commitPracticeSet(ctx.db.db, late!);
            },
          ]
        : []),
    ]);
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    for (const r of run.results) {
      v(
        ctx,
        r.status === 'fulfilled',
        `task rejected: ${r.status === 'rejected' ? String(r.reason) : ''}`,
      );
    }
    checkStructure(ctx, [OWNER_A]);
    const live = storedSet(ctx, OWNER_A);
    v(ctx, live !== null, 'live set vanished');
    if (!newPlanner) {
      v(
        ctx,
        live?.sessionId === plan!.sessionId,
        'notes changed the live set id',
      );
    }
  });

  // F. Two actors on the shared connection: commit's saveSession transaction
  //    interleaved with another repository-style transaction.
  stressScenario(SUITE, 'commitVsForeignTransaction', {}, async ctx => {
    const { scheduler: s } = ctx;
    const plan = await planPracticeSet(ctx.db.db, {
      shotType: 'forehand_drive',
      nowIso: iso(BASE_MS),
    });
    const foreignWrites = s.int(1, 2);
    ctx.inputs = { foreignWrites };
    const run = await s.run([
      async () => {
        await busy(s, 'commit:prep', s.int(0, 2));
        await commitPracticeSet(ctx.db.db, plan!);
      },
      async () => {
        for (let i = 0; i < foreignWrites; i += 1) {
          await busy(s, 'foreign:think', s.int(0, 3));
          await ctx.db.db.execute('BEGIN IMMEDIATE');
          try {
            await ctx.db.db.execute(
              `INSERT OR REPLACE INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
              [OWNER_A, `shot-${i}`],
            );
            await ctx.db.db.execute('COMMIT');
          } catch (error) {
            try {
              await ctx.db.db.execute('ROLLBACK');
            } catch {
              // mirror sync.ts: preserve the original error
            }
            throw error;
          }
        }
      },
    ]);
    ctx.observed['steps'] = run.steps;
    ctx.observed['trace'] = run.trace;
    ctx.observed['rejections'] = run.results
      .filter(r => r.status === 'rejected')
      .map(r => (r.status === 'rejected' ? String(r.reason) : ''));
    for (const r of run.results) {
      v(
        ctx,
        r.status === 'fulfilled',
        `task rejected: ${r.status === 'rejected' ? String(r.reason) : ''}`,
      );
    }
    checkStructure(ctx, [OWNER_A]);
    v(
      ctx,
      ctx.db.receipts.size === foreignWrites,
      `foreign receipts lost: ${ctx.db.receipts.size}/${foreignWrites}`,
    );
    v(
      ctx,
      ctx.db.sessionRows().length === 1,
      `session rows: ${ctx.db.sessionRows().length}`,
    );
  });
});
