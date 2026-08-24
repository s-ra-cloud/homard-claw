import React, { useEffect, useState } from "react";
import { AlertTriangle, Palmtree } from "lucide-react";
import { useListRetiredAgents } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import "./island.css";

const beachArt = `${import.meta.env.BASE_URL}images/island-beach.png`;

// Fixed relaxing spots on the beach artwork (percent coordinates).
// Chairs/loungers are baked into the composite sprite, so these anchors
// point at the towel/shade zones in the furniture-free background art.
const BEACH_SPOTS = [
  { left: 38, top: 54 },  // under the red & white umbrella
  { left: 61, top: 46 },  // under the blue & white umbrella
  { left: 31, top: 69 },  // under the teal umbrella
  { left: 59, top: 69 },  // under the yellow umbrella
  { left: 68, top: 38 },  // hammock between the palms
  { left: 24, top: 52 },  // left tiki bar stool
  { left: 29, top: 55 },  // middle tiki bar stool
  { left: 34, top: 57 },  // right tiki bar stool
];

const SALUTES = [
  "o7 — Thank you for your service!",
  "o7 — Enjoy the sun, legend.",
  "o7 — The office remembers.",
  "o7 — Cheers to a job well done!",
];

export default function IslandPage() {
  const immersive = useImmersiveMode();
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
    <Shell immersive={immersive}>
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
                      size={80}
                      pose="beach"
                      status="idle"
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
