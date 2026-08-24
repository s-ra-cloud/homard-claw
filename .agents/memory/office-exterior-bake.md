---
name: Office exterior landscape bake
description: How the garden/road landscape behind the office is built and how to rebake it without touching the interior pixels.
---

# The office exterior is a bake, not a redraw

The live-view artwork is a 1536x1024 landscape: an AI-generated isometric
garden/road ground plane with the ORIGINAL office PNG composited, untouched,
at exactly (256, 0). The original interior file stays in the repo as the
source of truth; the overlay coordinate box (`.room-scene`) is pinned to the
office footprint (left 16.6667%, top 0, width 66.6667%, height 100%), so all
seat/hotspot percentages survive any rebake.

**Why:** image generation cannot reproduce the office pixels, and the owner's
coordinate system (seats, tags, hotspots) is calibrated against that exact
artwork. Baking keeps both invariants; regenerating a combined scene would
destroy them.

**How to apply / rebake:**
1. Cut the white surround off the office art with edge floodfills only
   (fuzz ~3%, from the 4 corners + 4 edge midpoints) so interior whites
   (window, papers) survive: `magick <office>.png -alpha set -fuzz 3%
   -fill none -draw 'alpha 0,0 floodfill' ... cutout.png`.
2. Generate/pick a ground plane, scale to 1536 wide (`-filter point`), crop a
   1536x1024 band biased low (+0+280 worked) to keep the road in frame.
3. Soft contact shadow: office silhouette (`-channel RGB -evaluate set 0%`)
   at +256+14, alpha ×0.4, blur 0x7, composited under the cutout.
4. Composite cutout at +256+0. If the canvas or offset ever changes, the
   `.room-scene` inset percentages must change in lockstep.

## Wide immersive companion canvas

A second bake (2048x1024) keeps the exterior byte-for-byte as its left 1536px
and extends right by ping-pong tiling the exterior's own pure-garden strip
(x1280–1536) — mirroring any wider strip drags office pixels into the garden.
A cutaway cabin is composited on the right with the same shadow recipe. The
office footprint there is left 12.5% / width 50%, and the cabin has its own
overlay rect pinned to the composite geometry; if either canvas, offset, or
cabin placement changes, the matching scene-inset percentages must change in
lockstep.

The blurred fill behind the landscape (`.room-art::before`) reuses the same
image via a `--exterior-art` custom property set inline from BASE_URL, so no
viewport aspect exposes a blank band.

To eyeball changes without Clerk credentials, use the throwaway static
harness technique in the scene-placement notes (copy the built CSS into
`public/`, tint the hotspots, delete afterwards).
