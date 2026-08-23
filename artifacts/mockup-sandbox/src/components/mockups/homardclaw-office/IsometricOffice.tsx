import React, { useState } from "react";

import "./IsometricOffice.css";

export function IsometricOffice() {
  const [halted, setHalted] = useState(false);
  const [approved, setApproved] = useState(false);

  return (
    <section className="iso-office">
      <header className="iso-office__bar">
        <div className="iso-office__brand"><b>HOMARD</b>CLAW / desk 01</div>
        <div className="iso-office__status"><i className="signal" /> {halted ? "office resting" : "systems warm & working"}</div>
      </header>

      <main className="iso-office__layout">
        <section className="room-wrap" aria-label="Marlow's live isometric office">
          <div className="room-caption">LIVE VIEW / MARLOW'S DESK / 14:21</div>
          <div className="room-art">
            <img src="/__mockup/images/homardclaw-isometric-office-original.png" alt="Isometric HomardClaw office with a lobster working at a desk" />
          </div>
        </section>

        <aside className="side-panel">
          <section className="quiet-card rail-control">
            <h2>Safety control</h2>
            <button className={`iso-office__stop ${halted ? "is-paused" : ""}`} onClick={() => setHalted((value) => !value)}>
              {halted ? "RESUME OFFICE" : "EMERGENCY STOP"}
            </button>
          </section>
          <section className="quiet-card">
            <h2>Office pulse</h2>
            <div className="summary">
              <div><b>04</b>agents</div>
              <div><b>02</b>tasks</div>
              <div><b>01</b>review</div>
            </div>
          </section>
          <section className="quiet-card">
            <h2>Systems</h2>
            <div className="system-row"><i className="signal" /> Agent runtime <span>{halted ? "paused" : "steady"}</span></div>
            <div className="system-row"><i className="signal" /> Provider relay <span>clear</span></div>
            <div className="system-row"><i className="signal" /> June compute <span>$18.47</span></div>
          </section>
          <section className="quiet-card approval">
            <h2>One thing needs you</h2>
            <p>Shelly wants to export the provider usage report to the shared workspace.</p>
            {approved ? <div className="approved">CLEARED — Shelly has the go-ahead.</div> : <div><button onClick={() => setApproved(true)}>APPROVE</button><button onClick={() => setApproved(false)}>HOLD</button></div>}
          </section>
        </aside>
      </main>
    </section>
  );
}