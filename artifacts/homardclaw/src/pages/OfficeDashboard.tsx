import React from "react";
import { Link, useLocation } from "wouter";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  useGetOfficeOverview,
  useListAgents,
  useListApprovals,
  useDecideApproval,
  useSetEmergencyStop,
  useGetRuntimeHealth,
  ApprovalDecisionDecision,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import {
  MarlowLobster,
  POSE_CHARACTER_SCALE,
  type LobsterPose,
} from "@/components/ui/marlow-lobster";
import { useQueryClient } from "@tanstack/react-query";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import "./office-dashboard.css";

/**
 * Baked exterior landscape: the untouched pixels of
 * `four-desk-office-server.png` composited onto a garden-and-road ground
 * plane at exactly (256, 0) on a 1536x1024 canvas. The interior artwork is
 * therefore identical to the original file, and `.room-scene` (which owns
 * every percentage coordinate below) is pinned to that same footprint —
 * left 16.6667%, width 66.6667%, full height — so no seat, tag, or hotspot
 * coordinate changed.
 */
const officeArt = `${import.meta.env.BASE_URL}images/four-desk-office-exterior.png`;

/**
 * Wide immersive companion: a 2048x1024 canvas whose left 1536px are the
 * baked exterior above, byte-for-byte (office still at 256,0), extended right
 * with a ping-pong tile of the exterior's own garden strip and a small
 * cutaway sandbox cabin composited at (1490, 260) at 480x466. The office
 * footprint is therefore left 12.5%, width 50%, full height of this canvas,
 * and every seat/tag/hotspot percentage inside `.room-scene` is unchanged.
 */
const wideArt = `${import.meta.env.BASE_URL}images/four-desk-office-wide.png`;

/**
 * The sandbox cabin footprint inside the wide landscape — the exact rectangle
 * the composited cabin occupies — so cabin seat percentages are calibrated
 * against the cabin artwork, independent of the office coordinate frame.
 * 1490/2048, 260/1024, 480/2048, 466/1024.
 */
const CABIN_SCENE = {
  left: 72.7539,
  top: 25.3906,
  width: 23.4375,
  height: 45.5078,
} as const;

// Cabin floor mats, calibrated by compositing the shipped floor-working
// sprite (95px on the 2048 canvas) onto the cabin floor diamond. Percentages
// of the cabin scene rect above.
const CABIN_SEATS = [
  { left: 49.6, top: 51.5, label: "back cabin floor mat" },
  { left: 30.8, top: 63.7, label: "left cabin floor mat" },
  { left: 68.3, top: 63.7, label: "right cabin floor mat" },
  { left: 49.6, top: 76.0, label: "front cabin floor mat" },
];

/**
 * Cabin sprites keep the office character size: 95px of the 2048 canvas is
 * the same artwork footprint as a floor agent in the office, expressed as a
 * share of the 480px cabin scene (95/480).
 */
const CABIN_SPRITE_PCT = 19.79;

/**
 * The cabin only exists in immersive mode on a genuinely wide display —
 * MacBook-style 16:10 and wider — where the 2:1 canvas fills the viewport
 * without shrinking the office below its normal immersive size.
 */
const WIDE_SCENE_QUERY = "(min-width: 1000px) and (min-aspect-ratio: 3/2)";

