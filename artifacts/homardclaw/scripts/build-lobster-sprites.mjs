/**
 * Turns the generated Marlow lobster artwork into the sprite set the app ships.
 *
 * Source art is a 1024x1024 render of the office lobster. That is far too large
 * and too soft to display at 56px, so we trim it to the character, downsample it
 * onto a crisp pixel grid, and bake one recoloured sprite per stock shell.
 *
 * Run: node artifacts/homardclaw/scripts/build-lobster-sprites.mjs
 *
 * Alternate chair poses (repeat per source/out-dir pair):
 * - lobster-in-office-chair-naked.png  -> lobsters-sitting
 * - lobster-chair-working-source.png   -> lobsters-working
 * - lobster-chair-coffee-source.png    -> lobsters-idle-coffee
 * - lobster-chair-music-source.png     -> lobsters-idle-music
 * - lobster-chair-reading-source.png   -> lobsters-idle-reading
 * - lobster-chair-stretch-source.png   -> lobsters-idle-stretch
 * - lobster-beach-towel-source.png     -> lobsters-beach
 *
 * LOBSTER_SOURCE=../../../attached_assets/generated_images/<source>.png \
 * LOBSTER_OUT_DIR=../public/images/<out-dir> \
 * LOBSTER_WRITE_MANIFEST=0 LOBSTER_MATCH_MANIFEST=1 node \
 * artifacts/homardclaw/scripts/build-lobster-sprites.mjs
 *
 * Animation frames for the composite (furniture-bearing) poses:
 *
 * LOBSTER_FRAMES=all node artifacts/homardclaw/scripts/build-lobster-sprites.mjs
 *
 * That mode never touches the still sprites — it reads the shipped ones and
 * writes `<pose>/<preset>-frames.png` strips beside them. See FRAME_POSES.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = process.env.LOBSTER_SOURCE
  ? resolve(HERE, process.env.LOBSTER_SOURCE)
  : resolve(HERE, "../../../attached_assets/generated_images/lobster-sprite-b.png");
const OUT_DIR = process.env.LOBSTER_OUT_DIR
  ? resolve(HERE, process.env.LOBSTER_OUT_DIR)
  : resolve(HERE, "../public/images/lobsters");
const FRAMES = process.env.LOBSTER_FRAMES;
const WRITE_MANIFEST = process.env.LOBSTER_WRITE_MANIFEST !== "0";
const MATCH_MANIFEST = process.env.LOBSTER_MATCH_MANIFEST === "1";
const MANIFEST_PATH = resolve(HERE, "../src/components/ui/lobster-presets.json");
const GRID = 128; // final sprite resolution

/* ----------------------------------------------------------- png decode */

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC = crcTable();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePng(buf) {
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG not supported");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported color type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      switch (filter) {
        case 1: line[i] = (line[i] + a) & 0xff; break;
        case 2: line[i] = (line[i] + b) & 0xff; break;
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pr) & 0xff;
          break;
        }
        default: break;
      }
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng({ width, height, data }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------- colour */

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255),
  ];
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* --------------------------------------------------------- processing */

