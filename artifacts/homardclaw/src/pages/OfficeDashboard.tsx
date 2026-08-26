import React from "react";
import { Link } from "wouter";
import { AlertTriangle, ShieldCheck, X } from "lucide-react";
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
import { useIsDesktop } from "@/hooks/use-mobile";
import { OFFICE_WINDOW_NAME, officeWindowHref } from "@/lib/office-window";
import "./office-dashboard.css";

/** The full 1586 × 992 submarine illustration is the scene coordinate plane. */
const officeArt = `${import.meta.env.BASE_URL}images/submarine-office.png`;

// Four wall computers in the middle room. `left` is the monitor screen's own
// centre in the artwork — measured at 42.24 / 48.05 / 53.75 / 59.79 — plus
// 0.24, because the chair's wheelbase is not centred in its square sprite box
// and lands in a slightly different place per pose: the working pose puts it
// ~10px (of 128) left of where every other chair pose does. That single offset
// splits the two pose families, so no pose sits more than ~4px off its screen.
//
// `top` is what makes the agent read as *at* the desk rather than parked in the
// room: the chair back has to overlap the desk shelf. The room is isometric,
// so the four shelves are not one horizontal line — their tops step down a
// uniform 8px (0.81% of the 992px scene) per desk, measured at 364 / 372 /
// 380 / 388px left to right. Each seat carries its own shelf's depth: the
// third desk keeps the proven 39.8 (tuned against its shelf front edge at
// 39.4%; 43.4% left a whole strip of floor between shelf and chair) and the
// others shift by whole 0.81% shelf steps, so every chair has the identical
// back-overlaps-shelf relationship and the four seats read as one diagonal.
const DESK_SEATS = [
  { left: 42.5, top: 38.19, label: "first submarine computer" },
  { left: 48.3, top: 38.99, label: "second submarine computer" },
  { left: 54.0, top: 39.8, label: "third submarine computer" },
  { left: 60.0, top: 40.61, label: "fourth submarine computer" },
];

// Six cushion spots on open floor: four staggered across the middle room, one
// in the port control room, one on the starboard server-room tiles. The
// floor-working pose already includes its cushion and laptop, so the
// background intentionally contains no duplicate furniture. Every spot was
// verified by compositing the real sprite onto the real artwork: the middle
// room's floor runs from ~48% down to the hull edge at ~69-71%, the control
// room's clear wood is left of the chart table, and the server room's open
// tile lies between the racks (~63%) and its hull edge (~72%).
const FLOOR_SEATS = [
  { left: 37.0, top: 57.5, label: "centre deck, port side" },
  { left: 49.0, top: 57.0, label: "centre deck, starboard side" },
  { left: 40.5, top: 66.0, label: "forward deck, port side" },
  { left: 55.0, top: 65.0, label: "forward deck, starboard side" },
  { left: 17.2, top: 60.8, label: "control-room deck" },
  { left: 76.5, top: 67.8, label: "server-room deck" },
];

// Sandboxed agents are physically separated from the hull: one cushion on each
// exterior platform, which is all the deck plating those two pads can hold.
// Each pad is an isometric quad, so centring on it means moving up as you move
// right; a seat placed toward the near-left corner hangs its cushion and laptop
// over the railing even though the coordinate still looks "on" the platform.
const EXTERIOR_SEATS = [
  { left: 24.7, top: 73.8, label: "port exterior platform" },
  { left: 66.4, top: 79.2, label: "starboard exterior platform" },
];

/** Character size as a share of the wide scene, preserving the old pixel size. */
const CHARACTER_PCT = 4.6;
const SCENE_ASPECT = 1586 / 992;
/**
 * Floor cushions overlap by depth: the further back a mat sits, the lower it
 * draws. Everything stays below the desk agents, which own z-index 12.
 */
function floorZIndex(top: number) {
  return 3 + Math.round(top / 10);
}

const DESK_Z_INDEX = 12;
const MAX_VISIBLE = DESK_SEATS.length + FLOOR_SEATS.length; // 10

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

interface OpenOfficeWindow {
  href: string;
  title: string;
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

function ParchmentWindow({
  windowState,
  onClose,
}: {
  windowState: OpenOfficeWindow;
  onClose: () => void;
}) {
  const closeRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="office-game-window"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="office-game-window__parchment"
        role="dialog"
        aria-modal="true"
        aria-labelledby="office-window-title"
        aria-describedby="office-window-scroll-hint"
      >
        <header className="office-game-window__header">
          <span className="office-game-window__seal" aria-hidden="true">
            HC
          </span>
          <div>
            <h2 id="office-window-title">{windowState.title}</h2>
            <p id="office-window-scroll-hint">Scroll inside this parchment</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="office-game-window__close"
            onClick={onClose}
            aria-label={`Close ${windowState.title}`}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="office-game-window__content">
          <iframe
            key={windowState.href}
            name={OFFICE_WINDOW_NAME}
            src={officeWindowHref(windowState.href)}
            title={windowState.title}
            allow="microphone"
          />
        </div>
      </section>
    </div>
  );
}

