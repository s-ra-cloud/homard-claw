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
  useGetApprovalSettings,
  useGetDocumentation,
  useGetMemorySettings,
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
import { useRoomHotspotReveal } from "@/hooks/useRoomHotspotReveal";
import { OFFICE_WINDOW_NAME, officeWindowHref } from "@/lib/office-window";
import { chooseOfficeRolePlacements } from "./office-role-placements";
import { SCENE_HOTSPOTS } from "./office-scene-hotspots";
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
  {
    left: 42.5,
    top: 38.19,
    label: "first submarine computer",
    screen: { left: 42.25, top: 33.75, width: 2.7, height: 2.9 },
  },
  {
    left: 48.3,
    top: 38.99,
    label: "second submarine computer",
    screen: { left: 47.95, top: 34.55, width: 2.7, height: 2.9 },
  },
  {
    left: 54.0,
    top: 39.8,
    label: "third submarine computer",
    screen: { left: 53.85, top: 35.25, width: 2.7, height: 2.9 },
  },
  {
    left: 60.0,
    top: 40.61,
    label: "fourth submarine computer",
    screen: { left: 59.95, top: 36.0, width: 2.7, height: 2.9 },
  },
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

/**
 * A CSS-only activity layer fitted inside one of the four monitor bezels.
 * The illustrated computer remains the source artwork; this adds only the
 * live pixels, stays pointer-transparent, and mounts only while its occupant
 * is actually doing work.
 */
