import type { CSSProperties } from "react";
import "./marlow-lobster.css";

/**
 * The office lobster, as drawn in the Marlow diorama.
 *
 * Sprites are pre-baked recolours of that artwork (see
 * `scripts/build-lobster-sprites.mjs`), so every agent is literally the same
 * character wearing a different shell pigment.
 */

export type LobsterStatus =
  "idle" | "working" | "researching" | "waiting" | "paused" | "error" | string;

import presets from "./lobster-presets.json";
import frameLayouts from "./lobster-frames.json";

export interface LobsterPreset {
  id: string;
  name: string;
  /** Average shell colour of the baked sprite — written by the build script. */
  shellColor: string;
  blurb: string;
}

export const LOBSTER_PRESETS: LobsterPreset[] = presets;

const DEFAULT_PRESET = LOBSTER_PRESETS[0];

function parseHex(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Avatars persist an arbitrary hex shell colour, so pick the sprite that sits
 * closest to it. Unparseable or legacy values fall back to the house shell.
 */
export function presetForShellColor(
  shellColor: string | null | undefined,
): LobsterPreset {
  const target = parseHex(shellColor ?? "");
  if (!target) return DEFAULT_PRESET;
  let best = DEFAULT_PRESET;
  let bestDistance = Infinity;
  for (const preset of LOBSTER_PRESETS) {
    const rgb = parseHex(preset.shellColor);
    if (!rgb) continue;
    // Weighted RGB distance — green carries most of perceived difference.
    const distance =
      2 * (rgb[0] - target[0]) ** 2 +
      4 * (rgb[1] - target[1]) ** 2 +
      3 * (rgb[2] - target[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = preset;
    }
  }
  return best;
}

/**
 * Every office seated pose is a composite sprite that includes the chair,
 * so the room artwork itself stays furniture-free where agents sit.
 * `floor-working` is a composite with a floor cushion + laptop for the
 * four floor workstations that expand the office beyond its four desks.
 * The "beach" pose is a transparent, towel-resting lobster; the towel remains
 * in the retirement island artwork so this pose can move without duplicating it.
 * Hotel poses contain only the Crustabot and a small handheld accessory. They
 * deliberately exclude chairs and room furniture so the hotel scene can anchor
 * each guest directly to an appliance and animate the whole sprite safely.
 */
export type LobsterPose =
  | "standing"
  | "seated"
  | "working"
  | "idle-coffee"
  | "idle-music"
  | "idle-reading"
  | "idle-stretch"
  | "floor-working"
  | "beach"
  | "hotel-reading"
  | "hotel-dancing"
  | "hotel-drink"
  | "hotel-arcade"
  | "hotel-aquarium"
  | "hotel-spa"
  | "hotel-clapping"
  | "hotel-resting";

/**
 * Composite poses cannot be animated with a transform — that lifts the chair,
 * cushion or laptop off the floor with the lobster. They ship a frame strip
 * beside the still sprite instead (`scripts/build-lobster-sprites.mjs`), where
 * the furniture pixels are identical in every frame and only the character
 * moves: a blink, a claw pressing the keys, a head dip, a head turn.
 *
 * A pose that lacks one of those beats simply holds its rest frame there, so
 * one set of keyframes drives every pose.
 */
type LobsterFrame = "rest" | "blink" | "stir" | "nod" | "turn";

const MOVING_FRAMES: LobsterFrame[] = ["blink", "stir", "nod", "turn"];

/**
 * Written by the build script alongside the strips, keyed by sprite folder, so
 * a pose can never disagree with its own artwork about which column holds the
 * blink. Poses drawn with their eyes shut simply have no blink frame.
 */
const FRAME_LAYOUTS = frameLayouts as Record<string, string[] | undefined>;

/**
 * Column positions for a strip: frame `i` of `n` sits at `i / (n - 1)` of the
 * background travel. Expressed as a division so the browser lands on the exact
 * frame boundary at any rendered size instead of a rounded percentage.
 */
function framePositions(layout: string[]): Record<string, string> {
  const last = layout.length - 1;
  const vars: Record<string, string> = {
    "--marlow-frames": String(layout.length),
  };
  // Anything the pose does not draw falls back to holding the rest frame.
  for (const frame of MOVING_FRAMES) vars[`--marlow-${frame}`] = "0%";
  layout.forEach((frame, index) => {
    if (!MOVING_FRAMES.includes(frame as LobsterFrame)) return;
    vars[`--marlow-${frame}`] = `calc(${index} * 100% / ${last})`;
  });
  return vars;
}

/**
 * A roomful of lobsters blinking in lockstep reads as one animation played
 * eight times, so each agent gets its own start offset and slightly different
 * tempo from a stable hash of its id.
 */
function idleRhythm(seed: string | undefined): Record<string, string> {
  if (!seed) return {};
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const phase = ((hash >>> 8) % 1000) / 1000;
  const tempo = ((hash >>> 20) % 1000) / 1000;
  return {
    // Negative delay starts the loop mid-cycle instead of pausing it.
    "--marlow-phase": `${(-phase * 8).toFixed(2)}s`,
    "--marlow-tempo": (0.86 + tempo * 0.34).toFixed(3),
  };
}

/**
 * One character scale for a whole scene.
 *
 * Every composite bakes its furniture into the same 128px box, so the lobster
 * inside is a different size in every pose. Measured on the shipped
 * house-colour sprites (shell pixels only, antennae and legs excluded) the
 * character's body box is: standing 108x127, seated 60x91, working 79x88,
 * idle-coffee 75x92, idle-music 92x93, idle-reading 66x96, idle-stretch 72x92,
 * floor-working 94x107, beach 97x118.
 *
 * A pose's scale is the sprite box a scene must render for the character to
 * come out at a given character size, with the standing sprite as 1. The six
 * chair poses deliberately share one scale, derived from their mean body box:
 * the chair is the same piece of furniture in all of them and must not resize
 * when a status change swaps one chair pose for another.
 *
 * floor-working measures 1.17 by body box, but that composite is drawn with a
 * much larger head, so at 1.17 it still reads as a bigger character beside the
 * chair poses. 1.07 was settled by compositing the real sprites onto the real
 * office artwork. Beach is the raw measurement — the retirement island sizes
 * its sprites directly and does not use this table.
 */
export const POSE_CHARACTER_SCALE: Record<LobsterPose, number> = {
  standing: 1,
  seated: 1.42,
  working: 1.42,
  "idle-coffee": 1.42,
  "idle-music": 1.42,
  "idle-reading": 1.42,
  "idle-stretch": 1.42,
  "floor-working": 1.07,
  beach: 1.09,
  "hotel-reading": 1.08,
  "hotel-dancing": 1.08,
  "hotel-drink": 1.08,
  "hotel-arcade": 1.08,
  "hotel-aquarium": 1.08,
  "hotel-spa": 1.08,
  "hotel-clapping": 1.08,
  "hotel-resting": 1.08,
};
const POSE_FOLDERS: Record<LobsterPose, string> = {
  standing: "lobsters",
  seated: "lobsters-sitting",
  working: "lobsters-working",
  "idle-coffee": "lobsters-idle-coffee",
  "idle-music": "lobsters-idle-music",
  "idle-reading": "lobsters-idle-reading",
  "idle-stretch": "lobsters-idle-stretch",
  "floor-working": "lobsters-floor-working",
  beach: "lobsters-beach",
  "hotel-reading": "lobsters-hotel-reading",
  "hotel-dancing": "lobsters-hotel-dancing",
  "hotel-drink": "lobsters-hotel-drink",
  "hotel-arcade": "lobsters-hotel-arcade",
  "hotel-aquarium": "lobsters-hotel-aquarium",
  "hotel-spa": "lobsters-hotel-spa",
  "hotel-clapping": "lobsters-hotel-clapping",
  "hotel-resting": "lobsters-hotel-resting",
};

export interface MarlowLobsterProps {
  size?: number;
  /** Hex shell colour from the agent's avatar; snapped to the nearest sprite. */
  shellColor?: string;
  /** Explicit preset id, used by the picker to avoid a colour round-trip. */
  preset?: string;
  status?: LobsterStatus;
  /** Office workstations use the composite lobster-and-chair sprites. */
  pose?: LobsterPose;
  /** Stable per-agent value (its id) so a room of lobsters moves out of sync. */
  seed?: string;
  title?: string;
  className?: string;
}

export function MarlowLobster({
  size = 96,
  shellColor,
  preset,
  status = "idle",
  pose = "standing",
  seed,
  title,
  className = "",
}: MarlowLobsterProps) {
  const chosen =
    LOBSTER_PRESETS.find((p) => p.id === preset) ??
    presetForShellColor(shellColor);
  const folder = `${import.meta.env.BASE_URL}images/${POSE_FOLDERS[pose]}`;
  const layout = FRAME_LAYOUTS[POSE_FOLDERS[pose]];
  const classes = `marlow-lobster marlow-lobster--${status} marlow-lobster--pose-${pose}`;

  if (layout) {
    // Sized through a custom property so page CSS can still shrink the sprite;
    // an inline width would outrank the office's responsive rules.
    const style = {
      "--marlow-size": `${size}px`,
      ...framePositions(layout),
      ...idleRhythm(seed),
      backgroundImage: `url("${folder}/${chosen.id}-frames.png")`,
    } as CSSProperties;
    return (
      <span
        style={style}
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        className={`${classes} marlow-lobster--frames ${className}`}
      />
    );
  }

  return (
    <img
      src={`${folder}/${chosen.id}.png`}
      width={size}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      draggable={false}
      className={`${classes} marlow-lobster--motion ${className}`}
    />
  );
}
