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

**How to apply:** any frame count works as long as the component emits each column as
`calc(i * 100% / (n - 1))`; round percentages are what seam or jitter, not the count.
Poses carry different beats, so the build script writes a layout manifest the app reads
back — never hand-maintain the frame order in two places. Step frames rather than tween
them, and express status through cadence, not movement — brisk claw taps for busy, slow
blinks for calm, a held frame for paused or error. Size these sprites through a custom
property rather than an inline width: page CSS shrinks them at mobile breakpoints and an
inline style would outrank it.

# Heads may travel; the CSS shorthand may not

Translating the head region inside a composite sprite is safe even though transforming
the whole sprite is not: the pose art is a transparent overlay, so vacated pixels refill
from the source offset by the shift and only shell-coloured columns move. Every frame
recipe asserts at build time that it repaints nothing outside its calibrated rect, which
is what catches a rect that no longer sits over the feature it was measured against.

**Why:** idle agents that only blinked still read as cardboard; nodding and turning
heads are what make a room of them look alive.

**How to apply:** give each agent a negative `animation-delay` and a tempo multiplier
hashed from its id, or a roomful animates in lockstep and reads as one looped GIF. Set
those with `animation-name`/`animation-duration` longhands — the `animation` shorthand in
a later rule silently resets the shared delay to zero. Poses drawn with the eyes shut
(music, stretch) get head motion but no blink frame; there is nothing to close.

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
