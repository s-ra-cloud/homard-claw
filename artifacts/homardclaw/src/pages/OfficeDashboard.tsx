import React from "react";
import { Link } from "wouter";
import { AlertTriangle, Check, Clock, Pause, Play, ShieldCheck } from "lucide-react";
import { useGetOfficeOverview, useListAgents, useSetEmergencyStop, type Agent } from "@workspace/api-client-react";
import { Shell } from "@/components/layout/Shell";
import { useQueryClient } from "@tanstack/react-query";
import "./office-dashboard.css";
import "./office-lobsters.css";

type OfficeAgent = Agent;

const deskColors = ["#4a7d91", "#8068a6", "#3e7885", "#6e9b7d"];
const shellShadows = ["#a83243", "#b44748", "#8e3148", "#a75050"];
const shellLights = ["#ff8f69", "#ffb26c", "#eb7880", "#ffc38b"];

function statusLabel(status: OfficeAgent["status"]) {
  return status === "researching" ? "scanning" : status.replace("_", " ");
}

function OfficeLobster({ agent, index }: { agent: OfficeAgent; index: number }) {
  const accessory = agent.avatar.accessory.toLowerCase();
  const style = {
    "--shell": agent.avatar.shellColor,
    "--shell-dark": shellShadows[index % shellShadows.length],
    "--shell-light": shellLights[index % shellLights.length],
    "--shell-shadow": shellShadows[index % shellShadows.length],
    "--outfit": deskColors[index % deskColors.length],
  } as React.CSSProperties;

  return (
    <div className="office-lobster" style={style} aria-hidden="true">
      <span className="lobster-antenna lobster-antenna--left" />
      <span className="lobster-antenna lobster-antenna--right" />
      <span className="lobster-claw lobster-claw--left" />
      <span className="lobster-claw lobster-claw--right" />
      <span className="lobster-body" />
      <span className="lobster-eye lobster-eye--left" />
      <span className="lobster-eye lobster-eye--right" />
      <span className="lobster-mouth" />
      <span className="lobster-outfit" />
      <span className="lobster-tail" />
      {accessory.includes("glass") && <span className="lobster-glasses" />}
      {accessory.includes("head") && <span className="lobster-headset" />}
      {accessory.includes("visor") && <span className="lobster-visor" />}
    </div>
  );
}

function AgentStation({ agent, index, stopped }: { agent?: OfficeAgent; index: number; stopped: boolean }) {
  if (!agent) {
    return (
      <article className="agent-station agent-station--empty">
        <div className="state-pill idle">open desk</div>
        <div className="monitor monitor--sleep" aria-hidden="true"><div className="code-lines"><i /><i /></div></div>
        <div className="empty-chair" aria-hidden="true" />
        <div className="desk"><div className="desk-name">AVAILABLE<br /><small>recruiting bay</small></div></div>
      </article>
    );
  }

  const effectiveStatus = stopped ? "paused" : agent.status;
  return (
    <article className={`agent-station is-${effectiveStatus}`}>
      <div className={`state-pill ${effectiveStatus}`}>{stopped ? "paused" : statusLabel(agent.status)}</div>
      <div className="monitor" aria-hidden="true"><div className="code-lines"><i /><i /><i /></div></div>
      <div role="img" aria-label={`${agent.name}, ${agent.title}, ${effectiveStatus}`}>
        <OfficeLobster agent={agent} index={index} />
      </div>
      <div className="desk"><div className="desk-name">{agent.name}<br /><small>{agent.title}</small></div></div>
    </article>
  );
}