/** Drops the flat backdrop: flood fills from the border over similar colours. */
function keyOutBackground(img) {
  const { width, height, data } = img;
  const bg = [data[0], data[1], data[2]];
  const seen = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) {
    stack.push(x, (height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    stack.push(y * width, y * width + width - 1);
  }
  const near = (i) => {
    const d = i * 4;
    if (data[d + 3] < 8) return true;
    return (
      Math.abs(data[d] - bg[0]) + Math.abs(data[d + 1] - bg[1]) + Math.abs(data[d + 2] - bg[2]) < 60
    );
  };
  while (stack.length) {
    const i = stack.pop();
    if (i < 0 || i >= width * height || seen[i]) continue;
    if (!near(i)) continue;
    seen[i] = 1;
    data[i * 4 + 3] = 0;
    const x = i % width;
    if (x > 0) stack.push(i - 1);
    if (x < width - 1) stack.push(i + 1);
    stack.push(i - width, i + width);
  }
  return img;
}

function boundingBox(img) {
  const { width, height, data } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Box-samples the source into a square grid, then hardens alpha to keep edges crisp. */
function downsample(img, box, grid) {
  const { width, data } = img;
  const boxW = box.maxX - box.minX + 1;
  const boxH = box.maxY - box.minY + 1;
  const span = Math.max(boxW, boxH);
  const offX = box.minX - (span - boxW) / 2;
  const offY = box.minY - (span - boxH) / 2;
  const cell = span / grid;
  const out = Buffer.alloc(grid * grid * 4);

  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      const x0 = Math.floor(offX + gx * cell);
      const y0 = Math.floor(offY + gy * cell);
      const x1 = Math.max(x0 + 1, Math.floor(offX + (gx + 1) * cell));
      const y1 = Math.max(y0 + 1, Math.floor(offY + (gy + 1) * cell));
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
          const d = (y * width + x) * 4;
          const alpha = data[d + 3] / 255;
          r += data[d] * alpha;
          g += data[d + 1] * alpha;
          b += data[d + 2] * alpha;
          a += alpha;
          n++;
        }
      }
      const d = (gy * grid + gx) * 4;
      if (!n || a === 0) continue;
      const coverage = a / n;
      if (coverage < 0.42) continue; // keep the silhouette hard-edged
      out[d] = clamp(Math.round(r / a), 0, 255);
      out[d + 1] = clamp(Math.round(g / a), 0, 255);
      out[d + 2] = clamp(Math.round(b / a), 0, 255);
      out[d + 3] = 255;
    }
  }
  return { width: grid, height: grid, data: out };
}

