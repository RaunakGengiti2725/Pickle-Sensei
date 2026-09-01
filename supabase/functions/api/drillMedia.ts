// Verified third-party instructional media for the drill catalog.
//
// HONESTY CONTRACT: every video below was verified REAL via YouTube's oEmbed
// endpoint (HTTP 200 + author_name captured verbatim) before being added —
// no fabricated IDs, no guessed creators. These are attributed community
// videos (YouTube Standard License, played/linked at the source); they are
// NOT Pickle Sensei coaching and the client labels them accordingly.
// Mappings are topical: a video is attached to a drill only when its content
// demonstrably covers that drill's skill (verified against title/transcript).

import { deterministicUuid } from "./drills.ts";

interface VerifiedVideo {
  videoId: string;
  creatorName: string; // verbatim oEmbed author_name
  title: string; // display title (trimmed of emoji/hashtags)
}

/** oEmbed-verified 2026-08-29. */
const VIDEOS = {
  wallDrills20Min: {
    videoId: "xDlzQZVXxKY",
    creatorName: "High Five Pickleball",
    title: "4 Pickleball Wall Drills That Will BOOST Your Game FAST",
  },
  wallDrillsPractice: {
    videoId: "sHq2oQR5hf4",
    creatorName: "Calvin Keeney",
    title: "Pickleball Wall Drills for You to Practice",
  },
  soloDinkDrill: {
    videoId: "lPPNJKvFBYI",
    creatorName: "John Cincola Pickleball",
    title: "Mastering the art of dinking, one solo drill at a time",
  },
  dinkingTechnique: {
    videoId: "3SdM98A_7Mg",
    creatorName: "Sarah Ansboury",
    title: "Pickleball Dinking Technique - Lesson & Drill",
  },
  thirdShotDropApex: {
    videoId: "uA1bWnj4Y6M",
    creatorName: "Z Sisters Pickleball",
    title: "Elevate Your 3rd Shot Drop Practice Like Magic!",
  },
  thirdShotDrop411: {
    videoId: "Y3QNj6qjZCY",
    creatorName: "Pickleball Channel",
    title: "Pickleball 411: Improve Your Third Shot Drop with Wes Gabrielsen",
  },
  aggressiveThirdDrop: {
    videoId: "sVW_QkCrLhc",
    creatorName: "tanner.pickleball",
    title: "How to Hit an Aggressive 3rd Shot Drop in Pickleball",
  },
  thirdDropSmartDrills: {
    videoId: "NByF0i33cJE",
    creatorName: "The Flying Pickle Academy",
    title: "3 Smart Drills to Level Up Your 3rd Shot Drops Like a Pro!",
  },
  skinnySinglesAnsboury: {
    videoId: "Wbi_B_Y1_qw",
    creatorName: "Sarah Ansboury",
    title: "How To Play Skinny Singles - Lesson & Drill",
  },
  skinnySinglesNspired: {
    videoId: "LvCnX0AytaI",
    creatorName: "Nspired Pickleball",
    title: "The Greatest PICKLEBALL Drill You Can Do With Two People!",
  },
  skinnySinglesJardim: {
    videoId: "TV5C7gbJFnI",
    creatorName: "Simone Jardim Pickleball",
    title: "Coach Simone | Skinny Singles",
  },
  skinnySinglesBeginner: {
    videoId: "uXHm8ImY2VU",
    creatorName: "Pickleball Daily",
    title: "Skinny Singles Pickleball Drill: Beginner Guide",
  },
  deepServeDrill: {
    videoId: "g0OUxk1q_NI",
    creatorName: "Indianapolis Pickleball Club",
    title: "Drills & Skills #6 Perfect Your Serves - Deep Serve Drill",
  },
  deeperServesReturns: {
    videoId: "thUZGW9nB5w",
    creatorName: "Better Pickleball",
    title: "How to Hit Deeper Serves and Returns Every Time",
  },
  resetDrillMidVsKitchen: {
    videoId: "jwHsMD8kdEw",
    creatorName: "Caden Cox",
    title: "Pickleball reset drill!",
  },
  transitionReset: {
    videoId: "lfjB5FgTrRE",
    creatorName: "Limitless Pickleball",
    title: "How to reset from the transition zone",
  },
  midcourtResetSelkirk: {
    videoId: "iP1_CqHT_6Q",
    creatorName: "Selkirk TV",
    title: "How to Reset From Mid-Court and Still Win the Point",
  },
  resetGameOfDeath: {
    videoId: "SJoRLqssCFU",
    creatorName: "Cori Elliott",
    title: "Reset Game of Death [BEST PICKLEBALL DRILLS]",
  },
} as const satisfies Record<string, VerifiedVideo>;

