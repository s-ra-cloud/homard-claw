---
name: Pixel character components
description: How to author and ship hand-plotted pixel-art character components in this project without them looking blobby or tanking render performance.
---

# Authoring pixel characters in code

Plot the silhouette as per-row column spans, then derive the outline automatically
(any empty cell 4-adjacent to a filled cell becomes ink) and shade by span position
(first columns light, last columns dark). Never hand-paint every pixel.

**Why:** the first attempt at HomardClaw's lobster used a 32x32 hand-plotted grid and
read as a symmetrical blob — limbs merged into the body and the pincers were
unreadable. Moving to 40x40 with span-defined anatomy and an auto-outline fixed the
silhouette in one pass.

**How to apply:** appendages need a deliberate 1-2px empty gap where they should read
as separate (a claw's pincer split, a leg's joint) — the auto-outline fills that gap
with ink and does the visual separation for you. Verify at the real display size, not
just large.

# Ship it flattened

Composite all layers (including alpha overlays) into a flat colour grid, then emit one
rect per horizontal run and cache by variant key.

**Why:** one rect per pixel is ~1500 DOM nodes per character; a picker showing ten
variants plus a roster of agents produces tens of thousands. Flattening drops it to
~150 nodes per character with pixel-identical output.

**How to apply:** blend `opacity` layers into the grid manually while compositing —
once flattened there is no layering left to do at render time.

# Tolerate unknown data

Character traits stored as free-form strings in the database (accessory, pose) must be
normalized at the component boundary against the known list, not cast with `as`.
Legacy rows predate the current trait vocabulary and would otherwise render undefined
colours.
