// Pickle Sensei drill catalog v2 — the seven committed drill-library-v1
// records (verbatim from datasets/coach-review/drills/drill-library.v1.json,
// source of truth packages/swing-lab/src/drillLibrary.ts DRILL_LIBRARY_V1)
// plus an engineering expansion of widely-documented standard pickleball
// drills authored for catalog breadth.
//
// HONESTY CONTRACT: every record is a Tier-C ENGINEERING SEED —
// validationState 'UNVALIDATED', zero coach endorsements, no fault→drill
// prescriptions served (the recommendation gate abstains on all of them).
// Instructional media is attributed third-party video (see drillMedia.ts);
// nothing here may masquerade as coach-validated Pickle Sensei coaching.

export interface CatalogDrillRecord {
  id: string; // deterministic UUID (v5-style over the slug) — stable across deploys
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
  families: string[];
  validation_state: "UNVALIDATED";
}

const COACH_BYLINE = "Engineering draft — not coach-validated";

interface SeedDrill {
  slug: string;
  title: string;
  purpose: string;
  instructions: string[];
  equipment: string[];
  difficulty: string;
  repsOrDuration: string;
  families: string[];
}

/** The seven records below the marker are verbatim from
 * drill-library.v1.json (slug = drillId minus the "drill." namespace so it
 * satisfies the client's slug shape). Records after the EXPANSION marker are
 * engineering-authored descriptions of standard, widely-documented drills. */