/** Median hue of the saturated (shell) pixels — the pigment we rotate away from. */
function baseHue(img) {
  const hues = [];
  for (let i = 0; i < img.width * img.height; i++) {
    const d = i * 4;
    if (img.data[d + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(img.data[d], img.data[d + 1], img.data[d + 2]);
    if (s > 0.35 && l > 0.15 && l < 0.85) hues.push(h);
  }
  hues.sort((a, b) => a - b);
  return hues[Math.floor(hues.length / 2)] ?? 0;
}

function recolor(img, from, target) {
  const out = Buffer.from(img.data);
  if (target.hue === null && target.sat === 1 && target.light === 1) return { ...img, data: out };
  const delta = target.hue === null ? 0 : target.hue - from;
  for (let i = 0; i < img.width * img.height; i++) {
    const d = i * 4;
    if (out[d + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(out[d], out[d + 1], out[d + 2]);
    if (s < 0.12) continue; // eye whites, pupils and glints stay neutral
    const [r, g, b] = hslToRgb(
      h + delta,
      clamp(s * target.sat, 0, 1),
      clamp(l * target.light, 0, 0.97),
    );
    out[d] = r;
    out[d + 1] = g;
    out[d + 2] = b;
  }
  return { width: img.width, height: img.height, data: out };
}

/** Average shell colour, so the UI swatch always matches the sprite. */
function shellHex(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const d = i * 4;
    if (img.data[d + 3] < 128) continue;
    const [, s, l] = rgbToHsl(img.data[d], img.data[d + 1], img.data[d + 2]);
    if (s < 0.2 || l < 0.2 || l > 0.8) continue;
    r += img.data[d];
    g += img.data[d + 1];
    b += img.data[d + 2];
    n++;
  }
  const hex = (v) => Math.round(v / n).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function hexToHsl(hex) {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return rgbToHsl((value >> 16) & 255, (value >> 8) & 255, value & 255);
}

/**
 * Alternate poses come from separate source art, but an agent's pigment must
 * remain identical when its pose changes. Iteratively align saturated pixels
 * to the canonical preset's representative shell colour.
 */
function matchShellColor(img, targetHex) {
  let matched = img;
  for (let pass = 0; pass < 4; pass++) {
    const [fromHue, fromSat, fromLight] = hexToHsl(shellHex(matched));
    const [toHue, toSat, toLight] = hexToHsl(targetHex);
    const hueDelta = toHue - fromHue;
    const satScale = fromSat > 0 ? toSat / fromSat : 1;
    const lightScale = fromLight > 0 ? toLight / fromLight : 1;
    const out = Buffer.from(matched.data);

    for (let i = 0; i < matched.width * matched.height; i++) {
      const d = i * 4;
      if (out[d + 3] < 128) continue;
      const [h, s, l] = rgbToHsl(out[d], out[d + 1], out[d + 2]);
      if (s < 0.12) continue;
      const [r, g, b] = hslToRgb(
        h + hueDelta,
        clamp(s * satScale, 0, 1),
        clamp(l * lightScale, 0, 0.97),
      );
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
    }
    matched = { ...matched, data: out };
  }
  return matched;
}

/** `hue: null` keeps the source pigment untouched. */
const VARIANTS = [
  { id: "marlow",  name: "Marlow",  hue: null, sat: 1.0,  light: 1.0,  blurb: "House crimson, straight off the office floor" },
  { id: "coral",   name: "Coral",   hue: 14,   sat: 0.82, light: 1.14, blurb: "Sunbleached reef" },
  { id: "pincher", name: "Pincher", hue: 344,  sat: 1.0,  light: 0.78, blurb: "Deep claret" },
  { id: "bisque",  name: "Bisque",  hue: 34,   sat: 0.6,  light: 1.22, blurb: "Butter shell" },
  { id: "shelly",  name: "Shelly",  hue: 207,  sat: 0.72, light: 1.0,  blurb: "Deep current blue" },
  { id: "nori",    name: "Nori",    hue: 148,  sat: 0.6,  light: 0.95, blurb: "Kelp green" },
  { id: "sable",   name: "Sable",   hue: 268,  sat: 0.55, light: 1.0,  blurb: "Twilight urchin" },
  { id: "tidal",   name: "Tidal",   hue: 194,  sat: 0.42, light: 0.98, blurb: "Harbour steel" },
  { id: "saffron", name: "Saffron", hue: 39,   sat: 0.95, light: 1.12, blurb: "Lantern amber" },
  { id: "ember",   name: "Ember",   hue: 18,   sat: 0.88, light: 0.72, blurb: "Banked coals" },
];

/* -------------------------------------------------------------- frames */

/**
 * Composite poses bake the chair, cushion or laptop into the sprite, so the app
 * cannot animate them with a CSS transform without lifting that furniture off
 * the floor. Each composite pose therefore also ships a frame strip whose
 * furniture pixels are byte-identical between frames: the extra frames are
 * derived from the shipped sprite by repainting a couple of small character
 * regions, never by regenerating the artwork.
 *
 * Regions are calibrated once per pose against the canonical `marlow` sprite.
 * Recolouring never moves a pixel, so the same regions fit all ten presets.
 * - `eyes`: one rect per eyeball, painted shut for the blink frame.
 * - `claws`: one rect per claw, stretched `drop` rows toward the keys (a
 *   negative `drop` reaches upward instead) for the press frame.
 * - `head`: one rect covering the head (antennae included) down to just above
 *   the shoulders, plus how far the head dips (`nod`) and leans (`turn`).
 *   Unlike the claws, the head is genuinely translated: these sprites are
 *   transparent overlays, so the pixels it vacates are refilled from whatever
 *   sat above/beside it in the same sprite. Only shell-coloured columns move,
 *   so a chair back behind the head keeps its own pixels.
 *
 * Frame order in the strip is always: rest, blink (if `eyes`), press (if
 * `claws`), nod (if `head`), turn (if `head.turn`).
 * `src/components/ui/marlow-lobster.tsx` mirrors this layout frame for frame.
 */
const FRAME_POSES = {
  "lobsters-sitting": {
    eyes: [[52, 14, 58, 21], [69, 14, 75, 21]],
    head: { rect: [30, 0, 100, 32], nod: 3, turn: 3 },
  },
  "lobsters-working": {
    eyes: [[54, 4, 59, 12], [67, 4, 73, 12]],
    claws: [{ rect: [70, 40, 106, 68], drop: 2 }],
    head: { rect: [40, 0, 104, 24], nod: 3 },
  },
  // Frame order: rest, blink, sip (left arm raises cup toward mouth).
  // The cup's neutral pixels do not move; only the warm arm pixels shift up.
  "lobsters-idle-coffee": {
    eyes: [[51, 24, 57, 33], [67, 23, 74, 33]],
    claws: [{ rect: [17, 36, 57, 65], drop: -4 }],
    head: { rect: [36, 0, 100, 40], nod: 3, turn: 3 },
  },
  // Eyes shut, lost in the track: the blink frame has nothing to close, so the
  // beat is carried by the claw and by the head bobbing with it (drop increased
  // from -2 to -4 so the motion reads clearly at small sizes).
  "lobsters-idle-music": {
    claws: [{ rect: [16, 14, 46, 56], drop: -4 }],
    head: { rect: [40, 0, 96, 46], nod: 3, turn: 3 },
  },
  // Frame order: rest, blink, right-arm-lift (right claw rises slightly as if
  // reaching to turn a page, while the book and left arm stay planted).
  "lobsters-idle-reading": {
    eyes: [[52, 27, 60, 35], [67, 27, 75, 35]],
    claws: [{ rect: [84, 44, 100, 72], drop: -3 }],
    head: { rect: [40, 0, 92, 42], nod: 3 },
  },
  // Head thrown back mid-yawn, so there are no eyes to blink here either; the
  // head settles between stretches instead. Its rect stops short of the raised
  // claws on either side so only the head travels.
  "lobsters-idle-stretch": {
    claws: [
      { rect: [26, 0, 52, 36], drop: -2 },
      { rect: [76, 0, 104, 36], drop: -2 },
    ],
    head: { rect: [46, 0, 86, 52], nod: 3 },
  },
  "lobsters-floor-working": {
    eyes: [[36, 40, 49, 59], [50, 42, 65, 61]],
    claws: [
      { rect: [45, 88, 72, 114], drop: 2 },
      { rect: [20, 66, 44, 92], drop: 1 },
    ],
    head: { rect: [18, 0, 90, 66], nod: 3 },
  },
  "lobsters-beach": {
    eyes: [[47, 22, 57, 32], [59, 21, 69, 31]],
    head: { rect: [30, 0, 92, 40], nod: 3, turn: 3 },
  },
};

const at = (img, x, y) => (y * img.width + x) * 4;
const isOpaque = (img, x, y) => img.data[at(img, x, y) + 3] >= 128;
const hslAt = (img, x, y) => {
  const d = at(img, x, y);
  return rgbToHsl(img.data[d], img.data[d + 1], img.data[d + 2]);
};

/**
 * Everything neutral inside an eye rect is eyeball: whites, pupil and glint.
 * Row-span filling closes the gaps the pupil punches in the whites, and the
 * outline pixels are kept so the closed eye still reads as an eye.
 */
function eyeRegion(img, [x0, y0, x1, y1]) {
  const cells = new Set();
  for (let y = y0; y <= y1; y++) {
    let first = Infinity;
    let last = -Infinity;
    for (let x = x0; x <= x1; x++) {
      if (!isOpaque(img, x, y)) continue;
      const [, s] = hslAt(img, x, y);
      if (s >= 0.3) continue;
      first = Math.min(first, x);
      last = Math.max(last, x);
    }
    for (let x = first; x <= last; x++) cells.add(`${x},${y}`);
  }
  const fill = [];
  const rim = new Set();
  let top = Infinity;
  let bottom = -Infinity;
  for (const key of cells) {
    const [x, y] = key.split(",").map(Number);
    fill.push([x, y]);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!cells.has(`${x + dx},${y + dy}`)) rim.add(key);
      }
    }
  }
  return { fill, rim, top, bottom };
}

/** Average shell colour hugging an eye — the pigment its lid is painted in. */
function lidColor(img, eye) {
  const inside = new Set(eye.fill.map(([x, y]) => `${x},${y}`));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of eye.fill) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  for (let pad = 2; pad <= 6; pad++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0 - pad; y <= y1 + pad; y++) {
      for (let x = x0 - pad; x <= x1 + pad; x++) {
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
        if (inside.has(`${x},${y}`) || !isOpaque(img, x, y)) continue;
        const [, s, l] = hslAt(img, x, y);
        if (s < 0.3 || l < 0.15 || l > 0.85) continue;
        const d = at(img, x, y);
        r += img.data[d]; g += img.data[d + 1]; b += img.data[d + 2];
        n++;
      }
    }
    if (n >= 6) return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  }
  return null;
}

