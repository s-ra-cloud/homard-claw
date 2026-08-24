import React from "react";
import { Link } from "wouter";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
  useGetOfficeOverview,
  useListAgents,
  useListApprovals,
  useDecideApproval,
  useSetEmergencyStop,
  ApprovalDecisionDecision,
} from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { MarlowLobster, type LobsterPose } from "@/components/ui/marlow-lobster";
import { useQueryClient } from "@tanstack/react-query";
import "./office-dashboard.css";

const officeArt = `${import.meta.env.BASE_URL}images/four-desk-office.png`;

// Chair centres in the generated office scene. Agent sprites are layered on top
// so every employee is rendered by the same canonical component as the roster.
const DESK_SEATS = [
  { left: 29.0, top: 43.0, label: "window desk" },
  { left: 71.0, top: 43.0, label: "library desk" },
  { left: 29.0, top: 72.0, label: "garden desk" },
  { left: 71.0, top: 72.0, label: "filing desk" },
];

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

export default function OfficeDashboard() {
  const { data: overview, isLoading, isError } = useGetOfficeOverview();
  const {
    data: agents,
    isLoading: agentsLoading,
    isError: agentsError,
  } = useListAgents();
  const { data: approvals } = useListApprovals();
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
  const nextApproval = approvals?.find((a) => a.status === "pending");
  const justDecided = decideApproval.isSuccess ? decideApproval.variables : undefined;

  return (
    <Shell>
      <section className="iso-office">
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
          <section className={`room-wrap ${stopped ? "is-paused" : ""}`} aria-label="Live four-desk isometric office">
            <div className="room-caption">LIVE VIEW / FOUR-DESK OFFICE{stopped ? " / PAUSED" : ""}</div>
            <div className="room-art">
              <div className="room-scene">
                <img src={officeArt} alt="Isometric pixel-art HomardClaw office with four desks and chairs" />
                {(agents ?? []).filter((agent) => !agent.archived).slice(0, DESK_SEATS.length).map((agent, index) => {
                  const seat = DESK_SEATS[index];
                  return (
                    <div
                      key={agent.id}
                      className="room-agent"
                      style={{ left: `${seat.left}%`, top: `${seat.top}%` }}
                      title={`${agent.name} at the ${seat.label}`}
                    >
                      <MarlowLobster
                        size={96}
                        pose={
                          stopped
                            ? "seated"
                            : poseForAgent(agent.status, idleActivities[agent.id])
                        }
                        status={stopped ? "paused" : agent.status}
                        shellColor={agent.avatar.shellColor}
                        title={`${agent.name} at the ${seat.label}`}
                      />
                      <span className="room-agent__name">{agent.name}</span>
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
                <i className={`signal ${stopped ? "is-halted" : ""}`} /> Agent runtime <span>{stopped ? "paused" : "steady"}</span>
              </div>
              <div className="system-row">
                <i className="signal" /> Approval queue <span>{overview.pendingApprovals > 0 ? `${overview.pendingApprovals} waiting` : "clear"}</span>
              </div>
              <div className="system-row">
                <i className="signal" /> Monthly compute <span>${(overview.monthlyCostCents / 100).toFixed(2)}</span>
              </div>
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
