/**
 * Wall-clock reader for the instants written into a durable analysis record.
 *
 * A record is verified against itself: it must not claim to have been
 * produced before the capture (or the tap) it describes, and each model run
 * must complete no later than the record is created. The device clock gives
 * no such guarantee — an NTP correction, a time-zone repair or a manual
 * change between capture and commit steps it backwards, and a record stamped
 * by a raw `new Date()` would then be rejected for a reason unrelated to the
 * analysis it carries. This clock returns the later of the real time and a
 * floor (the provenance instants already inside the record, plus every
 * instant it has handed out), so record timestamps stay monotonic and never
 * precede what they depend on. It never runs ahead of the real clock unless
 * the floor already does.
 */
export function recordClock(
  floorIsos: ReadonlyArray<string | null | undefined>,
  now: () => number = Date.now,
): () => string {
  let floorMs = Number.NEGATIVE_INFINITY;
  for (const iso of floorIsos) {
    if (typeof iso !== 'string') continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > floorMs) floorMs = ms;
  }
  return () => {
    floorMs = Math.max(now(), floorMs);
    return new Date(floorMs).toISOString();
  };
}
