import { useMemo } from "react";
import "./marlow-lobster.css";

/**
 * MarlowLobster — an original, hand-plotted pixel lobster drawn in the same
 * painted 16-bit language as the isometric Marlow office scene: shaded shell
 * plates, stalked eyes, long sweeping antennae and heavy split pincers.
 *
 * Everything derives from a single shell colour plus an accessory, so each
 * agent reads as its own character while staying in one art direction.
 */

export type LobsterAccessory =
  | "none"
  | "glasses"
  | "headset"
  | "visor"
  | "bowtie"
  | "cap"
  | "scarf"
  | "monocle"
  | "headphones"
  | "flower";

export type LobsterStatus =
  | "idle"
  | "working"
  | "researching"
  | "waiting"
  | "paused"
  | "error"
  | "queued"
  | "complete";

const INK = "#2b2028";
const WHITE = "#fff4dd";
const BLACK = "#231a24";

const ACCESSORY_COLORS: Record<LobsterAccessory, string> = {
  none: "#ffffff",
  glasses: "#8fd6d1",
  headset: "#3f9cb4",
  visor: "#79cdb3",
  bowtie: "#f6c54b",
  cap: "#4f7fbf",
  scarf: "#e0605f",
  monocle: "#f6c54b",
  headphones: "#a58ac8",
  flower: "#f78fb3",
};

export const LOBSTER_ACCESSORIES: LobsterAccessory[] = [
  "none",
  "glasses",
  "headset",
  "visor",
  "bowtie",
  "cap",
  "scarf",
  "monocle",
  "headphones",
  "flower",
];

/**
 * Avatar records are free-form strings in the database, so anything we do not
 * recognise (legacy values, hand-edited rows) degrades to a bare shell.
 */
export function normalizeAccessory(value: string | null | undefined): LobsterAccessory {
  return (LOBSTER_ACCESSORIES as string[]).includes(value ?? "")
    ? (value as LobsterAccessory)
    : "none";
}

/** The ten stock shells new recruits are issued from. */
export const LOBSTER_PRESETS: {
  id: string;
  name: string;
  blurb: string;
  shellColor: string;
  accessory: LobsterAccessory;
}[] = [
  { id: "marlow", name: "Marlow", blurb: "Classic house coral", shellColor: "#d8452f", accessory: "glasses" },
  { id: "coral", name: "Coral", blurb: "Sunbleached reef", shellColor: "#f2745c", accessory: "flower" },
  { id: "pincher", name: "Pincher", blurb: "Deep claret", shellColor: "#b02f3d", accessory: "headset" },
  { id: "bisque", name: "Bisque", blurb: "Warm butter shell", shellColor: "#e3a06a", accessory: "bowtie" },
  { id: "shelly", name: "Shelly", blurb: "Cold current blue", shellColor: "#4f7fbf", accessory: "visor" },
  { id: "nori", name: "Nori", blurb: "Kelp forest green", shellColor: "#3f8f7a", accessory: "headphones" },
  { id: "sable", name: "Sable", blurb: "Twilight urchin", shellColor: "#7d5aa6", accessory: "monocle" },
  { id: "tidal", name: "Tidal", blurb: "Harbour steel", shellColor: "#2f6f8f", accessory: "scarf" },
  { id: "saffron", name: "Saffron", blurb: "Lantern amber", shellColor: "#e8a72c", accessory: "cap" },
  { id: "ember", name: "Ember", blurb: "Banked coals", shellColor: "#8c2f2f", accessory: "none" },
];

/* ---------------------------------------------------------------- colours */

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function shiftColor(hex: string, amount: number): string {
  const clean = /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#d8452f";
  const channels = [1, 3, 5].map((i) => parseInt(clean.slice(i, i + 2), 16));
  const out = channels
    .map((c) =>
      amount >= 0
        ? Math.round(c + (255 - c) * amount)
        : Math.round(c * (1 + amount)),
    )
    .map((c) => clamp(c, 0, 255).toString(16).padStart(2, "0"))
    .join("");
  return `#${out}`;
}

/* -------------------------------------------------------------- anatomy */

const GRID = 40;

type Span = [row: number, from: number, to: number];

/** Eye stalks, carapace, abdomen and a flared tail fan. */
const CORE: Span[] = [
  [14, 12, 14], [14, 25, 27],
  [15, 13, 15], [15, 24, 26],
  [16, 14, 16], [16, 23, 25],
  [16, 17, 22],
  [17, 14, 25],
  [18, 13, 26],
  [19, 12, 27],
  [20, 12, 27],
  [21, 11, 28],
  [22, 11, 28],
  [23, 12, 27],
  [24, 12, 27],
  [25, 13, 26],
  [26, 14, 25],
  [27, 15, 24],
  [28, 16, 23],
  [29, 16, 23],
  [30, 17, 22],
  [31, 17, 22],
  [32, 18, 21],
  [33, 18, 21],
  [34, 15, 24],
  [35, 13, 26],
  [36, 12, 27],
  [37, 13, 26],
  [38, 16, 23],
];

