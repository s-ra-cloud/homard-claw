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

## Align a seat on the sprite's ground contact, not its box
Every composite is a square box, but the furniture inside is not centred in it:
the office chair's wheelbase sits ~7% of the box width left of centre, because
the lobster's antennae widen the drawing to the right. Lining a seat's `left`
up with the target in the artwork therefore parks the chair visibly off-axis.

**How to apply:** crop the sprite's bottom rows (the wheels, the cushion) and
take that strip's trim geometry — its centre is what must land on the target.
Feed the difference back as a constant offset on the seat coordinate.

## Overlap is what reads as "at the furniture"
In an isometric room, a character that merely *clears* the desk reads as parked
in the middle of the floor. Depth is communicated by occlusion, so a seated
agent only looks seated at a workstation once its chair back covers part of the
desk it belongs to; the same holds for a cushion on an exterior platform, whose
pad is a quad, so centring on it means moving up as you move right.

**Why:** the instinct is to keep a tidy gap below the shelf, and that gap is
exactly what makes the character look detached from the furniture.

**How to apply:** aim for a small deliberate overlap with the furniture behind,
and check the near edges instead — the cushion must not cross a railing, and the
chair must not cover the monitor screen. A sprite pushed back against wall
furniture will also cover any invisible click target sitting on that furniture,
so re-check the hotspot layer whenever a seat moves.

## The chair sits in a different place in each pose's box
The chair poses share one sprite scale, but not one alignment: the working
pose's wheelbase is ~10px (of a 128px box) left of where every other chair pose
draws it. Tuning a seat on one pose therefore misaligns the rest, and a status
change swaps poses under a fixed seat.

**How to apply:** measure the ground-contact centre for every pose that can
occupy the seat and use an offset midway between the families, so no pose lands
more than a few pixels off its target.

## Name tags belong in their own layer
An agent wrapper that carries a `z-index` (or a transform) opens a stacking
context, so a tag nested inside it can never rise above a nearer sibling
sprite. Render the tags as a separate absolutely-positioned layer above every
sprite, one per seat, and cap their width as a share of the scene with an
ellipsis so two neighbouring tags cannot collide for long agent names.

Because the layers are siblings, a tag cannot react to its own sprite through
CSS alone (`:hover` cannot be correlated across two subtrees by attribute
value). Hover/focus reveal has to go through a "which agent is pointed at"
state on the page. Keep the tags `pointer-events: none`: they sit *under* their
lobster, so a tag that catches the cursor ends the sprite's hover and flickers
itself out of existence.

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