function shade([r, g, b], factor) {
  const [h, s, l] = rgbToHsl(r, g, b);
  return hslToRgb(h, s, clamp(l * factor, 0.04, 0.96));
}

/** Paints calibrated eyeballs shut, leaving every other pixel untouched. */
function blinkFrame(img, eyes) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (const eye of eyes) {
    const lid = lidColor(img, eye);
    if (!lid) continue;
    const lash = Math.round((eye.top + eye.bottom) / 2);
    // Big googly eyes keep their outline so the shut eye still reads as an eye;
    // the pinhead eyes on the chair poses are outline all the way through.
    const keepRim = eye.fill.length >= 60;
    for (const [x, y] of eye.fill) {
      if (keepRim && eye.rim.has(`${x},${y}`)) continue;
      const tall = eye.bottom - eye.top >= 8;
      const color =
        y === lash || (tall && y === lash + 1)
          ? shade(lid, 0.45)
          : y < lash
            ? shade(lid, 1.08)
            : shade(lid, 0.88);
      const d = at(out, x, y);
      out.data[d] = color[0];
      out.data[d + 1] = color[1];
      out.data[d + 2] = color[2];
      out.data[d + 3] = 255;
    }
  }
  return out;
}

/** Warm shell pixels inside a claw rect, column by column. */
function clawRegion(img, [x0, y0, x1, y1]) {
  const columns = new Map();
  for (let x = x0; x <= x1; x++) {
    const rows = [];
    for (let y = y0; y <= y1; y++) {
      if (!isOpaque(img, x, y)) continue;
      const [h, s] = hslAt(img, x, y);
      if (s >= 0.35 && (h <= 45 || h >= 320)) rows.push(y);
    }
    if (rows.length) columns.set(x, rows);
  }
  return columns;
}