type VideoKey = keyof typeof VIDEOS;

/** Topical attachments only — a drill lists a video only when the video's
 * verified content covers that drill's skill. Drills without a topical
 * verified video list nothing (the client offers YouTube browse instead). */
const MEDIA_BY_SLUG: Record<string, VideoKey[]> = {
  "wall-dink-rally": ["wallDrills20Min", "wallDrillsPractice", "soloDinkDrill"],
  "dink-target-boxes": ["dinkingTechnique"],
  "crosscourt-dink-battle": ["dinkingTechnique"],
  "figure-eight-dinks": ["wallDrills20Min"],
  "dink-speedup-reset-cycle": ["wallDrills20Min"],
  "volley-wall-ready": ["wallDrillsPractice", "wallDrills20Min"],
  "reflex-volley-wall": ["wallDrillsPractice", "wallDrills20Min"],
  "serve-drop-consistency": ["deeperServesReturns"],
  "serve-corner-targets": ["deepServeDrill"],
  "deep-serve-ladder": ["deepServeDrill", "deeperServesReturns"],
  "deep-return-recover": ["deeperServesReturns", "deepServeDrill"],
  "third-shot-drop-ladder": [
    "thirdShotDrop411",
    "thirdShotDropApex",
    "aggressiveThirdDrop",
    "thirdDropSmartDrills",
  ],
  "drop-and-charge": ["thirdShotDrop411", "aggressiveThirdDrop"],
  "reset-game-of-death": ["resetGameOfDeath", "resetDrillMidVsKitchen"],
  "midcourt-reset-blocks": ["midcourtResetSelkirk", "transitionReset"],
  "transition-zone-crawl": ["transitionReset", "midcourtResetSelkirk"],
  "wall-reset-softening": ["wallDrills20Min"],
  "skinny-singles": [
    "skinnySinglesAnsboury",
    "skinnySinglesNspired",
    "skinnySinglesJardim",
    "skinnySinglesBeginner",
  ],
};

/** Shape mirrors apps/mobile/src/training/api.ts parseInstructionalMedia:
 * embed entries require provider youtube|vimeo, videoId, and embedUrl EXACTLY
 * `https://www.youtube-nocookie.com/embed/<videoId>` for youtube. */
export interface InstructionalMediaJson {
  id: string;
  kind: "embed";
  provider: "youtube";
  videoId: string;
  embedUrl: string;
  sourceUrl: string;
  creatorName: string;
  licenseName: string;
  licenseUrl: string;
  attribution: string;
}

export async function drillInstructionalMedia(slug: string): Promise<InstructionalMediaJson[]> {
  const keys = MEDIA_BY_SLUG[slug] ?? [];
  return Promise.all(
    keys.map(async (key) => {
      const video = VIDEOS[key];
      return {
        id: await deterministicUuid(`pickle-sensei.drill-media:${slug}:${video.videoId}`),
        kind: "embed" as const,
        provider: "youtube" as const,
        videoId: video.videoId,
        embedUrl: `https://www.youtube-nocookie.com/embed/${video.videoId}`,
        sourceUrl: `https://www.youtube.com/watch?v=${video.videoId}`,
        creatorName: video.creatorName,
        licenseName: "YouTube Standard License",
        licenseUrl: "https://www.youtube.com/t/terms",
        attribution: `"${video.title}" by ${video.creatorName} on YouTube`,
      };
    }),
  );
}
