import React, { useEffect, useState } from "react";
import { AlertTriangle, Palmtree } from "lucide-react";
import { useListRetiredAgents } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import "./island.css";

const beachArt = `${import.meta.env.BASE_URL}images/island-beach.png`;

// Fixed relaxing spots on the beach artwork (percent coordinates).
// There are four painted towels, with two roomy diagonal placements per towel.
// Keeping the anchors on those surfaces prevents beach sprites from landing on
// umbrellas, stools, or the hammock while preserving the eight-agent limit.
const BEACH_SPOTS = [
  { left: 32, top: 61 },  // red towel, upper-left half
  { left: 36, top: 64 },  // red towel, lower-right half
  { left: 57, top: 56 },  // blue towel, upper-left half
  { left: 62, top: 60 },  // blue towel, lower-right half
  { left: 46, top: 84 },  // teal towel, upper-left half
  { left: 51, top: 88 },  // teal towel, lower-right half
  { left: 62, top: 76 },  // yellow towel, upper-left half
  { left: 65, top: 79 },  // yellow towel, lower-right half
];

const SALUTES = [
  "o7 — Thank you for your service!",
  "o7 — Enjoy the sun, legend.",
  "o7 — The office remembers.",
  "o7 — Cheers to a job well done!",
];

export default function IslandPage() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const { data: retired, isLoading, isError } = useListRetiredAgents();
  const [salute, setSalute] = useState<{ id: string; text: string } | null>(null);

  useEffect(() => {
    if (!salute) return;
    const timer = setTimeout(() => setSalute(null), 2600);
    return () => clearTimeout(timer);
  }, [salute]);

  const handleSalute = (id: string, index: number) => {
    setSalute({ id, text: SALUTES[index % SALUTES.length] });
  };

  return (
    <Shell immersive={immersive} onEnterImmersive={enterImmersive}>
      <section className={`island${immersive ? " is-immersive" : ""}`}>
        <header className="island__bar">
          <div className="island__brand">
            <Palmtree size={14} /> <b>HOMARD</b>CLAW / retirement island
          </div>
          <div className="island__status">
            {retired ? `${retired.length} retired agent${retired.length === 1 ? "" : "s"} enjoying the sun` : "\u00a0"}
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
            <div className="island__scene">
              <img
                src={beachArt}
                alt="Isometric pixel-art tropical beach where retired HomardClaw lobster agents relax"
              />
              {(retired ?? []).slice(0, BEACH_SPOTS.length).map((agent, i) => {
                const spot = BEACH_SPOTS[i];
                const saluting = salute?.id === agent.id;
                return (
                  <button
                    key={agent.id}
                    className={`island__lobster ${saluting ? "is-saluting" : ""}`}
                    style={{ left: `${spot.left}%`, top: `${spot.top}%` }}
                    onClick={() => handleSalute(agent.id, i)}
                    title={`Salute ${agent.name}`}
                    aria-label={`Salute ${agent.name}, retired ${agent.title}`}
                  >
                    {saluting && <span className="island__bubble">{salute.text}</span>}
                    <MarlowLobster
                      size={56}
                      pose="beach"
                      status="idle"
                      seed={agent.id}
                      shellColor={agent.avatar.shellColor}
                    />
                    <span className="island__nametag">{agent.name}</span>
                  </button>
                );
              })}
              {retired && retired.length === 0 && (
                <div className="island__empty">
                  <h2>The beach is empty (for now)</h2>
                  <p>No agent has retired yet. When one hangs up their claws, they'll be here — drink in claw.</p>
                </div>
              )}
            </div>

            {retired && retired.length > 0 && (
              <div className="island__roster">
                {retired.map((agent) => (
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
