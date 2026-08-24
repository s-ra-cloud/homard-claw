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

## One character scale per pose, chair poses locked together
Every composite bakes its furniture into the same square sprite box, so the
lobster inside is a different size in each pose: rendering all poses at one
sprite size makes the floor character read as a different, oversized animal.
Drive a scene from a single *character* size and multiply it by a measured
per-pose factor (see `POSE_CHARACTER_SCALE`).

**Why:** the six chair poses share the same chair drawing, so they must share
one factor — normalising each pose to its own body box resizes the chair
whenever a status change swaps the pose.

**How to apply:** measure the body box on shell pixels only (antennae and legs
excluded) and use the group mean for the chair poses. Trust the eye over the
measurement where a pose is drawn with a bigger head: the floor pose measures
1.17 against standing but only reads right at ~1.07.

## Name tags belong in their own layer
An agent wrapper that carries a `z-index` (or a transform) opens a stacking
context, so a tag nested inside it can never rise above a nearer sibling
sprite. Render the tags as a separate absolutely-positioned layer above every
sprite, one per seat, and cap their width as a share of the scene with an
ellipsis so two neighbouring tags cannot collide for long agent names.

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
scene markup renders the layout at any viewport for screenshots. Delete it when
finished.

**How to apply:** inline the built stylesheet from the artifact's
`dist/public/assets/*.css` into the harness — linking a source stylesheet with
Vite's `?direct` suffix just hits the SPA fallback and returns HTML. Reference
images relatively (`images/…`), because the harness is served from whatever
base path the artifact is mounted at.
