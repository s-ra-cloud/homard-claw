import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, Palmtree } from "lucide-react";
import {
  useListRetiredAgents,
  useListAgentsOnLeave,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import { useIsDesktop, useIsMobile } from "@/hooks/use-mobile";
import { partitionRetiredAgents } from "./retirement-locations";
import "./island.css";

const beachArt = `${import.meta.env.BASE_URL}images/island-beach.jpg`;

// Sprite-safe anchors measured against the open sand in the 1586 × 992 island
// artwork. The rows are staggered and stay clear of the hotel, perimeter rocks,
// shoreline and submarine return hotspot.
const BEACH_SPOTS = [
  { left: 29, top: 46 },
  { left: 42, top: 45 },
  { left: 56, top: 45 },
  { left: 70, top: 47 },
  { left: 22, top: 59 },
  { left: 36, top: 59 },
  { left: 50, top: 58 },
  { left: 64, top: 59 },
  { left: 78, top: 59 },
  { left: 30, top: 72 },
  { left: 47, top: 72 },
  { left: 64, top: 72 },
];

const SALUTES = [
  "o7 — Thank you for your service!",
  "o7 — Enjoy the sun, legend.",
  "o7 — The office remembers.",
  "o7 — Cheers to a job well done!",
];

const LEAVE_SALUTES = [
  "Enjoy the day off!",
  "Soak it up — back tomorrow!",
  "Well earned. See you at 8am!",
];

/** Lightweight CSS-only life around the baked pixel-art background. */
function IslandAmbient() {
  return (
    <div className="island-ambient" aria-hidden="true">
      <i className="island-ambient__glint island-ambient__glint--horizon" />
      <i className="island-ambient__glint island-ambient__glint--foreground" />

      <div className="island-fish-lane island-fish-lane--port">
        <i className="island-fish" />
        <i className="island-fish island-fish--small" />
      </div>
      <div className="island-fish-lane island-fish-lane--starboard">
        <i className="island-fish" />
        <i className="island-fish island-fish--small" />
      </div>

      <div className="island-hotel-lights">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>

      <div className="island-submarine-wake">
        <i />
        <i />
        <i />
      </div>
    </div>
  );
}

export default function IslandPage() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const gameMode = useIsDesktop();
  const isPhone = useIsMobile();
  const sceneImmersive = gameMode || immersive;
  const sceneRef = useRef<HTMLDivElement>(null);
  const [ambientActive, setAmbientActive] = useState(true);
  const { data: retired, isLoading, isError } = useListRetiredAgents();
  const { data: onLeave } = useListAgentsOnLeave();
  const [salute, setSalute] = useState<{ id: string; text: string } | null>(
    null,
  );
  const { beachAgents, hotelAgents } = partitionRetiredAgents(retired ?? []);
  // Day-off Crustabots always land on the beach (never the hotel, which is
  // reserved for permanent retirees) and are appended after them, so the
  // same limited spot layout is shared without disturbing retired agents'
  // positions when someone's leave ends.
  const beachGuests = [
    ...beachAgents.map((agent) => ({ ...agent, onLeave: false as const })),
    ...(onLeave ?? []).map((agent) => ({ ...agent, onLeave: true as const })),
  ];
  const visibleBeachAgents = beachGuests.slice(0, BEACH_SPOTS.length);

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
    if (!salute) return;
    const timer = setTimeout(() => setSalute(null), 2600);
    return () => clearTimeout(timer);
  }, [salute]);

  const handleSalute = (
    id: string,
    index: number,
    onLeaveGuest: boolean,
  ) => {
    const pool = onLeaveGuest ? LEAVE_SALUTES : SALUTES;
    setSalute({ id, text: pool[index % pool.length] });
  };

  return (
    <Shell
      immersive={sceneImmersive}
      onEnterImmersive={gameMode ? undefined : enterImmersive}
    >
      <section className={`island${sceneImmersive ? " is-immersive" : ""}`}>
        <header className="island__bar">
          <div className="island__brand">
            <Palmtree size={14} /> <b>HOMARD</b>CLAW / retirement island
          </div>
          <div className="island__status">
            {retired
              ? `${beachAgents.length} on the beach · ${hotelAgents.length} in the hotel${
                  onLeave && onLeave.length > 0
                    ? ` · ${onLeave.length} on a day off`
                    : ""
                }`
              : "\u00a0"}
          </div>
        </header>

        {isLoading ? (
          <div className="island__state" aria-live="polite">
            <div className="island__wave" aria-hidden="true" />
            <p>Sailing to the island...</p>
          </div>
        ) : isError ? (
          <div className="island__state">
            <AlertTriangle size={40} />
            <h1>Rough seas</h1>
            <p>Could not reach the island. Please try again.</p>
          </div>
        ) : (
          <main className="island__scene-wrap">
            <div className="island__caption">LIVE VIEW / RETIREMENT BEACH</div>
            <div
              ref={sceneRef}
              className={`island__scene${ambientActive ? "" : " is-ambient-paused"}`}
              style={
                {
                  "--island-art": `url("${beachArt}")`,
                } as React.CSSProperties
              }
            >
              <div className="island__landscape">
                <img
                  src={beachArt}
                  alt="Isometric 16-bit tropical retirement island with a boutique hotel, open beach, turquoise water, and a yellow submarine offshore"
                />
                <IslandAmbient />

                <div className="island__actors">
                  <Link
                    href="/island/hotel"
                    className="island__hotel-hotspot"
                    data-label="Enter retirement hotel"
                    aria-label="Turquoise hotel door — enter the retirement hotel"
                  />

                  {!isPhone && (
                    <Link
                      href="/office"
                      className="island__submarine-hotspot"
                      data-label="Return to office"
                      aria-label="Yellow submarine — return to the Office"
                    />
                  )}

                  {visibleBeachAgents.map((agent, i) => {
                    const spot = BEACH_SPOTS[i];
                    const saluting = salute?.id === agent.id;
                    return (
                      <button
                        key={agent.id}
                        className={`island__lobster ${saluting ? "is-saluting" : ""}`}
                        style={{ left: `${spot.left}%`, top: `${spot.top}%` }}
                        onClick={() =>
                          handleSalute(agent.id, i, agent.onLeave)
                        }
                        title={`Salute ${agent.name}`}
                        aria-label={
                          agent.onLeave
                            ? `${agent.name}, ${agent.title}, on an approved day off`
                            : `Salute ${agent.name}, retired ${agent.title}`
                        }
                      >
                        {saluting && (
                          <span className="island__bubble">{salute.text}</span>
                        )}
                        <MarlowLobster
                          size={56}
                          pose="beach"
                          status="idle"
                          seed={agent.id}
                          shellColor={agent.avatar.shellColor}
                        />
                        <span className="island__nametag">
                          {agent.name}
                          {agent.onLeave ? " (day off)" : ""}
                        </span>
                      </button>
                    );
                  })}

                  {retired && visibleBeachAgents.length === 0 && (
                    <div className="island__empty">
                      <h2>
                        {retired.length === 0
                          ? "The beach is empty (for now)"
                          : "Everyone is relaxing inside"}
                      </h2>
                      <p>
                        {retired.length === 0
                          ? "No Crustabot has retired yet. When one hangs up their claws, they'll be here — drink in claw."
                          : "Use the turquoise hotel door to join them in the lounge."}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {((retired && retired.length > 0) ||
              (onLeave && onLeave.length > 0)) && (
              <div className="island__roster">
                {(retired ?? []).map((agent) => (
                  <div key={agent.id} className="island__roster-card">
                    <b>{agent.name}</b>
                    <span>{agent.title}</span>
                    <span className="island__roster-date">
                      retired {new Date(agent.retiredAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
                {(onLeave ?? []).map((agent) => (
                  <div
                    key={agent.id}
                    className="island__roster-card island__roster-card--leave"
                  >
                    <b>{agent.name}</b>
                    <span>{agent.title}</span>
                    <span className="island__roster-date">
                      back{" "}
                      {new Date(agent.onLeaveUntil).toLocaleString(undefined, {
                        weekday: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
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
