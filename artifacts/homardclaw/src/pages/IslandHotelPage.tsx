import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Hotel } from "lucide-react";
import { useListRetiredAgents } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import {
  MarlowLobster,
  POSE_CHARACTER_SCALE,
  type LobsterPose,
} from "@/components/ui/marlow-lobster";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import { useIsDesktop } from "@/hooks/use-mobile";
import { partitionRetiredAgents } from "./retirement-locations";
import "./island.css";
import "./island-hotel.css";

const hotelArt = `${import.meta.env.BASE_URL}images/island-hotel-interior.png`;

type HotelSpot = {
  left: number;
  top: number;
  pose: LobsterPose;
  activity: string;
  reaction: string;
};

/**
 * Ten activity anchors measured against the 1586 × 992 hotel artwork.
 * The back row lines up with the amenities; the front row uses the open floor.
 */
const HOTEL_SPOTS: HotelSpot[] = [
  {
    left: 22,
    top: 43,
    pose: "idle-reading",
    activity: "reading by the library",
    reaction: "Just one more chapter...",
  },
  {
    left: 38,
    top: 42,
    pose: "idle-music",
    activity: "enjoying the jukebox",
    reaction: "This one is a classic!",
  },
  {
    left: 52,
    top: 42,
    pose: "idle-coffee",
    activity: "sampling the juice bar",
    reaction: "Retirement tastes tropical.",
  },
  {
    left: 68,
    top: 43,
    pose: "standing",
    activity: "playing the arcade",
    reaction: "New high score!",
  },
  {
    left: 82,
    top: 44,
    pose: "beach",
    activity: "relaxing by the aquarium",
    reaction: "The fish are excellent company.",
  },
  {
    left: 29,
    top: 60,
    pose: "idle-stretch",
    activity: "stretching on the dance floor",
    reaction: "Still got it!",
  },
  {
    left: 42,
    top: 61,
    pose: "idle-reading",
    activity: "solving a holiday puzzle",
    reaction: "No deadlines, only plot twists.",
  },
  {
    left: 55,
    top: 62,
    pose: "idle-music",
    activity: "listening to island radio",
    reaction: "Perfect vacation rhythm.",
  },
  {
    left: 68,
    top: 61,
    pose: "idle-coffee",
    activity: "having a quiet drink",
    reaction: "Cheers from the hotel!",
  },
  {
    left: 80,
    top: 61,
    pose: "beach",
    activity: "resting beside the spa",
    reaction: "Do not disturb. Professionally retired.",
  },
];

/** Small CSS overlays bring the baked hotel amenities to life. */
function HotelAmbient() {
  return (
    <div className="hotel-ambient" aria-hidden="true">
      <i className="hotel-ambient__jukebox" />
      <div className="hotel-ambient__arcades">
        <i />
        <i />
      </div>
      <div className="hotel-ambient__aquarium">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="hotel-ambient__spa">
        <i />
        <i />
      </div>
    </div>
  );
}

