/**
 * Product-wide pickleball vocabulary.
 *
 * A technique is the motion being learned. Side, spin, direction, court zone,
 * bounce state, and intent are orthogonal labels so dataset coverage can be
 * measured without exploding into ambiguous class names.
 */

export const STROKE_FAMILIES = [
  "serve",
  "return",
  "groundstroke",
  "drop_reset",
  "dink",
  "volley",
  "attack_counter",
  "overhead_lob",
  "specialty",
] as const;
export type StrokeFamily = (typeof STROKE_FAMILIES)[number];

export const PICKLEBALL_TECHNIQUES = [
  { slug: "volley_serve_forehand", family: "serve", name: "Forehand volley serve" },
  { slug: "volley_serve_backhand", family: "serve", name: "Backhand volley serve" },
  { slug: "drop_serve_forehand", family: "serve", name: "Forehand drop serve" },
  { slug: "drop_serve_backhand", family: "serve", name: "Backhand drop serve" },
  { slug: "return_drive_forehand", family: "return", name: "Forehand drive return" },
  { slug: "return_drive_backhand", family: "return", name: "Backhand drive return" },
  { slug: "return_slice_forehand", family: "return", name: "Forehand slice return" },
  { slug: "return_slice_backhand", family: "return", name: "Backhand slice return" },
  { slug: "return_block_forehand", family: "return", name: "Forehand block return" },
  { slug: "return_block_backhand", family: "return", name: "Backhand block return" },
  { slug: "drive_forehand", family: "groundstroke", name: "Forehand drive" },
  { slug: "drive_backhand", family: "groundstroke", name: "Backhand drive" },
  { slug: "drive_two_hand_backhand", family: "groundstroke", name: "Two-handed backhand drive" },
  { slug: "topspin_forehand", family: "groundstroke", name: "Forehand topspin groundstroke" },
  { slug: "topspin_backhand", family: "groundstroke", name: "Backhand topspin groundstroke" },
  { slug: "slice_forehand", family: "groundstroke", name: "Forehand slice groundstroke" },
  { slug: "slice_backhand", family: "groundstroke", name: "Backhand slice groundstroke" },
  { slug: "third_shot_drop_forehand", family: "drop_reset", name: "Forehand third-shot drop" },
  { slug: "third_shot_drop_backhand", family: "drop_reset", name: "Backhand third-shot drop" },
  { slug: "transition_drop_forehand", family: "drop_reset", name: "Forehand transition drop" },
  { slug: "transition_drop_backhand", family: "drop_reset", name: "Backhand transition drop" },
  { slug: "reset_volley_forehand", family: "drop_reset", name: "Forehand volley reset" },
  { slug: "reset_volley_backhand", family: "drop_reset", name: "Backhand volley reset" },
  { slug: "reset_half_volley_forehand", family: "drop_reset", name: "Forehand half-volley reset" },
  { slug: "reset_half_volley_backhand", family: "drop_reset", name: "Backhand half-volley reset" },
  { slug: "dink_straight_forehand", family: "dink", name: "Straight forehand dink" },
  { slug: "dink_straight_backhand", family: "dink", name: "Straight backhand dink" },
  { slug: "dink_crosscourt_forehand", family: "dink", name: "Crosscourt forehand dink" },
  { slug: "dink_crosscourt_backhand", family: "dink", name: "Crosscourt backhand dink" },
  { slug: "dink_topspin_forehand", family: "dink", name: "Forehand topspin dink" },
  { slug: "dink_topspin_backhand", family: "dink", name: "Backhand topspin dink" },
  { slug: "dink_slice_forehand", family: "dink", name: "Forehand slice dink" },
  { slug: "dink_slice_backhand", family: "dink", name: "Backhand slice dink" },
  { slug: "dink_two_hand_backhand", family: "dink", name: "Two-handed backhand dink" },
  { slug: "punch_volley_forehand", family: "volley", name: "Forehand punch volley" },
  { slug: "punch_volley_backhand", family: "volley", name: "Backhand punch volley" },
  { slug: "block_volley_forehand", family: "volley", name: "Forehand block volley" },
  { slug: "block_volley_backhand", family: "volley", name: "Backhand block volley" },
  { slug: "volley_two_hand_backhand", family: "volley", name: "Two-handed backhand volley" },
  { slug: "speedup_forehand", family: "attack_counter", name: "Forehand speed-up" },
  { slug: "speedup_backhand", family: "attack_counter", name: "Backhand speed-up" },
  { slug: "roll_volley_forehand", family: "attack_counter", name: "Forehand roll volley" },
  { slug: "roll_volley_backhand", family: "attack_counter", name: "Backhand roll volley" },
  { slug: "swinging_volley_forehand", family: "attack_counter", name: "Forehand swinging volley" },
  { slug: "swinging_volley_backhand", family: "attack_counter", name: "Backhand swinging volley" },
  { slug: "counter_forehand", family: "attack_counter", name: "Forehand counter" },
  { slug: "counter_backhand", family: "attack_counter", name: "Backhand counter" },
  { slug: "overhead_smash", family: "overhead_lob", name: "Overhead smash" },
  { slug: "backhand_overhead", family: "overhead_lob", name: "Backhand overhead" },
  { slug: "offensive_lob_forehand", family: "overhead_lob", name: "Forehand offensive lob" },
  { slug: "offensive_lob_backhand", family: "overhead_lob", name: "Backhand offensive lob" },
  { slug: "defensive_lob_forehand", family: "overhead_lob", name: "Forehand defensive lob" },
  { slug: "defensive_lob_backhand", family: "overhead_lob", name: "Backhand defensive lob" },
  { slug: "around_the_post_forehand", family: "specialty", name: "Forehand around-the-post" },
  { slug: "around_the_post_backhand", family: "specialty", name: "Backhand around-the-post" },
  { slug: "erne_forehand", family: "specialty", name: "Forehand Erne" },
  { slug: "erne_backhand", family: "specialty", name: "Backhand Erne" },
  { slug: "bert", family: "specialty", name: "Bert" },
  { slug: "tweener", family: "specialty", name: "Tweener" },
  { slug: "squash_shot_forehand", family: "specialty", name: "Forehand squash shot" },
  { slug: "squash_shot_backhand", family: "specialty", name: "Backhand squash shot" },
] as const satisfies ReadonlyArray<{
  slug: string;
  family: StrokeFamily;
  name: string;
}>;