/** Big split pincer: upper finger, hinge, heavy lower jaw. */
const LEFT_CLAW: Span[] = [
  [14, 6, 10],
  [15, 4, 10],
  [16, 3, 10],
  [17, 2, 10],
  [18, 2, 9],
  [19, 3, 9],   // upper finger ends here
  [20, 8, 11],  // hinge only — rows 19-20 stay open as the pincer gap
  [21, 2, 11],
  [22, 1, 11],
  [23, 1, 11],
  [24, 2, 11],
  [25, 3, 11],
  [26, 5, 11],
  [27, 8, 11],
];

const LEFT_LEGS: Span[] = [
  [28, 13, 15],
  [30, 14, 16],
  [32, 15, 17],
];

const LEFT_ANTENNA: [number, number][] = [
  [2, 0], [3, 1], [4, 2], [5, 3], [6, 4], [7, 5], [8, 6],
  [9, 7], [10, 8], [11, 9], [12, 10], [13, 11], [14, 12],
  [15, 13], [16, 14], [17, 15],
];

/** Plate seams that give the shell its segmented, painted look. */
const SEAMS: Span[] = [
  [20, 13, 26],
  [24, 13, 26],
  [27, 16, 23],
  [29, 17, 22],
  [31, 18, 21],
  [36, 19, 20],
];

const mirror = ([row, from, to]: Span): Span => [row, GRID - 1 - to, GRID - 1 - from];

const BODY: Span[] = [
  ...CORE,
  ...LEFT_CLAW,
  ...LEFT_CLAW.map(mirror),
  ...LEFT_LEGS,
  ...LEFT_LEGS.map(mirror),
];

/* ------------------------------------------------------------- painting */

type Px = { x: number; y: number; fill: string; opacity?: number };

const key = (x: number, y: number) => `${x},${y}`;

function paintBody(shell: string): Px[] {
  const light = shiftColor(shell, 0.36);
  const dark = shiftColor(shell, -0.22);
  const deep = shiftColor(shell, -0.44);
  const px: Px[] = [];

  const filled = new Set<string>();
  for (const [row, from, to] of BODY) {
    for (let x = from; x <= to; x++) filled.add(key(x, row));
  }

  // 1px silhouette drawn just outside the filled shape.
  const outline = new Set<string>();
  for (const cell of filled) {
    const [x, y] = cell.split(",").map(Number);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
      if (!filled.has(key(nx, ny))) outline.add(key(nx, ny));
    }
  }
  for (const cell of outline) {
    const [x, y] = cell.split(",").map(Number);
    px.push({ x, y, fill: INK });
  }

  // Shell fill with a top-left key light and bottom-right shade.
  for (const [row, from, to] of BODY) {
    for (let x = from; x <= to; x++) {
      let fill = shell;
      if (x <= from + 1) fill = light;
      else if (x >= to - 1) fill = dark;
      px.push({ x, y: row, fill });
    }
  }

  for (const [row, from, to] of SEAMS) {
    for (let x = from; x <= to; x++) px.push({ x, y: row, fill: deep });
  }

  // Painted highlight running over the carapace and the upper pincers.
  for (const [row, from, to] of [
    [18, 15, 19], [19, 14, 18], [20, 14, 16],
    [16, 5, 8], [17, 4, 7],
  ] as Span[]) {
    for (let x = from; x <= to; x++) px.push({ x, y: row, fill: light });
  }

  return px;
}

function paintAntennae(shell: string): Px[] {
  const deep = shiftColor(shell, -0.34);
  const px: Px[] = [];
  for (const [x, y] of LEFT_ANTENNA) {
    px.push({ x, y, fill: deep });
    px.push({ x: GRID - 1 - x, y, fill: deep });
  }
  return px;
}

type Expression = "open" | "focused" | "closed" | "x";

function expressionFor(status: LobsterStatus): Expression {
  if (status === "error") return "x";
  if (status === "waiting" || status === "paused") return "closed";
  if (status === "working" || status === "researching") return "focused";
  return "open";
}