const SEEDS: SeedDrill[] = [
  {
    slug: "wall-dink-rally",
    title: "Wall dink rally",
    purpose:
      "Groove out-front contact and a stable paddle face through high-repetition soft dinks.",
    instructions: [
      "Stand 7–8 ft from a wall marked with a net-height line (34 in).",
      "Rally soft dinks continuously above the line, contacting every ball out in front of the body.",
      "Keep the paddle up between contacts; reset to ready after each dink.",
    ],
    equipment: ["paddle", "ball", "wall with net-height line (34 in)"],
    difficulty: "beginner",
    repsOrDuration: "3 × 2 min continuous rally",
    families: ["dink"],
  },
  {
    slug: "dink-target-boxes",
    title: "Dink target boxes",
    purpose:
      "Flatten the dink arc by demanding depth control into kitchen target zones.",
    instructions: [
      "Place two flat targets in the opponent kitchen: one near the sideline, one center.",
      "Cooperative crosscourt dink rally; score a point only when the ball lands in a target.",
      "Emphasize lifting from the legs with a quiet wrist, not scooping upward.",
    ],
    equipment: ["paddle", "balls", "court", "2 flat targets (towels or tape boxes)"],
    difficulty: "intermediate",
    repsOrDuration: "first to 10 target hits, 3 rounds",
    families: ["dink"],
  },
  {
    slug: "volley-wall-ready",
    title: "Volley wall with ready reset",
    purpose:
      "Keep the paddle up and the volley compact: block volleys off a wall with a forced ready reset between contacts.",
    instructions: [
      "Stand 6–7 ft from the wall, paddle at chest height in ready position.",
      "Volley continuously without letting the ball bounce, returning the paddle to ready between every contact.",
      "Keep the swing a compact block — hands finish in front of the shoulders.",
    ],
    equipment: ["paddle", "ball", "wall"],
    difficulty: "beginner",
    repsOrDuration: "4 × 45 s continuous",
    families: ["volley"],
  },
  {
    slug: "shadow-unit-turn",
    title: "Shadow swing: unit turn ladder",
    purpose:
      "Build an early shoulder-hip unit turn on drives through mirror-checked shadow swings, then live feeds.",
    instructions: [
      "Without a ball, rehearse the drive: turn shoulders and hips together as the split-step lands.",
      "Check in a mirror or phone video that the chest faces the sideline before the forward swing.",
      "Progress to dropped-ball feeds, calling 'turn' at the feeder's release.",
    ],
    equipment: ["paddle", "mirror or phone camera", "balls (for the fed stage)"],
    difficulty: "beginner",
    repsOrDuration: "3 × 10 shadow swings + 2 × 10 fed balls",
    families: ["drive"],
  },
  {
    slug: "serve-drop-consistency",
    title: "Serve drop consistency blocks",
    purpose:
      "Stabilize the drop/toss so the serve contact point stops wandering: blocked repetitions with an explicit drop checkpoint.",
    instructions: [
      "Serve in blocks of 10, pausing before each serve to set the same drop height and release point.",
      "Let the ball drop from the same hand position every time; contact below the waist per rules.",
      "Track how many of 10 drops you would rate identical before adding targets.",
    ],
    equipment: ["paddle", "balls", "court"],
    difficulty: "beginner",
    repsOrDuration: "5 × 10 serves",
    families: ["serve"],
  },
  {
    slug: "third-shot-drop-ladder",
    title: "Third-shot drop ladder",
    purpose:
      "Take pace off the third shot: progressive distance ladder that rewards arc and kitchen landings over power.",
    instructions: [
      "Start at the kitchen line dropping balls into the opposite kitchen; step back 3 ft after 5 makes.",
      "Continue the ladder until serving-position drops; restart the rung after 3 consecutive longs.",
      "Focus on lifting with the legs and finishing the paddle toward the target, not across the body.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "ladder to baseline, 2 full climbs",
    families: ["drop_reset"],
  },
  {
    slug: "skinny-singles",
    title: "Skinny singles",
    purpose:
      "Pressure-test whole-point habits (recovery, shot selection) on half the court with full-point consequences.",
    instructions: [
      "Play singles on half the court (straight or crosscourt halves).",
      "Play full points: serve, return, third shot, kitchen play.",
      "Between shots, recover to ready position before the opponent's contact.",
    ],
    equipment: ["paddle", "ball", "court"],
    difficulty: "intermediate",
    repsOrDuration: "games to 7, switch halves",
    families: ["global", "serve", "return", "drive", "dink", "drop_reset"],
  },
  // ─── EXPANSION: engineering-authored standard drills (all UNVALIDATED) ───
  {
    slug: "crosscourt-dink-battle",
    title: "Crosscourt dink battle",
    purpose:
      "Turn cooperative dinking competitive: win kitchen exchanges without popping the ball up.",
    instructions: [
      "Both players at the kitchen line, dinking crosscourt only; the ball must land in the kitchen or within 1 ft behind it.",
      "Play rally-scoring points: a pop-up above net height that gets attacked, a net, or a long ball loses the point.",
      "Recover to ready between every dink; move the opponent with angle changes, not pace.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "games to 11, switch diagonals",
    families: ["dink"],
  },
  {
    slug: "figure-eight-dinks",
    title: "Figure-eight dinks",
    purpose:
      "Alternate straight and crosscourt dinks in a fixed pattern to train direction change with a stable face.",
    instructions: [
      "Player A dinks straight ahead every time; player B dinks crosscourt every time, tracing a figure eight.",
      "Keep every ball unattackable — apex below net height on the opponent's side.",
      "Swap roles each round; add lateral shuffle steps so contact stays out front.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 2 min, swapping roles each round",
    families: ["dink"],
  },
  {
    slug: "dink-speedup-reset-cycle",
    title: "Dink–speedup–reset cycle",
    purpose:
      "Chain the three kitchen touches that decide hands battles: soft dink, controlled speedup, absorbing reset.",
    instructions: [
      "Rally two cooperative dinks, then the designated attacker hits one controlled speedup at the partner's paddle side.",
      "The defender blocks a soft reset into the kitchen and the cycle restarts as a dink rally.",
      "Swap the attacker role each cycle; the speedup must stay in — wild misses restart the count.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "10 clean cycles per attacker, 3 rounds",
    families: ["dink", "volley", "drop_reset"],
  },
  {
    slug: "attackable-ball-recognition",
    title: "Attackable-ball recognition",
    purpose:
      "Train the attack/neutral decision: attack only balls that sit above net height, stay patient on everything else.",
    instructions: [
      "Cooperative dink rally; either player may attack ONLY when the ball would bounce above net height.",
      "Call 'attack' out loud at the moment of the decision, then play the point out.",
      "Log wrong calls (attacking a low ball, letting a sitter go) between rallies.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "3 × 5 min with decision log",
    families: ["dink", "volley"],
  },
  {
    slug: "triangle-dink-movement",
    title: "Triangle dink movement",
    purpose:
      "Move the feet — not the arm — to three kitchen targets so every dink is struck out front.",
    instructions: [
      "Mark three targets in the opponent kitchen: wide forehand, middle, wide backhand.",
      "Feeder dinks anywhere along your kitchen line; you answer to the called target in triangle order.",
      "Shuffle-step so the body arrives before the paddle; no reaching across the body.",
    ],
    equipment: ["paddle", "balls", "court", "3 flat targets"],
    difficulty: "intermediate",
    repsOrDuration: "3 × 12 target hits per direction",
    families: ["dink"],
  },
  {
    slug: "two-touch-soft-hands",
    title: "Two-touch soft hands",
    purpose:
      "Exaggerate absorption: catch the dink on the paddle with a self-bump before returning it, building genuinely soft hands.",
    instructions: [
      "During a cooperative dink rally, bump every incoming ball softly to yourself first, then dink it back (two touches).",
      "Keep both touches below eye level and in front of the body.",
      "Progress to one-touch dinks while keeping the same absorbing feel.",
    ],
    equipment: ["paddle", "ball", "court or wall"],
    difficulty: "beginner",
    repsOrDuration: "3 × 2 min two-touch, 2 min one-touch",
    families: ["dink", "drop_reset"],
  },
  {
    slug: "fast-hands-battle",
    title: "Fast hands battle",
    purpose:
      "Sharpen kitchen-line reflex exchanges: compact counters under real speedup pressure.",
    instructions: [
      "Both players at the kitchen line. One initiates a controlled speedup at the other's paddle-side shoulder.",
      "Play the exchange out at full speed until a miss or an unreturnable ball; keep volleys compact, elbow in front.",
      "Alternate who initiates; balls aimed at the body must still be legal, controlled speedups.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "advanced",
    repsOrDuration: "games to 11 by initiation turns",
    families: ["volley"],
  },
  {
    slug: "volley-dink-out-of-air",
    title: "Volley-dink out of the air",
    purpose:
      "Take the dink early out of the air to steal time, without adding pace or popping it up.",
    instructions: [
      "Partner dinks normally; you answer every ball as a volley-dink out of the air — no bounces on your side.",
      "Contact out front with a nearly still paddle; the ball must still land unattackable in the kitchen.",
      "Swap roles each round; if the volley-dink pops up, the feeder attacks to keep honesty.",
    ],
    equipment: ["paddle", "ball", "court with net"],
    difficulty: "advanced",
    repsOrDuration: "4 × 2 min per role",
    families: ["volley", "dink"],
  },
  {
    slug: "block-volley-defense",
    title: "Block volley defense",
    purpose:
      "Turn incoming drives into dead resets: block volleys that die in the kitchen instead of rebounding pace.",
    instructions: [
      "Defender at the kitchen line, feeder at midcourt driving balls at the defender's chest and hips.",
      "Block every drive with a loose grip and no swing — the ball should drop into the kitchen.",
      "Score 1 point per kitchen-landing block; a rebound past midcourt scores for the feeder.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "first to 10 blocks, 3 rounds",
    families: ["volley", "drop_reset"],
  },
  {
    slug: "reflex-volley-wall",
    title: "Reflex volley wall",
    purpose:
      "Shrink reaction time: continuous wall volleys stepping progressively closer to the wall.",
    instructions: [
      "Start 8 ft from the wall volleying continuously above the net line.",
      "Every 30 s, take a half-step closer; keep the swing a compact block as time shrinks.",
      "When control breaks down, step back one position and rebuild the rally.",
    ],
    equipment: ["paddle", "ball", "wall with net-height line"],
    difficulty: "intermediate",
    repsOrDuration: "3 × 3 min ladders",
    families: ["volley"],
  },
  {
    slug: "punch-volley-targets",
    title: "Punch volley to deep targets",
    purpose:
      "Put away high balls with direction: punch volleys from the kitchen line to deep court targets.",
    instructions: [
      "Place two targets deep in the opponent court (backhand corner and middle-deep).",
      "Feeder tosses or dinks balls that sit above net height; punch-volley each to the called target.",
      "Short compact punch from the shoulder — no backswing behind the body.",
    ],
    equipment: ["paddle", "balls", "court", "2 targets"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 punches, alternating targets",
    families: ["volley"],
  },
  {
    slug: "baseline-drive-rally",
    title: "Baseline drive rally",
    purpose:
      "Build repeatable drive mechanics: cooperative deep rally keeping every ball past the midline.",
    instructions: [
      "Both players at the baseline rallying drives; every ball must land beyond the transition zone.",
      "Prepare with the unit turn before the bounce; contact out front at waist height.",
      "Count consecutive deep balls; restart the count when one lands short.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "beginner",
    repsOrDuration: "3 rallies of 20+ deep balls",
    families: ["drive"],
  },
  {
    slug: "drive-drop-decision",
    title: "Drive or drop decision feed",
    purpose:
      "Choose the right third shot under time pressure: drive the high ball, drop the low ball.",
    instructions: [
      "Feeder at the kitchen hits varied-height feeds to the baseline player.",
      "Call 'drive' or 'drop' out loud before the bounce, then execute the called shot.",
      "Score 2 points for a correct call executed in, 0 for a wrong call even if the ball lands.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 feeds",
    families: ["drive", "drop_reset"],
  },
  {
    slug: "shake-and-bake-pattern",
    title: "Shake and bake pattern",
    purpose:
      "Rehearse the drive-then-crash doubles pattern: third-shot drive, partner crashes for the putaway fifth.",
    instructions: [
      "Serve team plays a third-shot drive; the non-hitting partner immediately crashes toward the kitchen.",
      "Returner blocks the drive back; the crashing partner finishes the fifth ball out of the air.",
      "Rotate all four roles; drives must stay below head height to keep the pattern honest.",
    ],
    equipment: ["paddles", "balls", "court with net", "3–4 players"],
    difficulty: "advanced",
    repsOrDuration: "10 patterns per rotation",
    families: ["drive", "volley", "global"],
  },
  {
    slug: "topspin-drive-window",
    title: "Topspin drive window",
    purpose:
      "Add net clearance AND depth control: drive through a low window with topspin so the ball still drops in.",
    instructions: [
      "Stretch a string (or imagine a band) 1–2 ft above the net; drives must pass under it and land inside the baseline.",
      "Brush low-to-high through contact to generate topspin; finish over the opposite shoulder.",
      "Count makes out of 10 from the baseline, then from midcourt.",
    ],
    equipment: ["paddle", "balls", "court with net", "string or visual target band"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 drives per position",
    families: ["drive"],
  },
  {
    slug: "serve-corner-targets",
    title: "Serve corner targets",
    purpose:
      "Serve with intention: alternate wide and T targets deep in the service box.",
    instructions: [
      "Place towels in the deep-wide and deep-middle corners of the diagonal service box.",
      "Alternate serving to each target; a hit scores 3, landing in the deep third scores 1.",
      "Keep the same drop and contact routine every serve — targets change, mechanics don't.",
    ],
    equipment: ["paddle", "balls", "court", "2 towels"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 serves, alternating targets",
    families: ["serve"],
  },
  {
    slug: "deep-serve-ladder",
    title: "Deep serve point ladder",
    purpose:
      "Reward depth over pace: a scoring game where only the back third of the box counts big.",
    instructions: [
      "Mark the back third of the diagonal service box.",
      "Serve 10 balls: back-third landings score 5, middle third scores 1, short serves score 0.",
      "Track the 10-serve total across sessions; depth beats speed on this scoreboard.",
    ],
    equipment: ["paddle", "balls", "court", "line markers"],
    difficulty: "beginner",
    repsOrDuration: "3 × 10 scored serves",
    families: ["serve"],
  },
  {
    slug: "serve-under-pressure",
    title: "Serve under pressure",
    purpose:
      "Make the serve hold up when it counts: consequence scoring on blocked serve reps.",
    instructions: [
      "Serve sets of 10 with a target of 8 makes; two consecutive misses restart the set.",
      "Before each serve, run the full match routine — breath, drop checkpoint, target look.",
      "Finish with 'championship point': one serve that must land deep, twice in a row.",
    ],
    equipment: ["paddle", "balls", "court"],
    difficulty: "intermediate",
    repsOrDuration: "3 completed sets of 10",
    families: ["serve"],
  },
  {
    slug: "spin-contrast-serves",
    title: "Flat vs topspin serve contrast",
    purpose:
      "Feel the difference deliberately: alternate flat and topspin serves to learn what the brush changes.",
    instructions: [
      "Alternate one flat serve and one topspin serve (low-to-high brush at contact) to the same deep target.",
      "Watch the bounce: log which serve lands deeper and which kicks higher.",
      "Keep the legal drop serve motion — contact below the waist, paddle head below the wrist.",
    ],
    equipment: ["paddle", "balls", "court"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 alternating serves",
    families: ["serve"],
  },
  {
    slug: "deep-return-recover",
    title: "Deep return and recover",
    purpose:
      "Return deep, then win the footrace: every return is followed by a full sprint to the kitchen line.",
    instructions: [
      "Partner serves; return every ball past the transition zone, favoring the middle-deep target.",
      "Immediately follow the return in — arrive at the kitchen line and split-step before their third shot.",
      "Score the rep only if the return was deep AND you were set at the line in time.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 8 returns per side",
    families: ["return"],
  },
  {
    slug: "return-target-halves",
    title: "Return target halves",
    purpose:
      "Direct the return on purpose: call the target half before the serve and hit it deep.",
    instructions: [
      "Before each serve, call 'forehand side' or 'backhand side' of the server's court.",
      "Return deep into the called half; a called deep landing scores 2, any other in-ball scores 0.",
      "Bias reps toward the opponent-backhand call — the highest-value return in doubles.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "3 × 10 called returns",
    families: ["return"],
  },
  {
    slug: "backhand-slice-return-blocks",
    title: "Backhand slice return blocks",
    purpose:
      "Own the backhand return: blocked repetitions of the deep slice return that buys time to get in.",
    instructions: [
      "Feeder serves (or hand-feeds) to the backhand corner repeatedly.",
      "Slice each return high and deep with a long follow-through toward the target.",
      "Hold the finish for a beat — the float time is what lets you reach the kitchen line.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "5 × 8 backhand returns",
    families: ["return"],
  },
  {
    slug: "split-step-timing-returns",
    title: "Split-step timing on returns",
    purpose:
      "Land the split-step exactly at server contact so the first move is explosive, not late.",
    instructions: [
      "Partner serves at random intervals; hop into the split-step timed to their contact.",
      "A helper (or slow-motion phone video) checks: feet landing as the ball leaves the paddle.",
      "Play the return out normally after each correctly-timed split.",
    ],
    equipment: ["paddle", "balls", "court", "phone camera (optional)"],
    difficulty: "beginner",
    repsOrDuration: "4 × 10 timed returns",
    families: ["return", "global"],
  },
  {
    slug: "reset-game-of-death",
    title: "Reset game of death",
    purpose:
      "Survive the worst spot on the court: midcourt defender may ONLY reset while the kitchen player attacks.",
    instructions: [
      "Defender stands in the transition zone and may only hit soft resets into the kitchen; attacker at the line hits at their feet.",
      "Defender may take at most one step forward per reset that lands; swap roles when the defender misses.",
      "Defender scores only via resets that force an attacker error or land dead in the kitchen.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "advanced",
    repsOrDuration: "games to 7 per role",
    families: ["drop_reset"],
  },
  {
    slug: "midcourt-reset-blocks",
    title: "Midcourt reset blocks",
    purpose:
      "Absorb pace from no-man's-land: soft-hand resets off attacks aimed at the feet.",
    instructions: [
      "Stand at midcourt; partner at the kitchen line attacks balls at your feet and hips.",
      "Reset with the paddle tip down, lifting gently with legs and shoulder — the ball should die in the kitchen.",
      "After each landed reset, advance one step until you reach the line, then restart deep.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 8 reset sequences",
    families: ["drop_reset"],
  },
  {
    slug: "transition-zone-crawl",
    title: "Transition zone crawl",
    purpose:
      "Earn the kitchen line the real way: advance only behind drops that actually land.",
    instructions: [
      "Start at the baseline; kitchen-line partner feeds every ball back at you.",
      "Hit a drop; if it lands in the kitchen, take two steps in and split-step. If not, hold position.",
      "Reaching the line wins the rep; three consecutive non-kitchen drops resets you to the baseline.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "6 full crawls",
    families: ["drop_reset"],
  },
  {
    slug: "drop-and-charge",
    title: "Drop and charge",
    purpose:
      "Attach the footwork to the shot: every third-shot drop is followed by an immediate advance.",
    instructions: [
      "Play serve, return, then a third-shot drop from the baseline.",
      "Charge forward behind every drop that lands, split-stepping before the opponent's contact.",
      "Play the point out from wherever the drop let you get to — honest feedback on drop quality.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "3 × 8 points",
    families: ["drop_reset", "global"],
  },
  {
    slug: "wall-reset-softening",
    title: "Wall reset softening",
    purpose:
      "Solo version of pace absorption: hit firm into the wall, then kill the rebound into a soft reset.",
    instructions: [
      "Hit a firm ball into the wall from 8–10 ft, then absorb the fast rebound into a soft touch that would die in a kitchen.",
      "Alternate one firm feed, one absorbing reset, keeping the reset contact out front with a loose grip.",
      "Progress by hitting the feed harder while the reset stays just as soft.",
    ],
    equipment: ["paddle", "ball", "wall"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 90 s cycles",
    families: ["drop_reset", "volley"],
  },
  {
    slug: "seven-eleven",
    title: "7–11 kitchen vs baseline",
    purpose:
      "Classic asymmetric pressure game: the baseline player must reach 7 before the kitchen player reaches 11.",
    instructions: [
      "One player starts every rally at the kitchen line, the other at the baseline; feeder is the kitchen player.",
      "Play rally scoring: baseline player wins at 7 points, kitchen player at 11.",
      "The baseline player works drops and resets to neutralize before attacking; swap roles each game.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "best of 3 games per role",
    families: ["global", "drop_reset"],
  },
  {
    slug: "dead-ball-scenario-points",
    title: "Dead-ball scenario points",
    purpose:
      "Rehearse one game situation on repeat: restart every rally from the same scripted moment.",
    instructions: [
      "Pick one scenario (e.g. all four at the kitchen, or serve team stuck at the baseline after a deep return).",
      "Start every point from that frozen position with a cooperative feed, then play it out for real.",
      "Rotate positions every 5 points; log which side wins each scenario over time.",
    ],
    equipment: ["paddles", "balls", "court with net", "2–4 players"],
    difficulty: "intermediate",
    repsOrDuration: "4 scenarios × 10 points",
    families: ["global"],
  },
  {
    slug: "king-of-the-court",
    title: "King of the court",
    purpose:
      "Compete under rotation pressure: winners hold the champion side, challengers rotate in every rally.",
    instructions: [
      "Champions defend one end; challenger teams rotate in from the other end each rally (or mini-game to 3).",
      "Challengers must win the rally to take the champion side; champions score a point per successful defense.",
      "Play all rallies from a standard serve start so every game skill appears.",
    ],
    equipment: ["paddles", "balls", "court with net", "5+ players"],
    difficulty: "intermediate",
    repsOrDuration: "20–30 min session",
    families: ["global"],
  },
  {
    slug: "serve-return-plus-two",
    title: "Serve, return, plus two",
    purpose:
      "Isolate the first four shots — where most amateur points are decided — and score only those.",
    instructions: [
      "Play points that END after shot four: serve, return, third shot, fourth shot.",
      "Score shot quality: deep return 1, third shot landing in the kitchen 2, fourth-shot putaway 2.",
      "Rotate server every 5 points; track which of the four shots leaks the most errors.",
    ],
    equipment: ["paddles", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 10 four-shot points",
    families: ["global", "serve", "return", "drop_reset"],
  },
  {
    slug: "kitchen-footwork-shadow",
    title: "Kitchen line footwork shadow",
    purpose:
      "Groove the lateral shuffle and split-step at the line without a ball — pure movement quality.",
    instructions: [
      "At the kitchen line, shadow the pattern: split-step, shuffle two steps left, dink shadow swing, recover; mirror right.",
      "Stay low with the paddle up the entire set; never cross the feet.",
      "Add a partner calling random directions to make the pattern reactive.",
    ],
    equipment: ["paddle", "court or any flat space"],
    difficulty: "beginner",
    repsOrDuration: "4 × 45 s patterns",
    families: ["global", "dink"],
  },
  {
    slug: "lob-overhead-rotation",
    title: "Lob and overhead rotation",
    purpose:
      "Handle the ball over your head: controlled lob feeds into overhead putaways with partner-switch footwork.",
    instructions: [
      "Feeder lobs from the baseline over the kitchen-line player, who turns, drops step, and takes the overhead.",
      "Aim overheads at a deep middle target — placement over power.",
      "If the lob is too deep to smash, practice the switch: let it bounce, reset, and rebuild the point.",
    ],
    equipment: ["paddle", "balls", "court with net"],
    difficulty: "intermediate",
    repsOrDuration: "4 × 8 lob feeds",
    families: ["volley", "global"],
  },
] as const;

/** Deterministic UUIDv5-style id over the slug (same construction the
 * saved-drills fallback used, so pre-existing bookmarks keep their ids). */
export async function deterministicUuid(seed: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(seed),
  );
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function drillId(slug: string): Promise<string> {
  return deterministicUuid(`pickle-sensei.drill-catalog:${slug}`);
}

function describe(seed: SeedDrill): string {
  return `${seed.purpose}\n\n${seed.instructions.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\nDose: ${seed.repsOrDuration}.`;
}

let cachedCatalog: CatalogDrillRecord[] | null = null;

export async function drillCatalog(): Promise<CatalogDrillRecord[]> {
  if (cachedCatalog) return cachedCatalog;
  cachedCatalog = await Promise.all(
    SEEDS.map(async (seed) => ({
      id: await drillId(seed.slug),
      slug: seed.slug,
      title: seed.title,
      description: describe(seed),
      coach_name: COACH_BYLINE,
      equipment: seed.equipment,
      difficulty_min: seed.difficulty,
      difficulty_max: seed.difficulty,
      families: seed.families,
      validation_state: "UNVALIDATED" as const,
    })),
  );
  return cachedCatalog;
}

export async function drillCatalogEntry(
  slug: string,
): Promise<CatalogDrillRecord | null> {
  const catalog = await drillCatalog();
  return catalog.find((drill) => drill.slug === slug) ?? null;
}

/** Case-insensitive search across title/description/equipment + optional
 * family filter. */
export async function searchDrillCatalog(params: {
  q?: string;
  family?: string;
}): Promise<CatalogDrillRecord[]> {
  const catalog = await drillCatalog();
  const q = params.q?.trim().toLowerCase();
  const family = params.family?.trim().toLowerCase();
  return catalog.filter((drill) => {
    if (family && !drill.families.includes(family)) return false;
    if (!q) return true;
    const haystack = [drill.title, drill.description, ...drill.equipment]
      .join("\n")
      .toLowerCase();
    return haystack.includes(q);
  });
}
