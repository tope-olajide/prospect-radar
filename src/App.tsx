import { FormEvent, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type AppProps = {
  backendConnected: boolean;
};

type MissionMode = "opportunity" | "person" | "customer" | "solution" | "collaborator";

const sponsorCapabilities = [
  ["Convex", "live missions, durable runs, approvals, outcomes"],
  ["Firecrawl", "search, evidence capture, and durable research"],
  ["OpenAI", "structured plans, explanations, drafts, reply classification"],
  ["AgentMail", "approved sending, delivery receipts, threads, and replies"],
] as const;

function shortDate(value: number) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function App({ backendConnected }: AppProps) {
  const workspaceId = "demo-workspace";
  const missions = useQuery(api.missions.list, backendConnected ? { workspaceId } : "skip");
  const createMission = useMutation(api.missions.create);
  const interpretMission = useAction(api.ai.interpretMission);
  const searchWeb = useAction(api.research.search);
  const scrapeSource = useAction(api.research.scrape);
  const draftMessage = useAction(api.outreach.draft);
  const sendMessage = useAction(api.outreach.send);
  const provisionInbox = useAction(api.outreach.provisionInbox);
  const approveDraft = useMutation(api.outreachStore.approve);
  const updateOutcome = useMutation(api.outcomes.updateStatus);

  const [goal, setGoal] = useState("Find growth-stage climate companies in Lagos that need a product-design partner.");
  const [mode, setMode] = useState<MissionMode>("customer");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planNotice, setPlanNotice] = useState("");

  const [researchQuery, setResearchQuery] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchNotice, setResearchNotice] = useState("");

  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [linkedMatchId, setLinkedMatchId] = useState<Id<"matches"> | null>(null);
  const [outreachNotice, setOutreachNotice] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [sendingActionId, setSendingActionId] = useState<Id<"actionDrafts"> | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const selectedMission = missions?.find((mission) => mission._id === selectedMissionId) ?? missions?.[0];
  const missionId = selectedMission?._id ?? null;

  const plan = useQuery(api.plans.getForMission, backendConnected && missionId ? { missionId } : "skip");
  const run = useQuery(api.runs.forMission, backendConnected && missionId ? { missionId } : "skip");
  const runEvents = useQuery(api.runs.events, backendConnected && run ? { runId: run._id } : "skip");
  const jobs = useQuery(api.researchStore.listJobs, backendConnected && missionId ? { missionId } : "skip");
  const sources = useQuery(api.researchStore.listSources, backendConnected && missionId ? { missionId } : "skip");
  const matches = useQuery(api.researchStore.listMatches, backendConnected && missionId ? { missionId } : "skip");
  const inbox = useQuery(api.outreachStore.getInbox, backendConnected ? { workspaceId } : "skip");
  const drafts = useQuery(api.outreachStore.listDrafts, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const threads = useQuery(api.inbox.listThreads, backendConnected ? { workspaceId, missionId: null } : "skip");
  const threadMessages = useQuery(api.inbox.listMessages, backendConnected && selectedThreadId ? { workspaceId, threadId: selectedThreadId } : "skip");
  const outcomes = useQuery(api.outcomes.listForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !backendConnected) return;
    setSubmitting(true);
    setNotice("");
    try {
      const title = goal.trim().split(/[.!?]/)[0].slice(0, 90);
      await createMission({ workspaceId, title, rawGoal: goal.trim(), mode, constraints: [], sourceScope: "Public web only", completionPredicate: "A user-reviewed, evidence-backed next action exists." });
      setNotice("Mission created. Interpret it with OpenAI, then research it with Firecrawl.");
      setGoal("");
    } catch {
      setNotice("Mission could not be created. Check the local Convex deployment and try again.");
    } finally { setSubmitting(false); }
  }

  async function onInterpret() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try { await interpretMission({ missionId }); setPlanNotice("Structured plan saved to this mission."); }
    catch (error) { setPlanNotice(error instanceof Error ? error.message : "Mission planning failed."); }
    finally { setPlanning(false); }
  }

  async function onSearch() {
    if (!missionId) return;
    const query = (researchQuery.trim() || plan?.normalizedGoal || selectedMission?.rawGoal || "").trim();
    if (!query) { setResearchNotice("Enter a research query first."); return; }
    setResearching(true); setResearchNotice("");
    try {
      const result = await searchWeb({ missionId, requestId: crypto.randomUUID(), query, limit: 6 });
      setResearchNotice(`Firecrawl persisted ${result.resultCount} deduplicated source${result.resultCount === 1 ? "" : "s"}.`);
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Firecrawl research failed.");
    } finally { setResearching(false); }
  }

  async function onScrape(sourceId: Id<"sourceRecords">) {
    if (!missionId) return;
    setResearchNotice("");
    try {
      await scrapeSource({ missionId, sourceId, requestId: crypto.randomUUID() });
      setResearchNotice("Full page content captured with Firecrawl.");
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Firecrawl scrape failed.");
    }
  }

  async function onProvisionInbox() {
    setProvisioning(true); setOutreachNotice("");
    try {
      const result = await provisionInbox({ workspaceId, clientRequestId: `inbox-${workspaceId}`, displayName: "Prospect Radar" });
      setOutreachNotice(`AgentMail inbox ready: ${result.email}`);
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "AgentMail inbox provisioning failed.");
    } finally { setProvisioning(false); }
  }

  async function onDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!missionId) return;
    setDrafting(true); setOutreachNotice("");
    try {
      await draftMessage({
        workspaceId,
        missionId,
        matchId: linkedMatchId,
        agentmailInboxId: inbox?.agentmailInboxId ?? "",
        recipient,
        subject,
        body,
        clientRequestId: crypto.randomUUID(),
      });
      setOutreachNotice("Draft stored. Review it, then approve the exact content.");
      setRecipient(""); setSubject(""); setBody(""); setLinkedMatchId(null);
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "Draft creation failed.");
    } finally { setDrafting(false); }
  }

  async function onApprove(actionId: Id<"actionDrafts">) {
    setOutreachNotice("");
    try {
      await approveDraft({ workspaceId, actionId });
      setOutreachNotice("Approval recorded for this exact recipient, subject, and body.");
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "Approval failed.");
    }
  }

  async function onSend(actionId: Id<"actionDrafts">) {
    setSendingActionId(actionId); setOutreachNotice("");
    try {
      const result = await sendMessage({ workspaceId, actionId });
      setOutreachNotice(result.status === "sent" ? "Sent through AgentMail. Delivery events will appear in the inbox." : `Send state: ${result.status}.`);
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "Send failed.");
    } finally { setSendingActionId(null); }
  }

  async function onOutcomeStatus(outcomeId: Id<"outcomes">, status: "positive" | "negative" | "closed") {
    try { await updateOutcome({ workspaceId, outcomeId, status, nextAction: status === "closed" ? "No further action; relationship archived." : "Continue the conversation with a follow-up if appropriate." }); }
    catch (error) { setOutreachNotice(error instanceof Error ? error.message : "Outcome update failed."); }
  }

  const latestJob = jobs?.[0];

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
          Prospect Radar turns a goal into sourced matches, explainable research,
          approval-bound outreach, and live relationship outcomes.
        </p>
        <form className="mission-card" aria-label="Create a mission" onSubmit={onSubmit}>
          <p className="mission-label">NEW MISSION</p>
          <textarea className="mission-prompt" aria-label="Opportunity goal" value={goal} onChange={(event) => setGoal(event.target.value)} rows={3} />
          <div className="mission-controls">
            <select aria-label="Mission mode" value={mode} onChange={(event) => setMode(event.target.value as MissionMode)}>
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
          {missions === undefined ? <p className="empty-state">Loading live missions…</p> : missions.length === 0 ? <p className="empty-state">No missions yet. Start with a goal above.</p> : missions.map((mission) => <button className={selectedMission?._id === mission._id ? "mission-row selected" : "mission-row"} key={mission._id} onClick={() => { setSelectedMissionId(mission._id); setSelectedThreadId(null); setResearchQuery(""); }}><div><span className={`status-pill status-${mission.status}`}>{mission.status}</span><h3>{mission.title}</h3><p>{mission.mode} · {mission.sourceScope}</p></div><time dateTime={new Date(mission.createdAt).toISOString()}>{new Date(mission.createdAt).toLocaleDateString()}</time></button>)}
        </div>
      </section>

      {selectedMission && (
        <>
          <section className="section" aria-labelledby="plan-title">
            <div className="section-heading"><p className="eyebrow">OPENAI MISSION PLAN</p><h2 id="plan-title">Make the research explicit</h2></div>
            {plan === undefined ? <p className="empty-state">Loading structured plan…</p> : plan ? (
              <div className="plan-card">
                <p>{plan.normalizedGoal}</p>
                <div><strong>Must have</strong><ul>{plan.mustHave.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <div><strong>Missing facts</strong><ul>{plan.missingFacts.map((item) => <li key={item}>{item}</li>)}</ul></div>
                <p className="stage-note">Completion: {plan.completionPredicate}</p>
              </div>
            ) : (
              <div className="plan-card">
                <p>This mission has not been interpreted yet. OpenAI will return a strict, user-reviewable plan; it will not browse, send, or perform side effects.</p>
                <button type="button" onClick={onInterpret} disabled={planning}>{planning ? "Interpreting…" : "Interpret with OpenAI"}</button>
                <p className="stage-note">{planNotice || "Requires OPENAI_API_KEY in the Convex deployment environment."}</p>
              </div>
            )}
            {run && (
              <div className="activity-card">
                <strong>Run activity</strong>
                <p className="stage-note">Stage {run.currentStage} · status {run.status} · checkpoint {run.checkpointVersion}</p>
                <ul>{(runEvents ?? []).slice(-6).reverse().map((event) => <li key={event._id}><span>{event.type}</span> {event.safeSummary}</li>)}</ul>
              </div>
            )}
          </section>

          <section className="section" aria-labelledby="research-title">
            <div className="section-heading"><p className="eyebrow">FIRECRAWL DISCOVERY</p><h2 id="research-title">Evidence before opinions</h2></div>
            <div className="plan-card">
              <div className="toolbar">
                <input aria-label="Research query" placeholder={plan?.normalizedGoal || selectedMission.rawGoal} value={researchQuery} onChange={(event) => setResearchQuery(event.target.value)} />
                <button type="button" onClick={onSearch} disabled={!backendConnected || researching}>{researching ? "Researching…" : "Search the public web"}</button>
              </div>
              <p className="stage-note">{researchNotice || (latestJob ? `Latest Firecrawl job: ${latestJob.operation} · ${latestJob.status} · ${latestJob.resultCount} sources` : "No Firecrawl jobs yet for this mission.")}</p>
              {matches && matches.length > 0 && (
                <div className="card-grid">
                  {matches.map((match) => {
                    const source = sources?.find((item) => item._id === match.sourceId);
                    return (
                      <article className="card" key={match._id}>
                        <span className={`status-pill status-${match.label}`}>{match.label}</span>
                        <h3>{match.subject}</h3>
                        <a href={match.sourceUrl} target="_blank" rel="noreferrer">{match.sourceUrl}</a>
                        <p>{match.signal}</p>
                        {source?.content && <p className="stage-note">Full page captured {shortDate(source.fetchedAt)}.</p>}
                        {match.unknowns.length > 0 && <p className="stage-note">Unknowns: {match.unknowns.join(" · ")}</p>}
                        <div className="toolbar">
                          {!source?.content && <button type="button" onClick={() => onScrape(match.sourceId)}>Scrape full page</button>}
                          <button type="button" className="secondary" onClick={() => { setLinkedMatchId(match._id); if (!recipient) setRecipient(""); }}>Use this match</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="outreach-title">
            <div className="section-heading"><p className="eyebrow">AGENTMAIL OUTREACH</p><h2 id="outreach-title">Draft, approve, then send</h2></div>
            <div className="plan-card">
              {inbox === undefined ? <p className="empty-state">Checking inbox link…</p> : inbox ? (
                <p><strong>Inbox</strong> · {inbox.email}</p>
              ) : (
                <div className="toolbar">
                  <p>No AgentMail inbox is linked to this workspace yet.</p>
                  <button type="button" onClick={onProvisionInbox} disabled={!backendConnected || provisioning}>{provisioning ? "Provisioning…" : "Provision AgentMail inbox"}</button>
                </div>
              )}
              {inbox && (
                <form onSubmit={onDraft} className="draft-form">
                  <label>Recipient<input type="email" required value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="name@company.com" /></label>
                  <label>Subject<input required value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Why this connection makes sense" /></label>
                  <label>Message<textarea required rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reference the evidence you collected and ask one clear question." /></label>
                  <label>Linked match
                    <select value={linkedMatchId ?? ""} onChange={(event) => setLinkedMatchId((event.target.value || null) as Id<"matches"> | null)}>
                      <option value="">None</option>
                      {(matches ?? []).map((match) => <option key={match._id} value={match._id}>{match.subject}</option>)}
                    </select>
                  </label>
                  <button type="submit" disabled={!backendConnected || drafting}>{drafting ? "Creating draft…" : "Create draft"}</button>
                </form>
              )}
              {drafts && drafts.length > 0 && (
                <div className="stack">
                  {drafts.map((draft) => (
                    <article className="card" key={draft._id}>
                      <div className="toolbar">
                        <span className={`status-pill status-${draft.status}`}>{draft.status}</span>
                        <span className="stage-note">to {draft.recipient} · {shortDate(draft.createdAt)}</span>
                      </div>
                      <h3>{draft.subject}</h3>
                      <p className="prewrap">{draft.body}</p>
                      {draft.errorSummary && <p className="stage-note error">{draft.errorSummary}</p>}
                      <div className="toolbar">
                        {!["sent", "delivered", "executing"].includes(draft.status) && (
                          <button type="button" onClick={() => onApprove(draft._id)}>
                            {draft.approvalStatus === "active" ? "Re-approve" : "Approve exact content"}
                          </button>
                        )}
                        {draft.status === "approved" && (
                          <button type="button" onClick={() => onSend(draft._id)} disabled={sendingActionId === draft._id}>
                            {sendingActionId === draft._id ? "Sending…" : "Send via AgentMail"}
                          </button>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <p className="stage-note">{outreachNotice || "Sending is refused server-side unless an active approval matches the exact content hash."}</p>
            </div>
          </section>

          <section className="section" aria-labelledby="inbox-title">
            <div className="section-heading"><p className="eyebrow">LIVE INBOX</p><h2 id="inbox-title">Replies arrive here</h2></div>
            <div className="plan-card">
              {threads === undefined ? <p className="empty-state">Loading threads…</p> : threads.length === 0 ? <p className="empty-state">No conversations yet. Inbound AgentMail events appear here automatically.</p> : (
                <div className="stack">
                  {threads.map((thread) => (
                    <button className={selectedThreadId === thread.threadId ? "thread-row selected" : "thread-row"} key={thread.threadId} onClick={() => setSelectedThreadId(thread.threadId)}>
                      <div>
                        <strong>{thread.subject || "(no subject)"}</strong>
                        <p>{thread.senderSummary} · {thread.preview}</p>
                      </div>
                      <time dateTime={new Date(thread.latestMessageAt).toISOString()}>{shortDate(thread.latestMessageAt)}</time>
                    </button>
                  ))}
                </div>
              )}
              {selectedThreadId && threadMessages && (
                <div className="stack">
                  {threadMessages.map((message) => (
                    <article className={`card message ${message.direction}`} key={message._id}>
                      <div className="toolbar">
                        <strong>{message.direction === "received" ? "From" : "To"} {message.direction === "received" ? message.sender : message.recipients.join(", ")}</strong>
                        <span className="stage-note">{shortDate(message.createdAt)}</span>
                      </div>
                      <p>{message.preview}</p>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="section" aria-labelledby="outcomes-title">
            <div className="section-heading"><p className="eyebrow">OUTCOMES</p><h2 id="outcomes-title">Relationships, not just sends</h2></div>
            <div className="plan-card">
              {outcomes === undefined ? <p className="empty-state">Loading outcomes…</p> : outcomes.length === 0 ? <p className="empty-state">No outcomes yet. Outcomes are created when approved mail is sent or a reply arrives.</p> : (
                <div className="stack">
                  {outcomes.map((outcome) => (
                    <article className="card" key={outcome._id}>
                      <div className="toolbar">
                        <span className={`status-pill status-${outcome.status}`}>{outcome.status}</span>
                        <strong>{outcome.counterpart}</strong>
                        <span className="stage-note">updated {shortDate(outcome.updatedAt)}</span>
                      </div>
                      <p>{outcome.latestEvidence}</p>
                      <p className="stage-note">Next: {outcome.nextAction}</p>
                      <p className="stage-note">{outcome.timeline.length} timeline events · thread {outcome.linkedThreadId ?? "unlinked"}</p>
                      <div className="toolbar">
                        <button type="button" className="secondary" onClick={() => onOutcomeStatus(outcome._id, "positive")}>Mark positive</button>
                        <button type="button" className="secondary" onClick={() => onOutcomeStatus(outcome._id, "closed")}>Close outcome</button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}

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