/** 6x6 stalked eye. `inward` is +1 for the left eye, -1 for the right. */
function paintEye(x0: number, expression: Expression, inward: 1 | -1): Px[] {
  const px: Px[] = [];
  const y0 = 8;
  for (let x = 0; x < 6; x++) {
    for (let y = 0; y < 6; y++) px.push({ x: x0 + x, y: y0 + y, fill: INK });
  }
  if (expression === "closed") {
    for (let x = 1; x <= 4; x++) px.push({ x: x0 + x, y: y0 + 3, fill: WHITE });
    return px;
  }
  for (let x = 1; x <= 4; x++) {
    for (let y = 1; y <= 4; y++) px.push({ x: x0 + x, y: y0 + y, fill: WHITE });
  }
  if (expression === "x") {
    for (const [dx, dy] of [[1, 1], [4, 1], [2, 2], [3, 3], [1, 4], [4, 4], [3, 2], [2, 3]]) {
      px.push({ x: x0 + dx, y: y0 + dy, fill: BLACK });
    }
    return px;
  }
  const pupilX = expression === "focused" ? x0 + 2 : x0 + (inward === 1 ? 3 : 1);
  const pupilY = expression === "focused" ? y0 + 2 : y0 + 3;
  for (let dx = 0; dx < 2; dx++) {
    for (let dy = 0; dy < 2; dy++) {
      px.push({ x: pupilX + dx, y: pupilY + dy, fill: BLACK });
    }
  }
  // Specular glint.
  px.push({ x: x0 + 1, y: y0 + 1, fill: "#ffffff" });
  return px;
}

function rect(x0: number, y0: number, x1: number, y1: number, fill: string, opacity?: number): Px[] {
  const px: Px[] = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) px.push({ x, y, fill, opacity });
  }
  return px;
}

function ring(x0: number, y0: number, x1: number, y1: number, fill: string): Px[] {
  const px: Px[] = [];
  for (let x = x0; x <= x1; x++) {
    px.push({ x, y: y0, fill });
    px.push({ x, y: y1, fill });
  }
  for (let y = y0 + 1; y < y1; y++) {
    px.push({ x: x0, y, fill });
    px.push({ x: x1, y, fill });
  }
  return px;
}

function paintAccessory(accessory: LobsterAccessory): Px[] {
  const accent = ACCESSORY_COLORS[accessory];
  const accentLight = shiftColor(accent, 0.4);
  const accentDark = shiftColor(accent, -0.32);

  switch (accessory) {
    case "glasses":
      return [
        ...rect(10, 8, 15, 13, accent, 0.3),
        ...rect(24, 8, 29, 13, accent, 0.3),
        ...ring(9, 7, 16, 14, INK),
        ...ring(23, 7, 30, 14, INK),
        ...rect(17, 10, 22, 10, INK),
        ...rect(10, 8, 12, 8, accentLight),
        ...rect(24, 8, 26, 8, accentLight),
      ];
    case "headset":
      return [
        ...rect(12, 4, 27, 4, INK),
        ...rect(12, 5, 27, 5, accentDark),
        ...rect(10, 5, 11, 6, INK),
        ...rect(28, 5, 29, 6, INK),
        ...ring(6, 6, 9, 15, INK),
        ...ring(30, 6, 33, 15, INK),
        ...rect(7, 7, 8, 14, accent),
        ...rect(31, 7, 32, 14, accent),
        ...rect(7, 7, 8, 8, accentLight),
        ...rect(9, 16, 9, 18, INK),
        ...rect(10, 19, 14, 19, INK),
        ...rect(15, 19, 16, 19, accentLight),
      ];
    case "visor":
      return [
        ...rect(8, 9, 31, 12, accent, 0.45),
        ...rect(7, 8, 32, 8, INK),
        ...rect(7, 13, 32, 13, accentDark),
        ...rect(9, 9, 14, 9, accentLight, 0.9),
      ];
    case "bowtie":
      return [
        ...rect(15, 26, 17, 30, accent),
        ...rect(22, 26, 24, 30, accent),
        ...rect(15, 26, 16, 27, accentLight),
        ...rect(16, 29, 17, 30, accentDark),
        ...rect(23, 29, 24, 30, accentDark),
        ...ring(14, 25, 18, 31, INK),
        ...ring(21, 25, 25, 31, INK),
        ...rect(19, 27, 20, 29, accentDark),
        ...ring(19, 27, 20, 29, INK),
      ];
    case "cap":
      return [
        ...rect(16, 11, 23, 15, accent),
        ...rect(16, 11, 18, 13, accentLight),
        ...rect(22, 13, 23, 15, accentDark),
        ...ring(15, 10, 24, 15, INK),
        ...rect(13, 16, 26, 16, accent),
        ...rect(13, 17, 26, 17, accentDark),
        ...rect(12, 16, 12, 17, INK),
        ...rect(27, 16, 27, 17, INK),
      ];
    case "scarf":
      return [
        ...rect(14, 26, 25, 28, accent),
        ...rect(14, 26, 17, 26, accentLight),
        ...ring(13, 25, 26, 29, INK),
        ...rect(21, 29, 24, 34, accent),          // hanging tail
        ...rect(21, 29, 22, 31, accentLight),
        ...rect(21, 35, 24, 35, accentDark),
        ...ring(20, 29, 25, 36, INK),
      ];
    case "monocle":
      return [
        ...rect(24, 8, 29, 13, accent, 0.3),
        ...ring(23, 7, 30, 14, INK),
        ...rect(24, 8, 26, 8, accentLight),
        ...rect(23, 15, 23, 17, INK),
        ...rect(22, 18, 22, 20, INK),
        ...rect(21, 21, 21, 22, INK),
      ];
    case "headphones":
      return [
        ...rect(12, 3, 27, 3, accent),
        ...rect(12, 4, 27, 4, accentDark),
        ...rect(10, 4, 11, 5, accent),
        ...rect(28, 4, 29, 5, accent),
        ...ring(5, 5, 9, 16, INK),
        ...ring(30, 5, 34, 16, INK),
        ...rect(6, 6, 8, 15, accent),
        ...rect(31, 6, 33, 15, accent),
        ...rect(6, 6, 7, 8, accentLight),
        ...rect(31, 6, 32, 8, accentLight),
      ];
    case "flower":
      return [
        ...rect(4, 2, 6, 4, accent),
        ...rect(8, 2, 10, 4, accent),
        ...rect(4, 6, 6, 8, accent),
        ...rect(8, 6, 10, 8, accent),
        ...rect(6, 4, 8, 6, "#f7e08a"),
        ...ring(3, 1, 11, 9, INK),
        ...rect(10, 9, 10, 12, "#4f8f5d"),
      ];
    default:
      return [];
  }
}

