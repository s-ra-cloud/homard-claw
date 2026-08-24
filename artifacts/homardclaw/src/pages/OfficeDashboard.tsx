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
import { MarlowLobster, type LobsterPose } from "@/components/ui/marlow-lobster";
import { useQueryClient } from "@tanstack/react-query";
import { useImmersiveMode } from "@/hooks/useImmersiveMode";
import "./office-dashboard.css";

// Use the server-rack edition if available, fall back to the original.
const officeArt = `${import.meta.env.BASE_URL}images/four-desk-office-server.png`;

// Chair centres in the original office scene. Agent sprites are layered on top
// so every employee is rendered by the same canonical component as the roster.
const DESK_SEATS = [
  { left: 29.0, top: 43.0, label: "window desk" },
  { left: 71.0, top: 43.0, label: "library desk" },
  { left: 29.0, top: 72.0, label: "garden desk" },
  { left: 71.0, top: 72.0, label: "filing desk" },
];

// The original scene intentionally leaves its centre open. Each floor pose is
// a complete lobster + cushion + laptop composite, so no floor furniture is
// added to the background and nothing is rendered twice.
const FLOOR_SEATS = [
  { left: 42.0, top: 48.0, label: "floor workstation A" },
  { left: 58.0, top: 48.0, label: "floor workstation B" },
  { left: 42.0, top: 63.0, label: "floor workstation C" },
  { left: 58.0, top: 63.0, label: "floor workstation D" },
];

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
  /** Centre position as a percentage of the room-scene container. */
  left: string;
  top: string;
  /** Hit-area dimensions as percentages. */
  width: string;
  height: string;
  extraClass?: string;
}
export default function OfficeDashboard() {
  const immersive = useImmersiveMode();

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

  return (
    <Shell immersive={immersive}>
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

                {/* ── Desk agent lobsters — click → /agents ── */}
                {deskAgents.map((agent, index) => {
                  const seat = DESK_SEATS[index];
                  return (
                    <div
                      key={agent.id}
                      className="room-agent"
                      style={{ left: `${seat.left}%`, top: `${seat.top}%` }}
                    >
                      <Link
                        href="/agents"
                        className="room-agent__link"
                        aria-label={`${agent.name} at the ${seat.label}`}
                      >
                        <MarlowLobster
                          size={96}
                          pose={stopped ? "seated" : poseForAgent(agent.status, idleActivities[agent.id])}
                          status={stopped ? "paused" : agent.status}
                          shellColor={agent.avatar.shellColor}
                          title={`${agent.name} at the ${seat.label}`}
                        />
                        <span className="room-agent__name">{agent.name}</span>
                      </Link>
                    </div>
                  );
                })}

                {/* ── Floor agent lobsters — click → /agents ── */}
                {floorAgents.map((agent, index) => {
                  const seat = FLOOR_SEATS[index];
                  return (
                    <div
                      key={agent.id}
                      className="room-agent room-agent--floor"
                      style={{ left: `${seat.left}%`, top: `${seat.top}%` }}
                    >
                      <Link
                        href="/agents"
                        className="room-agent__link"
                        aria-label={`${agent.name} at the ${seat.label}`}
                      >
                        <MarlowLobster
                          size={80}
                          pose="floor-working"
                          status={stopped ? "paused" : agent.status}
                          shellColor={agent.avatar.shellColor}
                          title={`${agent.name} at the ${seat.label}`}
                        />
                        <span className="room-agent__name">{agent.name}</span>
                      </Link>
                    </div>
                  );
                })}
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
    left: "82%",
    top: "18%",
    width: "10%",
    height: "10%",
  },
  {
    href: "/tasks",
    label: "Tasks",
    ariaLabel: "Library bookshelf — open Tasks",
    left: "51%",
    top: "13%",
    width: "16%",
    height: "13%",
  },
  {
    href: "/approvals",
    label: "Approvals",
    ariaLabel: "Window desk computer — open Approvals",
    left: "18%",
    top: "31%",
    width: "11%",
    height: "10%",
    extraClass: "scene-hotspot--approval",
  },
  {
    href: "/providers",
    label: "Providers",
    ariaLabel: "Server rack — open Providers",
    left: "87%",
    top: "68%",
    width: "10%",
    height: "13%",
  },
];
