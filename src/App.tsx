import { FormEvent, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

type AppProps = {
  backendConnected: boolean;
};

const sponsorCapabilities = [
  ["Convex", "live missions, durable runs, approvals, outcomes"],
  ["Firecrawl", "search, evidence capture, map, and durable research"],
  ["OpenAI", "structured plans, explanations, drafts, reply classification"],
  ["AgentMail", "approved sending, delivery receipts, threads, and replies"],
] as const;

export default function App({ backendConnected }: AppProps) {
  const workspaceId = "demo-workspace";
  const missions = useQuery(api.missions.list, backendConnected ? { workspaceId } : "skip");
  const createMission = useMutation(api.missions.create);
  const [goal, setGoal] = useState("Find growth-stage climate companies in Lagos that need a product-design partner.");
  const [mode, setMode] = useState<"opportunity" | "person" | "customer" | "solution" | "collaborator">("customer");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !backendConnected) return;
    setSubmitting(true);
    setNotice("");
    try {
      const title = goal.trim().split(/[.!?]/)[0].slice(0, 90);
      await createMission({ workspaceId, title, rawGoal: goal.trim(), mode, constraints: [], sourceScope: "Public web only", completionPredicate: "A user-reviewed, evidence-backed next action exists." });
      setNotice("Mission queued. Its Convex run will interpret the goal in the next phase.");
      setGoal("");
    } catch {
      setNotice("Mission could not be created. Check the local Convex deployment and try again.");
    } finally { setSubmitting(false); }
  }

  return (
    <main className="shell">
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="Prospect Radar home">
          <span className="brand-mark">↗</span>
          <span>Prospect Radar</span>
        </a>
        <span className={backendConnected ? "connection online" : "connection"}>
          <span className="connection-dot" />
          {backendConnected ? "Convex connected" : "Backend setup in progress"}
        </span>
      </nav>

      <section className="hero" id="top">
        <p className="eyebrow">OPPORTUNITY OPERATING SYSTEM</p>
        <h1>Ask for the opportunity. Keep the evidence.</h1>
        <p className="hero-copy">
          Prospect Radar will turn a goal into sourced matches, explainable research,
          approval-bound outreach, and live relationship outcomes.
        </p>
        <form className="mission-card" aria-label="Create a mission" onSubmit={onSubmit}>
          <p className="mission-label">NEW MISSION</p>
          <textarea className="mission-prompt" aria-label="Opportunity goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} />
          <div className="mission-controls">
            <select aria-label="Mission mode" value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
              <option value="opportunity">Find an opportunity</option><option value="person">Find a person</option><option value="customer">Find a customer</option><option value="solution">Find a solution</option><option value="collaborator">Find a collaborator</option>
            </select>
            <button type="submit" disabled={!backendConnected || submitting || !goal.trim()}>{submitting ? "Queuing…" : "Start mission →"}</button>
          </div>
          <p className="stage-note">{notice || (backendConnected ? "Creates a durable Convex mission and run checkpoint." : "Connect Convex to start a mission.")}</p>
        </form>
      </section>

      <section className="section" aria-labelledby="missions-title">
        <div className="section-heading"><p className="eyebrow">LIVE MISSION QUEUE</p><h2 id="missions-title">Your opportunity radar</h2></div>
        <div className="mission-list">
          {missions === undefined ? <p className="empty-state">Loading live missions…</p> : missions.length === 0 ? <p className="empty-state">No missions yet. Start with a goal above.</p> : missions.map((mission) => <article className="mission-row" key={mission._id}><div><span className="status-pill">{mission.status}</span><h3>{mission.title}</h3><p>{mission.mode} · {mission.sourceScope}</p></div><time dateTime={new Date(mission.createdAt).toISOString()}>{new Date(mission.createdAt).toLocaleDateString()}</time></article>)}
        </div>
      </section>

      <section className="section" aria-labelledby="journey-title">
        <div className="section-heading">
          <p className="eyebrow">THE DEMO JOURNEY</p>
          <h2 id="journey-title">From intent to a real conversation</h2>
        </div>
        <ol className="journey">
          <li><span>01</span><strong>Interpret</strong><p>OpenAI produces a strict mission plan.</p></li>
          <li><span>02</span><strong>Research</strong><p>Firecrawl gathers fresh public evidence.</p></li>
          <li><span>03</span><strong>Decide</strong><p>Radar explains fit, unknowns, and risks.</p></li>
          <li><span>04</span><strong>Connect</strong><p>AgentMail sends only after approval.</p></li>
          <li><span>05</span><strong>Learn</strong><p>Convex keeps replies and outcomes live.</p></li>
        </ol>
      </section>

      <section className="section sponsor-section" aria-labelledby="sponsors-title">
        <div className="section-heading">
          <p className="eyebrow">SPONSOR-NATIVE BY DESIGN</p>
          <h2 id="sponsors-title">Every sponsor does real product work.</h2>
        </div>
        <div className="sponsor-grid">
          {sponsorCapabilities.map(([sponsor, capability]) => (
            <article className="sponsor-card" key={sponsor}>
              <h3>{sponsor}</h3>
              <p>{capability}</p>
            </article>
          ))}
        </div>
      </section>

      <footer>
        <p>Built for Convex All Gas. Research is evidence, not an instruction. Sending requires approval.</p>
      </footer>
    </main>
  );
}
