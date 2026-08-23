import React, { useState } from "react";
import { AlertTriangle, Check, Pause, Play, ShieldCheck } from "lucide-react";

import "./_group.css";
import "./SnesOffice.css";

type LobsterStatus = "working" | "researching" | "idle" | "waiting";

type AgentStationProps = {
  name: string;
  role: string;
  status: LobsterStatus;
  shell: string;
  shadow: string;
  light: string;
  outfit: string;
  accessory?: "glasses" | "headset" | "visor";
};

const agents: AgentStationProps[] = [
  { name: "Marlow", role: "Ops lead", status: "working", shell: "#e9554e", shadow: "#a83243", light: "#ff8f69", outfit: "#4a7d91", accessory: "headset" },
  { name: "Coral", role: "Research", status: "researching", shell: "#ef7a52", shadow: "#b44748", light: "#ffb26c", outfit: "#8068a6", accessory: "glasses" },
  { name: "Pincher", role: "Release", status: "idle", shell: "#c94a54", shadow: "#8e3148", light: "#eb7880", outfit: "#3e7885", accessory: "visor" },
  { name: "Shelly", role: "Finance", status: "waiting", shell: "#e68a64", shadow: "#a75050", light: "#ffc38b", outfit: "#6e9b7d", accessory: "glasses" },
];

const tasks = [
  ["Marlow", "Morning operations brief is being composed.", "14:18"],
  ["Coral", "Competitor signal scan queued for review.", "14:12"],
  ["Shelly", "Provider usage export awaits approval.", "13:56"],
];

function statusLabel(status: LobsterStatus) {
  return status === "researching" ? "scanning" : status;
}

function Lobster({ agent }: { agent: AgentStationProps }) {
  const style = {
    "--shell": agent.shell,
    "--shell-dark": agent.shadow,
    "--shell-light": agent.light,
    "--shell-shadow": agent.shadow,
    "--outfit": agent.outfit,
  } as React.CSSProperties;
  return (
    <div className={`lobster ${agent.accessory === "glasses" ? "has-glasses" : ""}`} style={style} aria-label={`${agent.name}, ${agent.role}, ${agent.status}`}>
      <span className="antenna left" /><span className="antenna right" />
      <span className="claw left" /><span className="claw right" />
      <span className="body" /><span className="eye left" /><span className="eye right" /><span className="mouth" />
      <span className="outfit" /><span className="tail" />
      {agent.accessory === "glasses" && <span className="glasses" />}
      {agent.accessory === "headset" && <span className="headset" />}
      {agent.accessory === "visor" && <span className="visor" />}
    </div>
  );
}

function AgentStation({ agent, stopped }: { agent: AgentStationProps; stopped: boolean }) {
  const effectiveStatus = stopped ? "idle" : agent.status;
  return (
    <article className={`agent-station is-${effectiveStatus}`}>
      <div className={`state-pill ${effectiveStatus}`}>{stopped ? "paused" : statusLabel(agent.status)}</div>
      <div className="monitor" aria-hidden="true"><div className="code-lines"><i /><i /><i /></div></div>
      <Lobster agent={agent} />
      <div className="desk"><div className="desk-name">{agent.name}<br /><small>{agent.role}</small></div></div>
    </article>
  );
}

export function SnesOffice() {
  const [halted, setHalted] = useState(false);
  const [approved, setApproved] = useState(false);

  return (
    <section className="snes-office">
      <header className="snes-office__topbar">
        <div className="snes-office__brand">
          <div className="brand-claw" aria-hidden="true" />
          <div className="brand-name">HOMARDCLAW<small>private agent office</small></div>
        </div>
        <div className="snes-office__title">Control room · floor 01</div>
        <div className="system-lamp"><i className="lamp-dot" /> {halted ? "Office paused" : "Systems steady"}</div>
        <button className={`emergency ${halted ? "is-halted" : ""}`} onClick={() => setHalted((value) => !value)}>
          {halted ? <Play size={14} /> : <Pause size={14} />} {halted ? "Resume office" : "Emergency stop"}
        </button>
      </header>

      <main className="snes-office__content">
        <div className="office-heading">
          <div><h1>Good afternoon, Director.</h1><p>Your command room is warm, lit, and fully staffed.</p></div>
          <div className={`status-ribbon ${halted ? "halted" : ""}`}>{halted ? "Global halt active" : "4 agents online"}</div>
        </div>
        {halted && <div className="halt-banner"><AlertTriangle size={16} style={{ verticalAlign: "middle", marginRight: 7 }} /> Emergency stop holds every agent until you resume office operations.</div>}

        <section className="command-room" aria-label="Live illustrated agent office">
          <div className="room-backdrop" aria-hidden="true">
            <div className="window"><i className="sun-disc" /></div><div className="clock-face" /><div className="wall-art" />
            <div className="lamp one" /><div className="lamp two" />
          </div>
          <div className="room-label">Live office view · 14:21</div>
          <div className="agent-stage">
            {agents.map((agent) => <AgentStation key={agent.name} agent={agent} stopped={halted} />)}
          </div>
        </section>

        <section className="metrics" aria-label="Office summary">
          <div className="metric"><b>04</b><span>Agents rostered</span></div>
          <div className="metric"><b>02</b><span>Tasks in motion</span></div>
          <div className="metric"><b>01</b><span>Approval waiting</span></div>
          <div className="metric"><b>$18.47</b><span>June compute</span></div>
        </section>

        <section className="activity-grid">
          <div className="panel">
            <div className="panel-header">Office ticker <span>last 42 min</span></div>
            {tasks.map(([name, detail, time]) => (
              <div className="task" key={name}>
                <div className="task-mark">+</div>
                <div className="task-copy"><b>{name}</b><p>{detail}</p></div>
                <time className="task-time">{time}</time>
              </div>
            ))}
          </div>
          <aside className="panel">
            <div className="panel-header">Permission desk <span>1 pending</span></div>
            <div className="approval">
              <div className="alert-title"><span className="alert-icon">!</span> Shelly needs a clear</div>
              <p>Export <strong>provider-usage-june.csv</strong> to the shared workspace.</p>
              <div className="approval-actions">
                <button className="approve" onClick={() => setApproved(true)} disabled={approved}>{approved ? <><Check size={12} /> cleared</> : <><ShieldCheck size={12} /> approve</>}</button>
                <button className="reject" onClick={() => setApproved(false)}>hold</button>
              </div>
            </div>
          </aside>
        </section>
      </main>
    </section>
  );
}