export type PickleballTechniqueSlug = (typeof PICKLEBALL_TECHNIQUES)[number]["slug"];

export const STROKE_SIDES = ["forehand", "backhand", "two_hand_backhand", "overhead"] as const;
export const SPIN_TYPES = ["flat", "topspin", "slice", "sidespin", "mixed", "unknown"] as const;
export const SHOT_DIRECTIONS = [
  "straight",
  "crosscourt",
  "middle",
  "inside_in",
  "inside_out",
  "around_the_post",
  "unknown",
] as const;
export const COURT_ZONES = [
  "baseline",
  "backcourt",
  "transition",
  "nvz_line",
  "nvz",
  "outside_sideline",
  "unknown",
] as const;
export const CONTACT_STATES = ["after_bounce", "volley", "half_volley", "overhead"] as const;
export const STROKE_INTENTS = ["attack", "neutral", "reset", "defend", "place"] as const;
export const RALLY_OUTCOMES = [
  "in_play",
  "winner",
  "forced_error",
  "unforced_error",
  "fault",
  "unknown",
] as const;

export interface PickleballStrokeLabel {
  technique: PickleballTechniqueSlug;
  side: (typeof STROKE_SIDES)[number];
  spin: (typeof SPIN_TYPES)[number];
  direction: (typeof SHOT_DIRECTIONS)[number];
  originZone: (typeof COURT_ZONES)[number];
  targetZone: (typeof COURT_ZONES)[number];
  contactState: (typeof CONTACT_STATES)[number];
  intent: (typeof STROKE_INTENTS)[number];
  outcome: (typeof RALLY_OUTCOMES)[number];
}
