---
name: HomardClaw scene sprite placement
description: How to position and size lobster composites over the isometric room/beach artwork, and how to eyeball the result without signing in.
---

# Placing sprites on the isometric scenes

## Size sprites as a share of the scene, not in pixels
Seat coordinates are percentages of a square scene container whose pixel size
depends on the viewport (it is clamped by both width and viewport height). A
sprite with a fixed `px` size therefore covers a different share of the room on
every screen, so a placement tuned on a wide desktop drifts onto the furniture
on a short or narrow window.

**Why:** the floor cushions had to clear desk corners with only ~1% of margin;
that margin only survives if the footprint is scale-invariant.

**How to apply:** give the absolutely-positioned agent wrapper a percentage
width and let the sprite fill it (`width: 100%; height: auto`). Drop any
media-query pixel override for that sprite, and scope the remaining pixel
overrides so they cannot match it.

## Measure against the artwork, not the running app
The office art leaves a wide band behind the front desks, a corridor pinched
between their inner corners (~63% down, ~37.5%–62.5% across), and open floor in
front of them. Colour-based masking of the floor is unreliable — desks and floor
share the same wood palette and region growing leaks across their seams.

**How to apply:** composite the actual sprite PNG onto the actual background PNG
with ImageMagick at the candidate percentages and look at the result; iterate
there before touching the app. Check one size larger than the intended footprint
so the layout keeps a margin.

## Seeing the scene without credentials
The app sits behind Clerk, so screenshots of the real page show a sign-in form.
A throwaway static HTML file in the web artifact's `public/` that re-creates the
scene markup and links the real stylesheets with Vite's `?direct` suffix renders
the layout at any viewport for screenshots. Delete it when finished.
