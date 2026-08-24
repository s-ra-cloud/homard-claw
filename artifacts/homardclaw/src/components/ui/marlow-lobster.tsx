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
  | "idle"
  | "working"
  | "researching"
  | "waiting"
  | "paused"
  | "error"
  | string;

import presets from "./lobster-presets.json";

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
export function presetForShellColor(shellColor: string | null | undefined): LobsterPreset {
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
  | "beach";

/**
 * Composite poses cannot be animated with a transform — that lifts the chair,
 * cushion or laptop off the floor with the lobster. They ship a frame strip
 * beside the still sprite instead (`scripts/build-lobster-sprites.mjs`), where
 * the furniture pixels are identical in every frame and only the character
 * moves: a blink, and a claw pressing the keys. Counts must match the strips.
 */
const POSE_FRAMES: Partial<Record<LobsterPose, 2 | 3>> = {
  seated: 2,
  working: 3,
  "idle-coffee": 2,
  "idle-music": 2,
  "idle-reading": 2,
  "idle-stretch": 2,
  "floor-working": 3,
  beach: 2,
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
  title?: string;
  className?: string;
}

export function MarlowLobster({
  size = 96,
  shellColor,
  preset,
  status = "idle",
  pose = "standing",
  title,
  className = "",
}: MarlowLobsterProps) {
  const chosen =
    LOBSTER_PRESETS.find((p) => p.id === preset) ?? presetForShellColor(shellColor);
  const folder = `${import.meta.env.BASE_URL}images/${POSE_FOLDERS[pose]}`;
  const frames = POSE_FRAMES[pose];
  const classes = `marlow-lobster marlow-lobster--${status} marlow-lobster--pose-${pose}`;

  if (frames) {
    // Sized through a custom property so page CSS can still shrink the sprite;
    // an inline width would outrank the office's responsive rules.
    const style = {
      "--marlow-size": `${size}px`,
      backgroundImage: `url("${folder}/${chosen.id}-frames.png")`,
    } as CSSProperties;
    return (
      <span
        style={style}
        role={title ? "img" : undefined}
        aria-label={title}
        aria-hidden={title ? undefined : true}
        className={`${classes} marlow-lobster--frames marlow-lobster--frames-${frames} ${className}`}
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