export default function IslandHotelPage() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const gameMode = useIsDesktop();
  const sceneImmersive = gameMode || immersive;
  const sceneRef = useRef<HTMLDivElement>(null);
  const [ambientActive, setAmbientActive] = useState(true);
  const [reaction, setReaction] = useState<{
    id: string;
    text: string;
  } | null>(null);
  const { data: retired, isLoading, isError } = useListRetiredAgents();
  const { hotelAgents } = partitionRetiredAgents(retired ?? []);

  useEffect(() => {
    let visible = document.visibilityState === "visible";
    let onScreen = true;
    const update = () => setAmbientActive(visible && onScreen);
    const onVisibility = () => {
      visible = document.visibilityState === "visible";
      update();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(
            ([entry]) => {
              onScreen = entry.isIntersecting;
              update();
            },
            { threshold: 0.05 },
          );
    if (sceneRef.current) observer?.observe(sceneRef.current);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isLoading]);

  useEffect(() => {
    if (!reaction) return;
    const timer = setTimeout(() => setReaction(null), 2800);
    return () => clearTimeout(timer);
  }, [reaction]);

  return (
    <Shell
      immersive={sceneImmersive}
      onEnterImmersive={gameMode ? undefined : enterImmersive}
    >
      <section
        className={`island island-hotel${sceneImmersive ? " is-immersive" : ""}`}
      >
        <header className="island__bar">
          <div className="island__brand">
            <Hotel size={14} /> <b>HOMARD</b>CLAW / retirement hotel
          </div>
          <div className="island__status">
            {retired
              ? `${hotelAgents.length} hotel guest${hotelAgents.length === 1 ? "" : "s"}`
              : "\u00a0"}
          </div>
        </header>

        {isLoading ? (
          <div className="island__state" aria-live="polite">
            <div className="island__wave" aria-hidden="true" />
            <p>Opening the hotel...</p>
          </div>
        ) : isError ? (
          <div className="island__state">
            <AlertTriangle size={40} />
            <h1>The lobby is closed</h1>
            <p>Could not reach the retirement hotel. Please try again.</p>
          </div>
        ) : (
          <main className="island__scene-wrap">
            <div className="island__caption">LIVE VIEW / RETIREMENT HOTEL</div>
            <div
              ref={sceneRef}
              className={`island__scene${ambientActive ? "" : " is-ambient-paused"}`}
              style={
                {
                  "--island-art": `url("${hotelArt}")`,
                } as React.CSSProperties
              }
            >
              <div className="island__landscape">
                <img
                  src={hotelArt}
                  alt="Isometric 16-bit tropical retirement hotel lounge with a library, jukebox, juice bar, arcade, aquarium, and spa"
                />
                <HotelAmbient />

                <div className="island__actors">
                  <Link
                    href="/island"
                    className="island-hotel__return-hotspot"
                    data-label="Return to the beach"
                    aria-label="Turquoise hotel door — return to Retirement Island"
                  />

                  {hotelAgents.map((agent, index) => {
                    const spot = HOTEL_SPOTS[index];
                    const reacting = reaction?.id === agent.id;
                    const spriteSize = Math.round(
                      52 * POSE_CHARACTER_SCALE[spot.pose],
                    );
                    return (
                      <button
                        key={agent.id}
                        className={`island__lobster island-hotel__guest${reacting ? " is-reacting" : ""}`}
                        style={{
                          left: `${spot.left}%`,
                          top: `${spot.top}%`,
                          zIndex: 20 + Math.round(spot.top),
                        }}
                        onClick={() =>
                          setReaction({ id: agent.id, text: spot.reaction })
                        }
                        title={`${agent.name} is ${spot.activity}`}
                        aria-label={`${agent.name}, retired ${agent.title}, is ${spot.activity}`}
                      >
                        {reacting && (
                          <span className="island__bubble">
                            {reaction.text}
                          </span>
                        )}
                        <MarlowLobster
                          size={spriteSize}
                          pose={spot.pose}
                          status="idle"
                          seed={agent.id}
                          shellColor={agent.avatar.shellColor}
                        />
                        <span className="island__nametag">{agent.name}</span>
                      </button>
                    );
                  })}

                  {hotelAgents.length === 0 && (
                    <div className="island__empty island-hotel__empty">
                      <h2>The lounge is ready</h2>
                      <p>
                        The next hotel guest will arrive after another Crustabot
                        begins their retirement.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {hotelAgents.length > 0 && (
              <div className="island__roster">
                {hotelAgents.map((agent) => (
                  <div key={agent.id} className="island__roster-card">
                    <b>{agent.name}</b>
                    <span>{agent.title}</span>
                    <span className="island__roster-date">
                      retired {new Date(agent.retiredAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </main>
        )}
      </section>
    </Shell>
  );
}