export default function OfficeDashboard() {
  const { immersive, enterImmersive } = useImmersiveMode();
  const gameMode = useIsDesktop();
  const sceneImmersive = gameMode || immersive;
  const roomRef = React.useRef<HTMLElement>(null);
  const lastWindowTriggerRef = React.useRef<HTMLElement | null>(null);
  const [ambientActive, setAmbientActive] = React.useState(true);
  const [openWindow, setOpenWindow] = React.useState<OpenOfficeWindow | null>(
    null,
  );

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

  // Name tags stay out of the picture until you point at (or tab to) a
  // lobster. The tags are their own layer above every sprite, so the two
  // cannot be linked with a plain nested `:hover`; the pointed-at agent is
  // tracked here and the matching tag in the other layer reveals itself.
  const [namedAgentId, setNamedAgentId] = React.useState<string | null>(null);

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

  const openOfficeWindow = (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    title: string,
  ) => {
    if (
      !gameMode ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    lastWindowTriggerRef.current = event.currentTarget;
    setOpenWindow({ href, title });
  };

  const closeOfficeWindow = React.useCallback(() => {
    setOpenWindow(null);
    window.requestAnimationFrame(() => lastWindowTriggerRef.current?.focus());
  }, []);

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
    // Sandboxed agents work from their own cushion, exactly like the ones
    // inside — the platform is the separation, not the posture.
    ...exteriorAgents.map((agent, index) => ({
      agent,
      seat: EXTERIOR_SEATS[index],
      pose: "floor-working" as LobsterPose,
      zIndex: floorZIndex(EXTERIOR_SEATS[index].top),
    })),
  ];

  return (
    <Shell
      immersive={sceneImmersive}
      onEnterImmersive={gameMode ? undefined : enterImmersive}
    >
      <section className={`iso-office${sceneImmersive ? " is-immersive" : ""}`}>
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
                <Link
                  href="/agents"
                  onClick={(event) =>
                    openOfficeWindow(event, "/agents", "Agent roster")
                  }
                >
                  view all
                </Link>
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
                      onClick={(event) =>
                        openOfficeWindow(event, spot.href, spot.label)
                      }
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
                      onMouseEnter={() => setNamedAgentId(agent.id)}
                      onMouseLeave={() =>
                        setNamedAgentId((current) =>
                          current === agent.id ? null : current,
                        )
                      }
                    >
                      <Link
                        href={`/talk/${agent.id}`}
                        className="room-agent__link"
                        aria-label={`Talk to ${agent.name} at the ${seat.label}`}
                        /* Keyboard users get the same tag the pointer does. */
                        onFocus={() => setNamedAgentId(agent.id)}
                        onBlur={() =>
                          setNamedAgentId((current) =>
                            current === agent.id ? null : current,
                          )
                        }
                        onClick={(event) =>
                          openOfficeWindow(
                            event,
                            `/talk/${agent.id}`,
                            `Talk with ${agent.name}`,
                          )
                        }
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

                  {/* ── Name tags: their own layer above every sprite, so none
                       can be hidden, and only the pointed-at one is shown.
                       Purely decorative — the sprite carries the link and the
                       accessible name — so they never take the pointer. ── */}
                  {placedAgents.map(({ agent, seat, pose }) => (
                    <span
                      key={`${agent.id}-name`}
                      className={`room-agent__name${
                        namedAgentId === agent.id ? " is-shown" : ""
                      }`}
                      style={{
                        left: `${seat.left}%`,
                        top: `calc(${seat.top + nameOffsetPct(pose)}% - 2px)`,
                      }}
                      aria-hidden="true"
                    >
                      {agent.name}
                    </span>
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
                <Link
                  href="/agents"
                  onClick={(event) =>
                    openOfficeWindow(event, "/agents", "Agent roster")
                  }
                >
                  <b>{String(overview.agents).padStart(2, "0")}</b>agents
                </Link>
                <Link
                  href="/tasks"
                  onClick={(event) =>
                    openOfficeWindow(event, "/tasks", "Tasks")
                  }
                >
                  <b>{String(overview.activeTasks).padStart(2, "0")}</b>tasks
                </Link>
                <Link
                  href="/approvals"
                  onClick={(event) =>
                    openOfficeWindow(event, "/approvals", "Approvals")
                  }
                >
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
              <Link
                className="approval-link"
                href="/approvals"
                onClick={(event) =>
                  openOfficeWindow(event, "/approvals", "Approvals")
                }
              >
                <ShieldCheck size={12} /> full approval desk
              </Link>
            </section>
          </aside>
        </main>

        {gameMode && openWindow && (
          <ParchmentWindow
            windowState={openWindow}
            onClose={closeOfficeWindow}
          />
        )}
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
  // The two wall computers that double as navigation sit directly behind the
  // first two desk agents. These hit areas are trimmed to the monitor screens
  // themselves (measured at 32.2-36.3% and 33.0-37.0%) and lifted above the
  // agents, so a seated lobster cannot swallow the click. The desk seats
  // follow the shelves' diagonal, so each chair top sits at a different
  // height (sprite boxes reach up to ~33.0% and ~33.8%): each hotspot's
  // bottom edge is pulled up by its seat's shelf step, keeping the same
  // stops-short-of-the-chair clearance the flat layout had.
  {
    href: "/agents",
    label: "Agents",
    ariaLabel: "First wall computer — open Agents",
    left: "42.4%",
    top: "33.8%",
    width: "5.4%",
    height: "3.6%",
    extraClass: "scene-hotspot--monitor",
  },
  {
    href: "/teams",
    label: "Teams",
    ariaLabel: "Second wall computer — open Teams",
    left: "48.4%",
    top: "34.2%",
    width: "5.4%",
    height: "4.4%",
    extraClass: "scene-hotspot--monitor",
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

/** Convert square sprite width into vertical scene space for its nameplate. */
function nameOffsetPct(pose: LobsterPose) {
  return spritePct(pose) * SCENE_ASPECT * 0.43;
}