/**
 * Stretches a claw toward the keys: each masked column is redrawn `drop` rows
 * further on, with its leading row repeated so the claw never tears open. Only
 * the claw grows — furniture above it is never read, only briefly covered.
 */
function pressFrame(img, claws) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  for (const { columns, drop } of claws) {
    const step = Math.sign(drop);
    for (const [x, rows] of columns) {
      const masked = new Set(rows);
      const lead = step > 0 ? rows[0] : rows[rows.length - 1];
      const tail = step > 0 ? rows[rows.length - 1] : rows[0];
      const stops = [];
      for (let y = tail + drop; y !== lead - step; y -= step) stops.push(y);
      for (const y of stops) {
        if (y < 0 || y >= img.height) continue;
        const src = y - drop;
        const from = step > 0 ? (src < lead ? lead : src) : src > lead ? lead : src;
        if (from !== lead && !masked.has(from)) continue;
        const s = at(img, x, from);
        const d = at(out, x, y);
        out.data[d] = img.data[s];
        out.data[d + 1] = img.data[s + 1];
        out.data[d + 2] = img.data[s + 2];
        out.data[d + 3] = img.data[s + 3];
      }
    }
  }
  return out;
}

/**
 * Head columns: for each column crossing the head rect, the span of shell
 * pixels from the antenna tip down to the chin. Neutral pixels caught inside
 * that span (eyeballs, glints, mouth) belong to the head and travel with it;
 * anything outside — a chair back, a headrest, the mug — is never read.
 */
