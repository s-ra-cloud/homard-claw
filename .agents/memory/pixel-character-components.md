---
name: Pixel character sprites
description: How to produce character sprites that match existing scene art in this project, and why hand-coded pixel components were abandoned.
---

# Don't hand-plot a character that already exists in scene art

When a character already appears in generated scene artwork, do not reimplement it as a
hand-plotted SVG/canvas pixel component. Generate a standalone sprite of that same
character instead and bake the variants you need.

**Why:** two rounds of hand-plotted pixel lobsters (32x32, then 40x40 with auto-outline
and shading) were both rejected — coded pixel art lands somewhere between "flat" and
"generic mascot" and never matches the painterly shading of generated scene art sitting
next to it on the same screen. The generated sprite was accepted immediately.

**How to apply:** image generation here takes no reference image, so describe the
character exhaustively from the scene art — palette, shading direction, outline colour,
body proportions, and each appendage — and ask for a plain flat backdrop with no
scenery. Generate a couple of poses at once and pick; a symmetrical front-facing pose
reads better as a small avatar than the scene's three-quarter pose.

# Bake sprite variants at build time

Recolour variants belong in a build script that writes both the sprite PNGs and a JSON
manifest the app imports, never in hand-copied colour constants.

**Why:** the swatch colours shown in the UI must be the sprites' real average colour, or
the picker lies about what the user is choosing. Copying script output into a TS array
by hand desynchronises them the first time a variant is retuned.

**How to apply:** recolour by HSL hue rotation with per-variant saturation/lightness
scaling, and skip near-neutral pixels so eye whites, pupils and glints survive. Leave
one variant as an untouched pass-through so the house colour is byte-identical to the
scene art. Downsample large renders onto a small grid with alpha-weighted box sampling
plus a coverage threshold, otherwise the silhouette turns soft at avatar sizes.

# Tolerate unknown persisted trait data

Character traits persisted as free-form strings (a hex shell colour, an accessory name)
must be normalized at the component boundary — snap a hex to the nearest available
sprite, and fall back to the house variant for unparseable or legacy values. Never cast
the raw string into the union type with `as`.
