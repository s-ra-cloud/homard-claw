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

// Use the server-rack edition if available, fall back to the original.
const officeArt = `${import.meta.env.BASE_URL}images/four-desk-office-server.png`;

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
  const deskAgents = activeAgents.slice(0, DESK_SEATS.length);
  const floorAgents = activeAgents.slice(DESK_SEATS.length, MAX_VISIBLE);
  const overflowCount = Math.max(0, activeAgents.length - MAX_VISIBLE);

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
          <section className={`room-wrap ${stopped ? "is-paused" : ""}`} aria-label="Live office with four desks and four floor workstations">
            <div className="room-caption">LIVE VIEW / FOUR-DESK OFFICE{stopped ? " / PAUSED" : ""}</div>
            {overflowCount > 0 && (
              <div className="room-overflow" role="status" aria-live="polite">
                +{overflowCount} agent{overflowCount !== 1 ? "s" : ""} in roster — room holds 8 · <Link href="/agents">view all</Link>
              </div>
            )}
            <div className="room-art">
              <div className="room-scene">
                <img src={officeArt} alt="Isometric pixel-art HomardClaw office with four desks and an open central floor" />

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