/* ------------------------------------------------- flatten & run-length */

type Run = { x: number; y: number; w: number; fill: string };

function blend(base: string | null, top: string, alpha: number): string {
  if (!base) return top;
  const parse = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [br, bg, bb] = parse(base);
  const [tr, tg, tb] = parse(top);
  const mix = (b: number, t: number) =>
    clamp(Math.round(b + (t - b) * alpha), 0, 255).toString(16).padStart(2, "0");
  return `#${mix(br, tr)}${mix(bg, tg)}${mix(bb, tb)}`;
}

/**
 * Composites every painted layer into a flat colour grid, then emits one rect
 * per horizontal run. A lobster drops from ~1500 DOM nodes to ~150.
 */
function buildRuns(shellColor: string, accessory: LobsterAccessory, expression: Expression): Run[] {
  const grid: (string | null)[] = new Array(GRID * GRID).fill(null);
  const layers: Px[] = [
    ...paintAntennae(shellColor),
    ...paintBody(shellColor),
    ...paintEye(10, expression, 1),
    ...paintEye(24, expression, -1),
    ...paintAccessory(accessory),
  ];
  for (const p of layers) {
    if (p.x < 0 || p.y < 0 || p.x >= GRID || p.y >= GRID) continue;
    const i = p.y * GRID + p.x;
    grid[i] = p.opacity === undefined ? p.fill : blend(grid[i], p.fill, p.opacity);
  }

  const runs: Run[] = [];
  for (let y = 0; y < GRID; y++) {
    let x = 0;
    while (x < GRID) {
      const fill = grid[y * GRID + x];
      if (!fill) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < GRID && grid[y * GRID + x + w] === fill) w++;
      runs.push({ x, y, w, fill });
      x += w;
    }
  }
  return runs;
}

const runCache = new Map<string, Run[]>();

function cachedRuns(shellColor: string, accessory: LobsterAccessory, expression: Expression): Run[] {
  const cacheKey = `${shellColor}|${accessory}|${expression}`;
  let runs = runCache.get(cacheKey);
  if (!runs) {
    runs = buildRuns(shellColor, accessory, expression);
    runCache.set(cacheKey, runs);
  }
  return runs;
}

export interface MarlowLobsterProps {
  size?: number;
  shellColor?: string;
  /** Free-form string tolerated: unknown values fall back to no accessory. */
  accessory?: string;
  status?: LobsterStatus;
  title?: string;
  className?: string;
}

export function MarlowLobster({
  size = 96,
  shellColor = "#d8452f",
  accessory = "none",
  status = "idle",
  title,
  className = "",
}: MarlowLobsterProps) {
  const expression = expressionFor(status);
  const worn = normalizeAccessory(accessory);
  const runs = useMemo(
    () => cachedRuns(shellColor, worn, expression),
    [shellColor, worn, expression],
  );

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      shapeRendering="crispEdges"
      className={`marlow-lobster marlow-lobster--${status} ${className}`}
      role={title ? "img" : "presentation"}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {runs.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill={r.fill} />
      ))}
    </svg>
  );
}