export default function OfficeDashboard() {
  const { data: overview, isLoading, isError } = useGetOfficeOverview();
  const { data: agents } = useListAgents();
  const queryClient = useQueryClient();
  const setEmergencyStop = useSetEmergencyStop({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        queryClient.invalidateQueries({ queryKey: ["/api/agents"] });
      },
    },
  });

  const handleEmergencyStop = () => {
    if (!overview) return;
    const nextState = !overview.emergencyStop;
    const prompt = nextState
      ? "INITIATE EMERGENCY STOP? This will halt ALL active agents and tasks immediately."
      : "LIFT EMERGENCY STOP? Agents will resume normal operations.";
    if (window.confirm(prompt)) setEmergencyStop.mutate({ data: { active: nextState } });
  };

  if (isLoading) return <Shell><section className="snes-office snes-office--state" aria-live="polite"><div className="brand-claw" aria-hidden="true" /><p>Booting office core...</p></section></Shell>;
  if (isError || !overview) return <Shell><section className="snes-office snes-office--state"><AlertTriangle size={42} /><h1>System error</h1><p>Failed to connect to the office mainframe. Please try again.</p></section></Shell>;

  const stopped = overview.emergencyStop;
  const stations = Array.from({ length: 4 }, (_, index) => agents?.[index]);
  return (
    <Shell>
      <section className="snes-office">
        <header className="snes-office__topbar">
          <div className="snes-office__brand"><div className="brand-claw" aria-hidden="true" /><div className="brand-name">HOMARDCLAW<small>private agent office</small></div></div>
          <div className="snes-office__title">Control room · floor 01</div>
          <div className="system-lamp"><i className="lamp-dot" /> {stopped ? "Office paused" : "Systems steady"}</div>
          <button className={`emergency ${stopped ? "is-halted" : ""}`} onClick={handleEmergencyStop} disabled={setEmergencyStop.isPending}>
            {stopped ? <Play size={14} /> : <Pause size={14} />} {setEmergencyStop.isPending ? "Updating..." : stopped ? "Resume office" : "Emergency stop"}
          </button>
        </header>
        <main className="snes-office__content">
          <div className="office-heading"><div><h1>Good afternoon, Director.</h1><p>Your command room is warm, lit, and ready for work.</p></div><div className={`status-ribbon ${stopped ? "halted" : ""}`}>{stopped ? "Global halt active" : `${overview.agents} agents rostered`}</div></div>
          {stopped && <div className="halt-banner"><AlertTriangle size={16} /> Emergency stop holds every agent until you resume office operations.</div>}
          <section className="command-room" aria-label="Live illustrated agent office">
            <div className="room-backdrop" aria-hidden="true"><div className="window"><i className="sun-disc" /></div><div className="clock-face" /><div className="wall-art" /><div className="lamp one" /><div className="lamp two" /></div>
            <div className="room-label">Live office view</div>
            <div className="agent-stage">{stations.map((agent, index) => <AgentStation key={agent?.id ?? `empty-station-${index}`} agent={agent} index={index} stopped={stopped} />)}</div>
          </section>
          <section className="metrics" aria-label="Office summary">
            <Link className="metric" href="/agents"><b>{String(overview.agents).padStart(2, "0")}</b><span>Agents rostered</span></Link>
            <Link className="metric" href="/tasks"><b>{String(overview.activeTasks).padStart(2, "0")}</b><span>Tasks in motion</span></Link>
            <Link className="metric" href="/approvals"><b>{String(overview.pendingApprovals).padStart(2, "0")}</b><span>Approvals waiting</span></Link>
            <div className="metric"><b>${(overview.monthlyCostCents / 100).toFixed(2)}</b><span>Monthly compute</span></div>
          </section>
          <section className="activity-grid">
            <div className="panel"><div className="panel-header">Office ticker <span>recent activity</span></div>
              {overview.recentEvents.length === 0 ? <div className="panel-empty">No recent activity detected.</div> : overview.recentEvents.map((event) => <div className="task" key={event.id}><div className="task-mark"><Clock size={13} /></div><div className="task-copy"><b>{event.kind}</b><p>{event.summary}</p></div><time className="task-time" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>)}
            </div>
            <aside className="panel"><div className="panel-header">Permission desk <span>{overview.pendingApprovals} pending</span></div><div className="approval"><div className="alert-title"><span className="alert-icon">!</span> Approval queue</div><p>{overview.pendingApprovals > 0 ? "Review pending agent requests before work can continue." : "No permission requests are waiting for your review."}</p><Link className="approve" href="/approvals"><ShieldCheck size={12} /> review approvals</Link><Link className="reject" href="/tasks"><Check size={12} /> task queue</Link></div></aside>
          </section>
        </main>
      </section>
    </Shell>
  );
}