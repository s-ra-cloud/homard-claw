---
name: Animating the composite lobster poses
description: Why furniture-bearing sprites are animated by frame strip instead of CSS transforms, and why new frames must be derived from the shipped sprites.
---

# Never transform a sprite that has furniture baked into it

Only the standalone standing lobster may be moved as a whole (translate/rotate/scale).
Every other pose bakes the chair, floor cushion, laptop or lounger into the same image,
so whole-image motion lifts the furniture off the floor and the agent reads as floating.
Those poses animate a frame strip instead: the character region is repainted per frame
while every furniture pixel stays byte-identical.

**Why:** the owner called out desk and floor agents "floating" — the bob/sip/groove
animations were rocking the chair and cushion along with the lobster.

**How to apply:** keep frame counts at 2 or 3 so CSS background positions land on exact
0/50/100% boundaries at any rendered size; other counts need thirds and can seam or
jitter. Step frames rather than tween them, and express status through cadence, not
movement — brisk claw taps for busy, slow blinks for calm, a held frame for paused or
error. Size these sprites through a custom property rather than an inline width: page
CSS shrinks them at mobile breakpoints and an inline style would outrank it.

# The committed pose sprites cannot be regenerated

Do not re-run the recolour pipeline over a pose folder that already has sprites. It
overwrites them and then fails its own colour-drift guard, because the shipped art came
from source renders that no longer round-trip to the manifest colours.

**Why:** rebuilding one pose folder destroyed its ten presets and aborted halfway; the
files were only recoverable from git.

**How to apply:** derive anything new — frames, effects, exports — from the sprites that
already ship. That is also the only way to guarantee zero colour drift between an
agent's frames. Calibrate pixel regions once against the canonical house-colour sprite;
recolouring never moves a pixel, so the same coordinates fit every preset.
