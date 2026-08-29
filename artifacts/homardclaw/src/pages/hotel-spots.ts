import type { LobsterPose } from "@/components/ui/marlow-lobster";

export type HotelAmenity =
  "library" | "jukebox" | "bar" | "arcade" | "aquarium" | "spa";

export type HotelSpot = {
  amenity: HotelAmenity;
  left: number;
  top: number;
  pose: LobsterPose;
  scale: number;
  activity: string;
  reaction: string;
};

/**
 * Ten appliance anchors measured against the 1586 x 992 hotel artwork.
 * Positions are intentionally staggered so sprite bodies and nameplates do
 * not form a grid or collide when the hotel reaches its full capacity.
 */
export const HOTEL_SPOTS: readonly HotelSpot[] = [
  {
    amenity: "library",
    left: 18.2,
    top: 42.5,
    pose: "hotel-reading",
    scale: 0.95,
    activity: "reading beside the library",
    reaction: "Just one more chapter...",
  },
  {
    amenity: "jukebox",
    left: 35.2,
    top: 37.5,
    pose: "hotel-dancing",
    scale: 1,
    activity: "dancing beside the jukebox",
    reaction: "This one is a classic!",
  },
  {
    amenity: "bar",
    left: 48.5,
    top: 35.8,
    pose: "hotel-drink",
    scale: 0.98,
    activity: "sampling the juice bar",
    reaction: "Retirement tastes tropical.",
  },
  {
    amenity: "arcade",
    left: 67.7,
    top: 36.5,
    pose: "hotel-arcade",
    scale: 1,
    activity: "playing the purple arcade machine",
    reaction: "New high score!",
  },
  {
    amenity: "arcade",
    left: 76.1,
    top: 39.5,
    pose: "hotel-arcade",
    scale: 0.98,
    activity: "playing the turquoise arcade machine",
    reaction: "One more round!",
  },
  {
    amenity: "aquarium",
    left: 84.2,
    top: 40.2,
    pose: "hotel-aquarium",
    scale: 0.96,
    activity: "greeting the aquarium fish",
    reaction: "The fish are excellent company.",
  },
  {
    amenity: "library",
    left: 22.7,
    top: 54.5,
    pose: "hotel-resting",
    scale: 0.94,
    activity: "resting in the library nook",
    reaction: "No deadlines. Just a quiet corner.",
  },
  {
    amenity: "jukebox",
    left: 39.5,
    top: 51.5,
    pose: "hotel-clapping",
    scale: 0.96,
    activity: "clapping along with the jukebox",
    reaction: "Still got it!",
  },
  {
    amenity: "bar",
    left: 57.5,
    top: 39.5,
    pose: "hotel-drink",
    scale: 0.94,
    activity: "sharing a drink at the juice bar",
    reaction: "Cheers from the hotel!",
  },
  {
    amenity: "spa",
    left: 83.2,
    top: 57.5,
    pose: "hotel-spa",
    scale: 0.98,
    activity: "relaxing beside the spa",
    reaction: "Professionally retired.",
  },
] as const;