function useWideScene(): boolean {
  const [wide, setWide] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia(WIDE_SCENE_QUERY).matches,
  );
  React.useEffect(() => {
    const mq = window.matchMedia(WIDE_SCENE_QUERY);
    const onChange = () => setWide(mq.matches);
    mq.addEventListener("change", onChange);
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

// Chair centres in the original office scene, measured from the artwork: each
// seat sits in the middle of its desk's knee space, between the two drawer
// pedestals. The desks are not exact mirrors, so the right-hand seats do not
// mirror the left-hand ones. Agent sprites are layered on top so every
// employee is rendered by the same canonical component as the roster.
const DESK_SEATS = [
  { left: 29.0, top: 43.0, label: "window desk" }, // knee space 25.0–35.2%
  { left: 73.0, top: 43.0, label: "library desk" }, // knee space 68.2–78.1%
  { left: 29.0, top: 72.0, label: "garden desk" }, // knee space 25.0–33.8%
  { left: 69.5, top: 72.0, label: "filing desk" }, // knee space 65.0–73.4%
];

// Open floorboards in the original scene, measured by compositing the sprites
// onto the room artwork. The floor is not one open square: the two lower rooms
// are walled off by diagonals that cut in from (15%, 46%) and (79%, 51%), so
// the usable space is the area between the back desks, a corridor pinched to
// x 38%-60% between the front desks' inner corners, and the floor in front of
// them. The four seats are spread across those three areas rather than stacked
// down the centre, and each one keeps a margin to every desk, cabinet, plant
// and wall at the sizes below.
// Each floor pose is a complete lobster + cushion + laptop composite, so no
// floor furniture is added to the background and nothing is rendered twice.
const FLOOR_SEATS = [
  { left: 44.0, top: 44.0, label: "back floor mat" },
  { left: 57.0, top: 47.0, label: "library-side floor mat" },
  { left: 41.0, top: 66.0, label: "corridor floor mat" },
  { left: 55.0, top: 79.0, label: "front floor mat" },
];

/**
 * One character size for the whole room, as a share of the (square) scene
 * container, so the lobsters scale with the artwork instead of drifting
 * against it: 8.7% renders the chair poses at ~12.4% of the room, the share a
 * 96px desk agent covered on a desktop before the sprites were pinned to
 * pixels. Both groups are driven from this one number, so a floor agent can
 * never end up a different size from a desk agent.
 */
const CHARACTER_PCT = 8.7;
/**
 * Floor cushions overlap by depth: the further back a mat sits, the lower it
 * draws. Everything stays below the desk agents, which own z-index 12.
 */
function floorZIndex(top: number) {
  return 3 + Math.round(top / 10);
}

const DESK_Z_INDEX = 12;
const MAX_VISIBLE = DESK_SEATS.length + FLOOR_SEATS.length; // 8

/** Breaks an agent can take between tasks. */
const IDLE_ACTIVITIES = [
  "idle-coffee",
  "idle-music",
  "idle-reading",
  "idle-stretch",
] as const satisfies readonly LobsterPose[];

type IdleActivity = (typeof IDLE_ACTIVITIES)[number];

/** Statuses where the agent turns to face its desk. */
const AT_DESK_STATUSES = new Set(["working", "researching"]);

function randomIdleActivity(): IdleActivity {
  return IDLE_ACTIVITIES[Math.floor(Math.random() * IDLE_ACTIVITIES.length)];
}

function poseForAgent(
  status: string,
  activity: IdleActivity | undefined,
): LobsterPose {
  if (AT_DESK_STATUSES.has(status)) return "working";
  // An idle agent briefly renders plain-seated until the transition effect
  // assigns its activity; picking here instead would reshuffle every render.
  if (status === "idle" && activity) return activity;
  return "seated";
}

/**
 * Scene shortcut hotspots layered over the office artwork.
 * Agent seats are handled separately as focusable Link wrappers;
 * these cover static props: beach picture, library, approvals computer, server unit.
 */
interface SceneHotspot {
  href: string;
  label: string;         // shown as tooltip on hover/focus
  ariaLabel: string;     // accessible name for screen readers
  /**
   * Centre position as a percentage of the room-scene container. `.scene-hotspot`
   * applies `transform: translate(-50%, -50%)`, so these are the centre of the hit
   * rectangle, NOT its top-left corner: the covered band is left ± width/2 and
   * top ± height/2.
   */
  left: string;
  top: string;
  /** Hit-area dimensions as percentages. */
  width: string;
  height: string;
  extraClass?: string;
}
export default function OfficeDashboard() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const isWideViewport = useWideScene();

  const { data: overview, isLoading, isError } = useGetOfficeOverview();
  const {
    data: agents,
    isLoading: agentsLoading,
    isError: agentsError,
  } = useListAgents();
  const { data: approvals } = useListApprovals();
  // Polls so a stalled queue or a lost worker lease surfaces on its own.
  const { data: runtimeHealth } = useGetRuntimeHealth({
    query: { queryKey: ["/api/runtime/health"], refetchInterval: 10000 },
  });
  const queryClient = useQueryClient();

  // One break activity per idle period: assigned when an agent is first seen
  // idle (or returns to idle after work), kept across refetches, and cleared
  // as soon as the agent leaves idle so its next break reshuffles.
  const [idleActivities, setIdleActivities] = React.useState<
    Record<string, IdleActivity>
  >({});

  React.useEffect(() => {
    if (!agents) return;
    setIdleActivities((prev) => {
      let next = prev;
      const ensureCopy = () => {
        if (next === prev) next = { ...prev };
      };
      const seen = new Set<string>();
      for (const agent of agents) {
        seen.add(agent.id);
        if (agent.status === "idle") {
          if (!(agent.id in next)) {
            ensureCopy();
            next[agent.id] = randomIdleActivity();
          }
        } else if (agent.id in next) {
          ensureCopy();
          delete next[agent.id];
        }
      }
      for (const id of Object.keys(next)) {
        if (!seen.has(id)) {
          ensureCopy();
          delete next[id];
        }
      }
      return next;
    });
  }, [agents]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
    queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
    queryClient.invalidateQueries({ queryKey: ["/api/approvals"] });
  };

  const setEmergencyStop = useSetEmergencyStop({ mutation: { onSuccess: invalidate } });
  const decideApproval = useDecideApproval({ mutation: { onSuccess: invalidate } });

  const handleEmergencyStop = () => {
    if (!overview) return;
    const nextState = !overview.emergencyStop;
    const prompt = nextState
      ? "INITIATE EMERGENCY STOP? This will halt ALL active agents and tasks immediately."
      : "LIFT EMERGENCY STOP? Agents will resume normal operations.";
    if (window.confirm(prompt)) setEmergencyStop.mutate({ data: { active: nextState } });
  };

  if (isLoading || agentsLoading) {
    return (
      <Shell>
        <section className="iso-office iso-office--state" aria-live="polite">
          <div className="iso-claw" aria-hidden="true" />
          <p>Warming up the office...</p>
        </section>
      </Shell>
    );
  }

  if (isError || agentsError || !overview) {
    return (
      <Shell>
        <section className="iso-office iso-office--state">
          <AlertTriangle size={40} />
          <h1>System error</h1>
          <p>Failed to reach the office mainframe. Please try again.</p>
        </section>
      </Shell>
    );
  }

  const stopped = overview.emergencyStop;
  // Runtime health: what is actually executing work, how deep the durable
  // queue is, and which runtimes are present but unavailable.
  const activeRuntime = runtimeHealth?.runtimes.find(
    (runtime) => runtime.id === runtimeHealth.activeRuntime,
  );
  const runtimeLabel = activeRuntime
    ? activeRuntime.status === "ready"
      ? runtimeHealth!.worker.leaseHeld
        ? "steady"
        : "standby"
      : activeRuntime.status.replace(/_/g, " ")
    : "checking";
  const queued = runtimeHealth?.queue.queued ?? 0;
  const running = runtimeHealth?.queue.running ?? 0;
  const oldestQueued = runtimeHealth?.queue.oldestQueuedSeconds ?? null;
  // Work sitting unclaimed for minutes means nothing is draining the queue.
  const queueStalled = queued > 0 && (oldestQueued ?? 0) > 300;
  const queueLabel =
    queued === 0 && running === 0
      ? "empty"
      : `${running} running · ${queued} waiting${
          queueStalled ? ` · oldest ${Math.round((oldestQueued ?? 0) / 60)}m` : ""
        }`;
  const offlineRuntimes = (runtimeHealth?.runtimes ?? []).filter(
    (runtime) => !runtime.acceptsWork,
  );
  const nextApproval = approvals?.find((a) => a.status === "pending");
  const justDecided = decideApproval.isSuccess ? decideApproval.variables : undefined;
  const hasPendingApprovals = (overview.pendingApprovals ?? 0) > 0;

  const activeAgents = (agents ?? []).filter((a) => !a.archived);
  // The cabin exists only in the wide immersive presentation; every other
  // view keeps the exact current scene and agent allocation.
  const wideScene = immersive && isWideViewport;
  const sandboxedAgents = wideScene
    ? activeAgents.filter((a) => a.sensitiveDataSandbox)
    : [];
  const officeAgents = wideScene
    ? activeAgents.filter((a) => !a.sensitiveDataSandbox)
    : activeAgents;
  const cabinAgents = sandboxedAgents.slice(0, CABIN_SEATS.length);
  const cabinOverflowCount = Math.max(0, sandboxedAgents.length - CABIN_SEATS.length);
  const deskAgents = officeAgents.slice(0, DESK_SEATS.length);
  const floorAgents = officeAgents.slice(DESK_SEATS.length, MAX_VISIBLE);
  const overflowCount = Math.max(0, officeAgents.length - MAX_VISIBLE);

  // Every seated agent, sprite size included, so the name tags can be drawn as
  // one layer on top of every lobster instead of inside their own sprite's
  // stacking context, where a nearer neighbour would cover them.
  const seatedAgents = [
    ...floorAgents.map((agent, index) => {
      const seat = FLOOR_SEATS[index];
      return {
        agent,
        seat,
        pose: "floor-working" as LobsterPose,
        zIndex: floorZIndex(seat.top),
      };
    }),
    ...deskAgents.map((agent, index) => ({
      agent,
      seat: DESK_SEATS[index],
      pose: stopped
        ? ("seated" as LobsterPose)
        : poseForAgent(agent.status, idleActivities[agent.id]),
      zIndex: DESK_Z_INDEX,
    })),
  ];

  return (
    <Shell immersive={immersive} onEnterImmersive={enterImmersive}>
      <section className={`iso-office${immersive ? " is-immersive" : ""}`}>
        <header className="iso-office__bar">
          <div className="iso-office__brand">
            <b>HOMARD</b>CLAW / four-desk office
          </div>
          <div className={`iso-office__status ${stopped ? "is-halted" : ""}`}>
            <i className="signal" /> {stopped ? "office paused — all agents held" : "systems warm & working"}
          </div>
        </header>

        {stopped && (
          <div className="iso-office__halt" role="status">
            <AlertTriangle size={14} /> Emergency stop holds every agent until you resume office operations.
          </div>
        )}

        <main className="iso-office__layout">
          <section
            className={`room-wrap ${stopped ? "is-paused" : ""}`}
            aria-label={
              wideScene
                ? "Live office with four desks, four floor workstations, and a garden sandbox cabin for agents in the sensitive data sandbox"
                : "Live office with four desks and four floor workstations"
            }
          >
            <div className="room-caption">LIVE VIEW / FOUR-DESK OFFICE{stopped ? " / PAUSED" : ""}</div>
            {overflowCount > 0 && (
              <div className="room-overflow" role="status" aria-live="polite">
                +{overflowCount} agent{overflowCount !== 1 ? "s" : ""} in roster — room holds 8 · <Link href="/agents">view all</Link>
              </div>
            )}
            {wideScene && cabinOverflowCount > 0 && (
              <div className="room-overflow" role="status" aria-live="polite">
                +{cabinOverflowCount} sandboxed agent{cabinOverflowCount !== 1 ? "s" : ""} beyond the cabin's 4 mats · <Link href="/agents">view all</Link>
              </div>
            )}
            <div
              className="room-art"
              /* Feeds the blurred fill-backdrop; keeps the URL on BASE_URL. */
              style={{ "--exterior-art": `url("${wideScene ? wideArt : officeArt}")` } as React.CSSProperties}
            >
              <div className={`room-landscape${wideScene ? " room-landscape--wide" : ""}`}>
                <img
                  src={wideScene ? wideArt : officeArt}
                  alt={
                    wideScene
                      ? "Isometric pixel-art HomardClaw office with four desks on the left and a small garden sandbox cabin on the right, surrounded by a garden and a road"
                      : "Isometric pixel-art HomardClaw office with four desks, surrounded by a garden and a road"
                  }
                />
                <div className="room-scene">

                {/* ── Static scene navigation hotspots ── */}
                {SCENE_HOTSPOTS.map((spot) => (
                  <Link
                    key={spot.href}
                    href={spot.href}
                    className={`scene-hotspot ${spot.extraClass ?? ""}${
                      spot.extraClass === "scene-hotspot--approval" && hasPendingApprovals
                        ? " has-pending"
                        : ""
                    }`}
                    data-label={spot.label}
                    aria-label={spot.ariaLabel}
                    style={{
                      left: spot.left,
                      top: spot.top,
                      width: spot.width,
                      height: spot.height,
                    }}
                  />
                ))}

                {/* ── Agent lobsters, desk and floor — click → /agents ── */}
                {seatedAgents.map(({ agent, seat, pose, zIndex }) => (
                  <div
                    key={agent.id}
                    className="room-agent"
                    style={{
                      left: `${seat.left}%`,
                      top: `${seat.top}%`,
                      // Share of the room, per pose, so every lobster is the
                      // same character size whatever furniture it comes with.
                      width: `${spritePct(pose)}%`,
                      zIndex,
                    }}
                  >
                    <Link
                      href="/agents"
                      className="room-agent__link"
                      aria-label={`${agent.name} at the ${seat.label}`}
                    >
                      <MarlowLobster
                        pose={pose}
                        status={stopped ? "paused" : agent.status}
                        seed={agent.id}
                        shellColor={agent.avatar.shellColor}
                        title={`${agent.name} at the ${seat.label}`}
                      />
                    </Link>
                  </div>
                ))}

                {/* ── Name tags, above every sprite so none can be hidden ── */}
                {seatedAgents.map(({ agent, seat, pose }) => (
                  <Link
                    key={`${agent.id}-name`}
                    href="/agents"
                    className="room-agent__name"
                    style={{
                      left: `${seat.left}%`,
                      top: `calc(${seat.top + spritePct(pose) / 2}% - 2px)`,
                    }}
                    /* The sprite above already carries this agent's link. */
                    aria-hidden="true"
                    tabIndex={-1}
                    title={agent.name}
                  >
                    {agent.name}
                  </Link>
                ))}
                </div>

                {/* ── Sandbox cabin — wide immersive only ── */}
                {wideScene && (
                  <div
                    className="cabin-scene"
                    role="group"
                    aria-label={`Sandbox cabin — a separate garden cabin where agents in the sensitive data sandbox work${cabinAgents.length === 0 ? "; currently empty" : ""}`}
                    style={{
                      left: `${CABIN_SCENE.left}%`,
                      top: `${CABIN_SCENE.top}%`,
                      width: `${CABIN_SCENE.width}%`,
                      height: `${CABIN_SCENE.height}%`,
                    }}
                  >
                    {cabinAgents.map((agent, index) => {
                      const seat = CABIN_SEATS[index];
                      return (
                        <div
                          key={agent.id}
                          className="room-agent"
                          style={{
                            left: `${seat.left}%`,
                            top: `${seat.top}%`,
                            width: `${CABIN_SPRITE_PCT}%`,
                            zIndex: floorZIndex(seat.top),
                          }}
                        >
                          <Link
                            href="/agents"
                            className="room-agent__link"
                            aria-label={`${agent.name} on the ${seat.label} in the sandbox cabin`}
                          >
                            <MarlowLobster
                              pose="floor-working"
                              status={stopped ? "paused" : agent.status}
                              seed={agent.id}
                              shellColor={agent.avatar.shellColor}
                              title={`${agent.name} on the ${seat.label} in the sandbox cabin`}
                            />
                          </Link>
                        </div>
                      );
                    })}
                    {cabinAgents.map((agent, index) => {
                      const seat = CABIN_SEATS[index];
                      return (
                        <Link
                          key={`${agent.id}-name`}
                          href="/agents"
                          className="room-agent__name"
                          style={{
                            left: `${seat.left}%`,
                            top: `calc(${seat.top + CABIN_SPRITE_PCT / 2}% - 2px)`,
                          }}
                          /* The sprite above already carries this agent's link. */
                          aria-hidden="true"
                          tabIndex={-1}
                          title={agent.name}
                        >
                          {agent.name}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>

          <aside className="side-panel">
            <section className="quiet-card rail-control">
              <h2>Safety control</h2>
              <button
                className={`iso-office__stop ${stopped ? "is-paused" : ""}`}
                onClick={handleEmergencyStop}
                disabled={setEmergencyStop.isPending}
              >
                {setEmergencyStop.isPending ? "UPDATING..." : stopped ? "RESUME OFFICE" : "EMERGENCY STOP"}
              </button>
            </section>

            <section className="quiet-card">
              <h2>Office pulse</h2>
              <div className="summary">
                <Link href="/agents"><b>{String(overview.agents).padStart(2, "0")}</b>agents</Link>
                <Link href="/tasks"><b>{String(overview.activeTasks).padStart(2, "0")}</b>tasks</Link>
                <Link href="/approvals"><b>{String(overview.pendingApprovals).padStart(2, "0")}</b>reviews</Link>
              </div>
            </section>

            <section className="quiet-card">
              <h2>Systems</h2>
              <div className="system-row">
                <i className={`signal ${stopped ? "is-halted" : ""}`} /> Agent runtime <span>{stopped ? "paused" : runtimeLabel}</span>
              </div>
              <div className="system-row">
                <i className={`signal ${queueStalled ? "is-halted" : ""}`} /> Work queue <span>{queueLabel}</span>
              </div>
              <div className="system-row">
                <i className="signal" /> Approval queue <span>{overview.pendingApprovals > 0 ? `${overview.pendingApprovals} waiting` : "clear"}</span>
              </div>
              <div className="system-row">
                <i className="signal" /> Monthly compute <span>${(overview.monthlyCostCents / 100).toFixed(2)}</span>
              </div>
              {offlineRuntimes.map((runtime) => (
                <div className="system-row" key={runtime.id} title={runtime.detail}>
                  <i className="signal is-halted" /> {runtime.label}{" "}
                  <span>{runtime.status.replace(/_/g, " ")}</span>
                </div>
              ))}
            </section>

            <section className="quiet-card approval">
              <h2>One thing needs you</h2>
              {nextApproval ? (
                <>
                  <p>
                    <b>{nextApproval.agentName}</b> wants to {nextApproval.action}
                    {nextApproval.details ? ` — ${nextApproval.details}` : ""}
                  </p>
                  <div className="approval-actions">
                    <button
                      onClick={() => decideApproval.mutate({ approvalId: nextApproval.id, data: { decision: ApprovalDecisionDecision.approved } })}
                      disabled={decideApproval.isPending}
                    >
                      APPROVE
                    </button>
                    <button
                      className="hold"
                      onClick={() => decideApproval.mutate({ approvalId: nextApproval.id, data: { decision: ApprovalDecisionDecision.rejected } })}
                      disabled={decideApproval.isPending}
                    >
                      HOLD
                    </button>
                  </div>
                </>
              ) : justDecided ? (
                <div className="approved">
                  {justDecided.data.decision === "approved" ? "CLEARED — the agent has the go-ahead." : "HELD — the request was declined."}
                </div>
              ) : (
                <p className="approval-empty">Nothing is waiting on your review.</p>
              )}
              <Link className="approval-link" href="/approvals">
                <ShieldCheck size={12} /> full approval desk
              </Link>
            </section>
          </aside>
        </main>
      </section>
    </Shell>
  );
}

const SCENE_HOTSPOTS: SceneHotspot[] = [
  {
    href: "/island",
    label: "Retirement Island",
    ariaLabel: "Beach painting — open Retirement Island",
    // Frame spans 84.2–93.1% × 20.8–31.6% of the artwork.
    // Centre-anchored hit area covers 84.0–93.0% × 20.75–31.25%.
    left: "88.5%",
    top: "26%",
    width: "9%",
    height: "10.5%",
  },
  {
    href: "/tasks",
    label: "Tasks",
    ariaLabel: "Library bookshelf — open Tasks",
    // Bookcase carcass spans 52.7–70.3% × 9.1–33.2%; inset slightly so the
    // hit area stops short of the adjoining desk.
    // Centre-anchored hit area covers 52.5–69.5% × 9.5–32.5%.
    left: "61%",
    top: "21%",
    width: "17%",
    height: "23%",
  },
  {
    href: "/approvals",
    label: "Approvals",
    ariaLabel: "Window desk computer — open Approvals",
    // Monitor (20.3–28.5% × 23.9–33.2%) plus the keyboard in front of it.
    // Centre-anchored hit area covers 20.25–30.75% × 23.75–35.25%.
    left: "25.5%",
    top: "29.5%",
    width: "10.5%",
    height: "11.5%",
    extraClass: "scene-hotspot--approval",
  },
  {
    href: "/providers",
    label: "Providers",
    ariaLabel: "Server rack — open Providers",
    // Rack spans 81.9–98.0% × 55.8–86.3%; kept a hair inside those edges.
    // Centre-anchored hit area covers 82.0–97.0% × 57.0–85.0%.
    left: "89.5%",
    top: "71%",
    width: "15%",
    height: "28%",
  },
];

/** Sprite box a pose needs to show the character at CHARACTER_PCT. */
function spritePct(pose: LobsterPose) {
  return CHARACTER_PCT * POSE_CHARACTER_SCALE[pose];
}