function headColumns(img, [x0, y0, x1, y1]) {
  const columns = new Map();
  for (let x = x0; x <= x1; x++) {
    let top = Infinity;
    let bottom = -Infinity;
    for (let y = y0; y <= y1; y++) {
      if (!isOpaque(img, x, y)) continue;
      const [h, s] = hslAt(img, x, y);
      if (s < 0.35 || (h > 45 && h < 320)) continue;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
    if (bottom >= top) columns.set(x, [top, bottom]);
  }
  return columns;
}

/**
 * Translates the head by (dx, dy). Each masked column is redrawn from the
 * source offset by the shift, which refills the vacated pixels with whatever
 * the head was covering — transparent sky above it, or the chair behind it.
 * Furniture columns the head never occupied are left byte-identical.
 */
function headFrame(img, columns, dx, dy) {
  const out = { width: img.width, height: img.height, data: Buffer.from(img.data) };
  const copy = (x, y, sx, sy) => {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const d = at(out, x, y);
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) {
      out.data[d + 3] = 0;
      return;
    }
    const s = at(img, sx, sy);
    out.data[d] = img.data[s];
    out.data[d + 1] = img.data[s + 1];
    out.data[d + 2] = img.data[s + 2];
    out.data[d + 3] = img.data[s + 3];
  };
  for (const [x, [top, bottom]] of columns) {
    // Walk against the shift so a pixel is read before it is overwritten.
    const from = dy >= 0 ? bottom + dy : top + dy;
    const to = dy >= 0 ? top : bottom;
    const step = dy >= 0 ? -1 : 1;
    for (let y = from; dy >= 0 ? y >= to : y <= to; y += step) {
      copy(x + dx, y, x, y - dy);
      // The column the head leaves behind shows what stood beside it.
      if (dx !== 0) copy(x, y, x - dx, y - dy);
    }
  }
  return out;
}

function frameStrip(frames) {
  const size = frames[0].height;
  const width = size * frames.length;
  const data = Buffer.alloc(width * size * 4);
  frames.forEach((frame, i) => {
    for (let y = 0; y < size; y++) {
      frame.data.copy(data, (y * width + i * size) * 4, y * size * 4, (y + 1) * size * 4);
    }
  });
  return { width, height: size, data };
}

/**
 * Every frame is a repaint of a calibrated region, so no pixel may change
 * outside that region once the shift is accounted for. If the art is ever
 * retuned and a rect no longer sits over the feature it was measured against,
 * this fails the build instead of shipping a sprite whose chair twitches.
 */
function assertWithin(rest, frame, name, boxes) {
  for (let y = 0; y < rest.height; y++) {
    for (let x = 0; x < rest.width; x++) {
      const d = at(rest, x, y);
      let changed = false;
      for (let k = 0; k < 4; k++) changed ||= rest.data[d + k] !== frame.data[d + k];
      if (!changed) continue;
      if (boxes.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1)) continue;
      throw new Error(`${name} frame repaints ${x},${y} outside its calibrated region`);
    }
  }
}

/** A recipe rect grown by the shift the frame applies to it. */
const grow = ([x0, y0, x1, y1], dx, dy) => [
  x0 + Math.min(dx, 0),
  y0 + Math.min(dy, 0),
  x1 + Math.max(dx, 0),
  y1 + Math.max(dy, 0),
];

