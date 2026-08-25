import React from "react";
import { Link } from "wouter";
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

/** The full 1586 × 992 submarine illustration is the scene coordinate plane. */
const officeArt = `${import.meta.env.BASE_URL}images/submarine-office.png`;

// Four wall computers inside the hull. These positions are deliberately clear
// of the wall navigation targets and keep the existing seated lobster poses.
const DESK_SEATS = [
  { left: 42.3, top: 50.8, label: "first submarine computer" },
  { left: 49.4, top: 50.8, label: "second submarine computer" },
  { left: 56.4, top: 50.8, label: "third submarine computer" },
  { left: 63.4, top: 50.8, label: "fourth submarine computer" },
];

// Clear deck positions. The floor-working pose already includes its cushion
// and laptop, so the background intentionally contains no duplicate furniture.
const FLOOR_SEATS = [
  { left: 34.0, top: 64.0, label: "port deck" },
  { left: 44.0, top: 69.5, label: "centre-left deck" },
  { left: 54.5, top: 69.5, label: "centre-right deck" },
  { left: 64.0, top: 64.0, label: "starboard deck" },
];

// Sandboxed agents are physically separated from the hull on exterior pads.
const EXTERIOR_SEATS = [
  { left: 23.5, top: 79.5, label: "port exterior platform" },
  { left: 68.0, top: 81.0, label: "starboard exterior platform" },
  { left: 10.5, top: 88.0, label: "port seabed station" },
  { left: 89.5, top: 87.0, label: "starboard reef station" },
];

/** Character size as a share of the wide scene, preserving the old pixel size. */
const CHARACTER_PCT = 5.8;
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
 * these cover the submarine's wall controls, screens, racks and porthole.
 */
