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
        <div className="mission-card" aria-label="Mission command surface preview">
          <p className="mission-label">NEW MISSION</p>
          <p className="mission-prompt">
            Find growth-stage climate companies in Lagos that need a product-design partner.
          </p>
          <button type="button" disabled>
            Start mission <span aria-hidden="true">→</span>
          </button>
          <p className="stage-note">Mission creation is being wired to Convex next.</p>
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