/** Writes `<preset>-frames.png` for one pose folder from its shipped sprites. */
function buildFrames(folder) {
  const config = FRAME_POSES[folder];
  if (!config) throw new Error(`no frame recipe for ${folder}`);
  const dir = resolve(HERE, "../public/images", folder);
  const canonical = decodePng(readFileSync(resolve(dir, "marlow.png")));
  // Geometry is shared by every preset, so calibrate the regions once.
  const eyes = (config.eyes ?? []).map((rect) => eyeRegion(canonical, rect));
  const claws = (config.claws ?? []).map(({ rect, drop }) => ({
    columns: clawRegion(canonical, rect),
    drop,
  }));
  const head = config.head
    ? { ...config.head, columns: headColumns(canonical, config.head.rect) }
    : null;

  const layout = ["rest"];
  for (const { id } of VARIANTS) {
    const sprite = decodePng(readFileSync(resolve(dir, `${id}.png`)));
    const frames = [sprite];
    const add = (frame, name, boxes) => {
      assertWithin(sprite, frame, `${folder} ${id} ${name}`, boxes);
      frames.push(frame);
      if (frames.length > layout.length) layout.push(name);
    };
    if (eyes.length) add(blinkFrame(sprite, eyes), "blink", config.eyes);
    if (claws.length) {
      add(
        pressFrame(sprite, claws),
        "stir",
        config.claws.map(({ rect, drop }) => grow(rect, 0, drop)),
      );
    }
    if (head) {
      add(headFrame(sprite, head.columns, 0, head.nod), "nod", [
        grow(head.rect, 0, head.nod),
      ]);
      if (head.turn) {
        add(headFrame(sprite, head.columns, head.turn, Math.sign(head.nod)), "turn", [
          grow(head.rect, head.turn, Math.sign(head.nod)),
        ]);
      }
    }
    writeFileSync(resolve(dir, `${id}-frames.png`), encodePng(frameStrip(frames)));
  }
  console.log(`${folder}: ${VARIANTS.length} strips of ${layout.length} frames`);
  return layout;
}

if (FRAMES) {
  const folders = FRAMES === "all" ? Object.keys(FRAME_POSES) : [FRAMES];
  const manifest = resolve(HERE, "../src/components/ui/lobster-frames.json");
  // The app reads this layout back, so a pose can never disagree with its strip
  // about which column holds the blink, the stir or the head. Rebuilding a
  // single folder merges into the manifest rather than leaving it stale.
  const layouts = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : {};
  for (const folder of folders) layouts[folder] = buildFrames(folder);
  for (const folder of Object.keys(layouts)) {
    if (!FRAME_POSES[folder]) delete layouts[folder];
  }
  writeFileSync(manifest, `${JSON.stringify(layouts, null, 2)}\n`);
  process.exit(0);
}

/* ------------------------------------------------------------ pipeline */

const source = decodePng(readFileSync(SOURCE));
keyOutBackground(source);
const sprite = downsample(source, boundingBox(source), GRID);
const from = baseHue(sprite);
mkdirSync(OUT_DIR, { recursive: true });
const canonicalColors = MATCH_MANIFEST
  ? new Map(
      JSON.parse(readFileSync(MANIFEST_PATH, "utf8")).map((preset) => [
        preset.id,
        preset.shellColor,
      ]),
    )
  : new Map();

const manifest = VARIANTS.map((v) => {
  let img = recolor(sprite, from, v);
  const canonicalColor = canonicalColors.get(v.id);
  if (canonicalColor) img = matchShellColor(img, canonicalColor);
  writeFileSync(resolve(OUT_DIR, `${v.id}.png`), encodePng(img));
  return { id: v.id, name: v.name, shellColor: shellHex(img), blurb: v.blurb };
});

if (MATCH_MANIFEST) {
  const channelDelta = (a, b) => {
    const left = Number.parseInt(a.replace("#", ""), 16);
    const right = Number.parseInt(b.replace("#", ""), 16);
    return Math.max(
      Math.abs(((left >> 16) & 255) - ((right >> 16) & 255)),
      Math.abs(((left >> 8) & 255) - ((right >> 8) & 255)),
      Math.abs((left & 255) - (right & 255)),
    );
  };
  for (const preset of manifest) {
    const target = canonicalColors.get(preset.id);
    if (target && channelDelta(preset.shellColor, target) > 2) {
      throw new Error(
        `${preset.id} alternate pose colour ${preset.shellColor} drifted from ${target}`,
      );
    }
  }
}

if (WRITE_MANIFEST) {
  // The app reads this manifest directly so swatches can never drift from sprites.
  writeFileSync(
    resolve(HERE, "../src/components/ui/lobster-presets.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

console.log(`base hue ${from.toFixed(1)}deg -> ${manifest.length} sprites in ${OUT_DIR}`);
console.log(manifest.map((m) => `${m.id} ${m.shellColor}`).join("\n"));