interface SceneHotspot {
  href: string;
  label: string; // shown as tooltip on hover/focus
  ariaLabel: string; // accessible name for screen readers
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

const BUBBLE_STREAMS = [5, 18, 31, 72, 83, 95];

/** Decorative motion stays outside the hull and never captures pointer input. */
function OceanAmbient() {
  return (
    <div className="ocean-ambient" aria-hidden="true">
      <i className="ocean-caustics" />
      <div className="fish-lane fish-lane--port">
        <i className="pixel-fish" />
        <i className="pixel-fish pixel-fish--small" />
        <i className="pixel-fish pixel-fish--high" />
      </div>
      <div className="fish-lane fish-lane--starboard">
        <i className="pixel-fish" />
        <i className="pixel-fish pixel-fish--small" />
        <i className="pixel-fish pixel-fish--high" />
      </div>
      {BUBBLE_STREAMS.map((left, stream) => (
        <div
          className={`bubble-stream ${stream % 2 === 0 ? "bubble-stream--upper" : "bubble-stream--lower"}`}
          style={{ left: `${left}%` }}
          key={left}
        >
          {[0, 1, 2, 3].map((bubble) => (
            <i
              key={bubble}
              style={{
                animationDelay: `${-(stream * 0.7 + bubble * 1.1)}s`,
                left: `${(bubble * 7 + stream * 3) % 15}px`,
              }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export default function OfficeDashboard() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const roomRef = React.useRef<HTMLElement>(null);
  const [ambientActive, setAmbientActive] = React.useState(true);

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

  React.useEffect(() => {
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
    if (roomRef.current) observer?.observe(roomRef.current);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [agentsLoading, isLoading]);

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

  const setEmergencyStop = useSetEmergencyStop({
    mutation: { onSuccess: invalidate },
  });
  const decideApproval = useDecideApproval({
    mutation: { onSuccess: invalidate },
  });

  const handleEmergencyStop = () => {
    if (!overview) return;
    const nextState = !overview.emergencyStop;
    const prompt = nextState
      ? "INITIATE EMERGENCY STOP? This will halt ALL active agents and tasks immediately."
      : "LIFT EMERGENCY STOP? Agents will resume normal operations.";
    if (window.confirm(prompt))
      setEmergencyStop.mutate({ data: { active: nextState } });
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
          queueStalled
            ? ` · oldest ${Math.round((oldestQueued ?? 0) / 60)}m`
            : ""
        }`;
  const offlineRuntimes = (runtimeHealth?.runtimes ?? []).filter(
    (runtime) => !runtime.acceptsWork,
  );
  const nextApproval = approvals?.find((a) => a.status === "pending");
  const justDecided = decideApproval.isSuccess
    ? decideApproval.variables
    : undefined;
  const hasPendingApprovals = (overview.pendingApprovals ?? 0) > 0;

  const activeAgents = (agents ?? []).filter((a) => !a.archived);
  const sandboxedAgents = activeAgents.filter((a) => a.sensitiveDataSandbox);
  const officeAgents = activeAgents.filter((a) => !a.sensitiveDataSandbox);
  const exteriorAgents = sandboxedAgents.slice(0, EXTERIOR_SEATS.length);
  const deskAgents = officeAgents.slice(0, DESK_SEATS.length);
  const floorAgents = officeAgents.slice(DESK_SEATS.length, MAX_VISIBLE);
  const overflowCount =
    Math.max(0, officeAgents.length - MAX_VISIBLE) +
    Math.max(0, sandboxedAgents.length - EXTERIOR_SEATS.length);

  // Every visible agent, sprite size included, so the name tags can be drawn as
  // one layer on top of every lobster instead of inside their own sprite's
  // stacking context, where a nearer neighbour would cover them.
  const placedAgents = [
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
    ...exteriorAgents.map((agent, index) => ({
      agent,
      seat: EXTERIOR_SEATS[index],
      pose: "standing" as LobsterPose,
      zIndex: floorZIndex(EXTERIOR_SEATS[index].top),
    })),
  ];

  return (
    <Shell immersive={immersive} onEnterImmersive={enterImmersive}>
      <section className={`iso-office${immersive ? " is-immersive" : ""}`}>
        <header className="iso-office__bar">
          <div className="iso-office__brand">
            <b>HOMARD</b>CLAW / yellow submarine office
          </div>
          <div className={`iso-office__status ${stopped ? "is-halted" : ""}`}>
            <i className="signal" />{" "}
            {stopped
              ? "office paused — all agents held"
              : "systems warm & working"}
          </div>
        </header>

        {stopped && (
          <div className="iso-office__halt" role="status">
            <AlertTriangle size={14} /> Emergency stop holds every agent until
            you resume office operations.
          </div>
        )}

        <main className="iso-office__layout">
          <section
            ref={roomRef}
            className={`room-wrap ${stopped ? "is-paused" : ""}${ambientActive ? "" : " is-ambient-paused"}`}
            aria-label="Live underwater submarine office with four computers, an open deck, and exterior stations for sandboxed agents"
          >
            <div className="room-caption">
              LIVE VIEW / YELLOW SUBMARINE{stopped ? " / PAUSED" : ""}
            </div>
            {overflowCount > 0 && (
              <div className="room-overflow" role="status" aria-live="polite">
                +{overflowCount} agent{overflowCount !== 1 ? "s" : ""} in roster
                beyond the visible stations ·{" "}
                <Link href="/agents">view all</Link>
              </div>
            )}
            <div
              className="room-art"
              /* Feeds the blurred fill-backdrop; keeps the URL on BASE_URL. */
              style={
                {
                  "--exterior-art": `url("${officeArt}")`,
                } as React.CSSProperties
              }
            >
              <div className="room-landscape">
                <img
                  src={officeArt}
                  alt="Isometric 16-bit yellow submarine office with four computers, an open wooden deck, wall control stations, exterior platforms, fish and bubbles"
                />
                <OceanAmbient />
                <div className="room-scene">
                  {/* ── Static scene navigation hotspots ── */}
                  {SCENE_HOTSPOTS.map((spot) => (
                    <Link
                      key={spot.href}
                      href={spot.href}
                      className={`scene-hotspot ${spot.extraClass ?? ""}${
                        spot.extraClass === "scene-hotspot--approval" &&
                        hasPendingApprovals
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

                  <button
                    type="button"
                    className={`scene-emergency${stopped ? " is-stopped" : ""}`}
                    onClick={handleEmergencyStop}
                    disabled={setEmergencyStop.isPending}
                    aria-label={
                      stopped
                        ? "Resume all agents"
                        : "Emergency stop: urgently pause all agents"
                    }
                    data-label={stopped ? "Resume agents" : "Emergency stop"}
                  />

                  {/* Existing lobster sprites; click an agent to open its Talk view. */}
                  {placedAgents.map(({ agent, seat, pose, zIndex }) => (
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
                        href={`/talk/${agent.id}`}
                        className="room-agent__link"
                        aria-label={`Talk to ${agent.name} at the ${seat.label}`}
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
                  {placedAgents.map(({ agent, seat, pose }) => (
                    <Link
                      key={`${agent.id}-name`}
                      href={`/talk/${agent.id}`}
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
                {setEmergencyStop.isPending
                  ? "UPDATING..."
                  : stopped
                    ? "RESUME OFFICE"
                    : "EMERGENCY STOP"}
              </button>
            </section>

            <section className="quiet-card">
              <h2>Office pulse</h2>
              <div className="summary">
                <Link href="/agents">
                  <b>{String(overview.agents).padStart(2, "0")}</b>agents
                </Link>
                <Link href="/tasks">
                  <b>{String(overview.activeTasks).padStart(2, "0")}</b>tasks
                </Link>
                <Link href="/approvals">
                  <b>{String(overview.pendingApprovals).padStart(2, "0")}</b>
                  reviews
                </Link>
              </div>
            </section>

            <section className="quiet-card">
              <h2>Systems</h2>
              <div className="system-row">
                <i className={`signal ${stopped ? "is-halted" : ""}`} /> Agent
                runtime <span>{stopped ? "paused" : runtimeLabel}</span>
              </div>
              <div className="system-row">
                <i className={`signal ${queueStalled ? "is-halted" : ""}`} />{" "}
                Work queue <span>{queueLabel}</span>
              </div>
              <div className="system-row">
                <i className="signal" /> Approval queue{" "}
                <span>
                  {overview.pendingApprovals > 0
                    ? `${overview.pendingApprovals} waiting`
                    : "clear"}
                </span>
              </div>
              <div className="system-row">
                <i className="signal" /> Monthly compute{" "}
                <span>${(overview.monthlyCostCents / 100).toFixed(2)}</span>
              </div>
              {offlineRuntimes.map((runtime) => (
                <div
                  className="system-row"
                  key={runtime.id}
                  title={runtime.detail}
                >
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
                    <b>{nextApproval.agentName}</b> wants to{" "}
                    {nextApproval.action}
                    {nextApproval.details ? ` — ${nextApproval.details}` : ""}
                  </p>
                  <div className="approval-actions">
                    <button
                      onClick={() =>
                        decideApproval.mutate({
                          approvalId: nextApproval.id,
                          data: { decision: ApprovalDecisionDecision.approved },
                        })
                      }
                      disabled={decideApproval.isPending}
                    >
                      APPROVE
                    </button>
                    <button
                      className="hold"
                      onClick={() =>
                        decideApproval.mutate({
                          approvalId: nextApproval.id,
                          data: { decision: ApprovalDecisionDecision.rejected },
                        })
                      }
                      disabled={decideApproval.isPending}
                    >
                      HOLD
                    </button>
                  </div>
                </>
              ) : justDecided ? (
                <div className="approved">
                  {justDecided.data.decision === "approved"
                    ? "CLEARED — the agent has the go-ahead."
                    : "HELD — the request was declined."}
                </div>
              ) : (
                <p className="approval-empty">
                  Nothing is waiting on your review.
                </p>
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
    href: "/tasks",
    label: "Tasks",
    ariaLabel: "Task whiteboard — open Tasks",
    left: "18.5%",
    top: "35.2%",
    width: "11.5%",
    height: "14%",
  },
  {
    href: "/schedules",
    label: "Schedules",
    ariaLabel: "Wall calendar — open Schedules",
    left: "26.7%",
    top: "34.8%",
    width: "5.8%",
    height: "12%",
  },
  {
    href: "/inbox",
    label: "Inbox",
    ariaLabel: "Communications console — open Inbox",
    left: "14.7%",
    top: "50.4%",
    width: "13%",
    height: "13.5%",
  },
  {
    href: "/reports",
    label: "Reports",
    ariaLabel: "Navigation reports console — open Reports",
    left: "25.8%",
    top: "44.6%",
    width: "10%",
    height: "9%",
  },
  {
    href: "/approvals",
    label: "Approvals",
    ariaLabel: "Command console — open Approvals",
    left: "20.7%",
    top: "49.1%",
    width: "7%",
    height: "8%",
    extraClass: "scene-hotspot--approval",
  },
  {
    href: "/agents",
    label: "Agents",
    ariaLabel: "First wall computer — open Agents",
    left: "42.4%",
    top: "36.2%",
    width: "5.4%",
    height: "8%",
  },
  {
    href: "/teams",
    label: "Teams",
    ariaLabel: "Second wall computer — open Teams",
    left: "48.4%",
    top: "36.2%",
    width: "5.4%",
    height: "8%",
  },
  {
    href: "/connected-apps",
    label: "Apps",
    ariaLabel: "Purple apps rack — open Connected Apps",
    left: "74.5%",
    top: "40.8%",
    width: "13.5%",
    height: "16%",
  },
  {
    href: "/providers",
    label: "Providers",
    ariaLabel: "Blue data centre — open Providers",
    left: "77.7%",
    top: "61.5%",
    width: "16.5%",
    height: "18%",
  },
  {
    href: "/memory",
    label: "Memory",
    ariaLabel: "Memory terminal — open Memory",
    left: "84.7%",
    top: "49.5%",
    width: "8%",
    height: "12%",
  },
  {
    href: "/island",
    label: "Retirement Island",
    ariaLabel: "Porthole — open Retirement Island",
    left: "88.5%",
    top: "39.5%",
    width: "6.5%",
    height: "11%",
  },
];

/** Sprite box a pose needs to show the character at CHARACTER_PCT. */
function spritePct(pose: LobsterPose) {
  return CHARACTER_PCT * POSE_CHARACTER_SCALE[pose];
}
