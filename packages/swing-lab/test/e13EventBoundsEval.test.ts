import { describe, expect, it } from "vitest";
import { runE13EventBoundsEval } from "../src/e13EventBoundsEval.js";

// Regression fixture: replays the production proposer (stroke-event-2) over
// the committed runs-wave-a windowed runDirs and locks the measured outcome
// against the D2-07 event-bounds gold (12 records: 7 events / 5 non-events).
// If proposer or matching behavior changes, these assertions surface it —
// they are a measurement lock, not a quality target.
describe("e13 event-bounds eval vs D2-07 gold (regression fixture)", () => {
  const { perBundle, eventRows, nonEventRows } = runE13EventBoundsEval();

  it("replays all 3 bundles from wrist-sourced proposals", () => {
    expect(perBundle.map((entry) => entry.bundle)).toEqual([
      "wavea-marne-serve",
      "wavea-wgm-wheelchair",
      "wavea-sasebo-volleys",
    ]);
    for (const entry of perBundle) expect(entry.proposalSource).toBe("wrist");
  });

  it("scores 7 gold events and 5 non-events", () => {
    expect(eventRows).toHaveLength(7);
    expect(nonEventRows).toHaveLength(5);
  });

  it("target recall is 3/5 with the two rapid-volley misses attributed", () => {
    const target = eventRows.filter((row) => row.owner === "target");
    expect(target).toHaveLength(5);
    const okIds = target
      .filter((row) => row.outcome === "PROPOSED_OK")
      .map((row) => row.recordId)
      .sort();
    expect(okIds).toEqual([
      "wavea-marne-serve-drop-serve-1",
      "wavea-sasebo-volleys-far-black-2",
      "wavea-wgm-wheelchair-backhand-lift-1",
    ]);
    const missed = target.filter((row) => row.outcome === "MISSED");
    expect(missed.map((row) => row.recordId).sort()).toEqual([
      "wavea-sasebo-volleys-far-black-1",
      "wavea-sasebo-volleys-far-black-3",
    ]);
    for (const row of missed) {
      expect(row.forensics).not.toBeNull();
      expect(row.forensics!.attribution).toBe("WRIST_SIGNAL_QUALITY");
    }
  });

  it("gold contact lies inside every matched proposal (±60ms)", () => {
    const scored = eventRows.filter((row) => row.contactInside !== null);
    expect(scored).toHaveLength(3);
    for (const row of scored) expect(row.contactInside).toBe(true);
  });

  it("produces zero false positives on the 5 explicit non-events", () => {
    for (const row of nonEventRows) {
      expect(row.falsePositive).toBe(false);
      expect(row.overlappingUnmatchedProposals).toHaveLength(0);
    }
  });

  it("attaches forensics to every non-PROPOSED_OK row", () => {
    for (const row of eventRows) {
      if (row.outcome === "PROPOSED_OK") expect(row.forensics).toBeNull();
      else expect(row.forensics).not.toBeNull();
    }
  });
});
