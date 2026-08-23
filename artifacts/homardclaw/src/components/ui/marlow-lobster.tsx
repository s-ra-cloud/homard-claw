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
 * Every non-standing pose is a composite sprite that includes the office
 * chair, so the room artwork itself stays furniture-free where agents sit.
 */
export type LobsterPose =
  | "standing"
  | "seated"
  | "working"
  | "idle-coffee"
  | "idle-music"
  | "idle-reading"
  | "idle-stretch";

const POSE_FOLDERS: Record<LobsterPose, string> = {
  standing: "lobsters",
  seated: "lobsters-sitting",
  working: "lobsters-working",
  "idle-coffee": "lobsters-idle-coffee",
  "idle-music": "lobsters-idle-music",
  "idle-reading": "lobsters-idle-reading",
  "idle-stretch": "lobsters-idle-stretch",
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
  const src = `${import.meta.env.BASE_URL}images/${POSE_FOLDERS[pose]}/${chosen.id}.png`;

  return (
    <img
      src={src}
      width={size}
      height={size}
      alt={title ?? ""}
      aria-hidden={title ? undefined : true}
      draggable={false}
      className={`marlow-lobster marlow-lobster--${status} marlow-lobster--pose-${pose} ${className}`}
    />
  );
}