function WorkstationScreen({
  station,
  status,
  index,
}: {
  station: (typeof DESK_SEATS)[number];
  status: string;
  index: number;
}) {
  const researching = status === "researching";

  return (
    <span
      className={`workstation-screen is-active${researching ? " is-researching" : ""}`}
      aria-hidden="true"
      style={
        {
          left: `${station.screen.left}%`,
          top: `${station.screen.top}%`,
          width: `${station.screen.width}%`,
          height: `${station.screen.height}%`,
          "--screen-phase": `${-(index * 0.41 + 0.17)}s`,
          "--screen-tempo": (1 + index * 0.06).toFixed(2),
        } as React.CSSProperties
      }
    >
      <i className="workstation-screen__wash" />
      <i className="workstation-screen__line workstation-screen__line--one" />
      <i className="workstation-screen__line workstation-screen__line--two" />
      <i className="workstation-screen__line workstation-screen__line--three" />
      <i className="workstation-screen__cursor" />
    </span>
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
  const [roleLoadSeed] = React.useState(() => String(Math.random()));

  const { data: overview, isLoading, isError } = useGetOfficeOverview();
  const {
    data: agents,
    isLoading: agentsLoading,
    isError: agentsError,
  } = useListAgents();
  const { data: approvals } = useListApprovals();
  const { data: approvalSettings, isLoading: approvalSettingsLoading } =
    useGetApprovalSettings();
  const { data: documentation, isLoading: documentationLoading } =
    useGetDocumentation();
  const { data: memorySettings, isLoading: memorySettingsLoading } =
    useGetMemorySettings();
  // Polls so a stalled queue or a lost worker lease surfaces on its own.
  const { data: runtimeHealth } = useGetRuntimeHealth({
    query: { queryKey: ["/api/runtime/health"], refetchInterval: 10000 },
  });
  const queryClient = useQueryClient();
  const revealHotspots = useRoomHotspotReveal(Boolean(openWindow));

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
      ? "INITIATE EMERGENCY STOP? This will halt ALL active Crustabots and tasks immediately."
      : "LIFT EMERGENCY STOP? Crustabots will resume normal operations.";
    if (window.confirm(prompt))
      setEmergencyStop.mutate({ data: { active: nextState } });
  };

  const openOfficeWindow = (
    event: React.MouseEvent<HTMLAnchorElement>,
    href: string,
    title: string,
  ) => {
    // Retirement Island is a second point-and-click location, not an app
    // inside the office parchment. Let its Link perform a real route change.
    if (href === "/island") return;

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

  if (
    isLoading ||
    agentsLoading ||
    approvalSettingsLoading ||
    documentationLoading ||
    memorySettingsLoading
  ) {
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
        : // No fresh owner anywhere: this instance will take over the queue
          // on its next poll. Otherwise another healthy instance owns it.
          runtimeHealth!.worker.ownership.stale
          ? "taking over"
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
  const rolePlacements = chooseOfficeRolePlacements(
    {
      documentationAgentId: documentation?.assistantAgentId,
      approvalAgentId: approvalSettings?.reviewerAgentId,
      memoryAgentId: memorySettings?.compressionAgentId,
    },
    new Set(officeAgents.map((agent) => agent.id)),
    roleLoadSeed,
  );
  const roleAgentIds = new Set(
    rolePlacements.map((placement) => placement.agentId),
  );
  const unassignedOfficeAgents = officeAgents.filter(
    (agent) => !roleAgentIds.has(agent.id),
  );
  const exteriorAgents = sandboxedAgents.slice(0, EXTERIOR_SEATS.length);
  const deskAgents = unassignedOfficeAgents.slice(0, DESK_SEATS.length);
  const floorAgents = unassignedOfficeAgents.slice(
    DESK_SEATS.length,
    MAX_VISIBLE,
  );
  const overflowCount =
    Math.max(0, unassignedOfficeAgents.length - MAX_VISIBLE) +
    Math.max(0, sandboxedAgents.length - EXTERIOR_SEATS.length);
  const roleAgents = rolePlacements.flatMap((placement) => {
    const agent = officeAgents.find(
      (candidate) => candidate.id === placement.agentId,
    );
    return agent ? [{ agent, placement }] : [];
  });

  // Every visible agent, sprite size included, so the name tags can be drawn as
  // one layer on top of every lobster instead of inside their own sprite's
  // stacking context, where a nearer neighbour would cover them.
  const placedAgents = [
    ...roleAgents.map(({ agent, placement }) => ({
      agent,
      seat: placement.seat,
      pose: placement.seat.pose,
      displayStatus:
        agent.status === "paused" ? "paused" : placement.seat.status,
      zIndex: floorZIndex(placement.seat.top) + 3,
    })),
    ...floorAgents.map((agent, index) => {
      const seat = FLOOR_SEATS[index];
      return {
        agent,
        seat,
        pose: "floor-working" as LobsterPose,
        displayStatus: agent.status,
        zIndex: floorZIndex(seat.top),
      };
    }),
    ...deskAgents.map((agent, index) => ({
      agent,
      seat: DESK_SEATS[index],
      pose: stopped
        ? ("seated" as LobsterPose)
        : poseForAgent(agent.status, idleActivities[agent.id]),
      displayStatus: agent.status,
      zIndex: DESK_Z_INDEX,
    })),
    // Sandboxed agents work from their own cushion, exactly like the ones
    // inside — the platform is the separation, not the posture.
    ...exteriorAgents.map((agent, index) => ({
      agent,
      seat: EXTERIOR_SEATS[index],
      pose: "floor-working" as LobsterPose,
      displayStatus: agent.status,
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
              ? "office paused — all Crustabots held"
              : "systems warm & working"}
          </div>
        </header>

        {stopped && (
          <div className="iso-office__halt" role="status">
            <AlertTriangle size={14} /> Emergency stop holds every Crustabot
            until you resume office operations.
          </div>
        )}

        <main className="iso-office__layout">
          <section
            ref={roomRef}
            className={`room-wrap ${stopped ? "is-paused" : ""}${ambientActive ? "" : " is-ambient-paused"}`}
            aria-label="Live underwater submarine office with four computers, an open deck, and exterior stations for sandboxed Crustabots"
          >
            <div className="room-caption">
              <span>
                LIVE VIEW / YELLOW SUBMARINE{stopped ? " / PAUSED" : ""}
              </span>
              <span className="room-caption__discovery">
                HOLD <kbd>SPACE</kbd> TO REVEAL CONTROLS
              </span>
            </div>
            {overflowCount > 0 && (
              <div className="room-overflow" role="status" aria-live="polite">
                +{overflowCount} Crustabot{overflowCount !== 1 ? "s" : ""} in
                roster beyond the visible stations ·{" "}
                <Link
                  href="/agents"
                  onClick={(event) =>
                    openOfficeWindow(event, "/agents", "Crustabot roster")
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
                <div
                  className={`room-scene${revealHotspots ? " is-discovering" : ""}`}
                >
                  {/* A monitor wakes only when the agent seated below it works. */}
                  {deskAgents.map((agent, index) =>
                    !stopped && AT_DESK_STATUSES.has(agent.status) ? (
                      <WorkstationScreen
                        key={`${agent.id}-screen`}
                        station={DESK_SEATS[index]}
                        status={agent.status}
                        index={index}
                      />
                    ) : null,
                  )}

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
                      data-room-hotspot
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
                        ? "Resume all Crustabots"
                        : "Emergency stop: urgently pause all Crustabots"
                    }
                    data-label={
                      stopped ? "Resume Crustabots" : "Emergency stop"
                    }
                    data-room-hotspot
                  />

                  {/* Existing lobster sprites; click an agent to open its Talk view. */}
                  {placedAgents.map(
                    ({ agent, seat, pose, displayStatus, zIndex }) => (
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
                          data-room-hotspot
                          data-label={`Talk with ${agent.name}`}
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
                            status={stopped ? "paused" : displayStatus}
                            seed={agent.id}
                            shellColor={agent.avatar.shellColor}
                            title={`${agent.name} at the ${seat.label}`}
                          />
                        </Link>
                      </div>
                    ),
                  )}

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
                    openOfficeWindow(event, "/agents", "Crustabot roster")
                  }
                >
                  <b>{String(overview.agents).padStart(2, "0")}</b>Crustabots
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
                <i className={`signal ${stopped ? "is-halted" : ""}`} />{" "}
                Crustabot runtime{" "}
                <span>{stopped ? "paused" : runtimeLabel}</span>
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
                    ? "CLEARED — the Crustabot has the go-ahead."
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

/** Sprite box a pose needs to show the character at CHARACTER_PCT. */
function spritePct(pose: LobsterPose) {
  return CHARACTER_PCT * POSE_CHARACTER_SCALE[pose];
}

/** Convert square sprite width into vertical scene space for its nameplate. */
function nameOffsetPct(pose: LobsterPose) {
  return spritePct(pose) * SCENE_ASPECT * 0.43;
}
