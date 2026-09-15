import { FormEvent, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type MissionMode = "opportunity" | "person" | "customer" | "solution" | "collaborator";
type View = "home" | "discover" | "outreach" | "inbox" | "outcomes" | "context" | "activity";

const sponsorCapabilities: Array<[string, string]> = [
  ["Convex", "Durable missions, guarded run transitions, reactive subscriptions, scheduling, and signed webhook routes."],
  ["Firecrawl", "Official component: public-web search, scrape, site maps, and durable crawls with completion callbacks."],
  ["OpenAI", "Compatible LLM endpoint: strict mission plans, evidence-grounded match explanations, reply classification, and drafting."],
  ["AgentMail", "Official component: agent-owned inboxes, durable approved sends, delivery state, and inbound threads."],
];

const navItems: { id: View; label: string; hint: string }[] = [
  { id: "home", label: "Radar brief", hint: "Mission, attention, momentum" },
  { id: "discover", label: "Discover", hint: "Sourced, explained matches" },
  { id: "outreach", label: "Outreach", hint: "Draft, approve, send" },
  { id: "inbox", label: "Inbox", hint: "Live replies and threads" },
  { id: "outcomes", label: "Outcomes", hint: "Relationship memory" },
  { id: "context", label: "Context", hint: "Your profile facts Radar may use" },
  { id: "activity", label: "Activity", hint: "The run's truthful trail" },
];

const viewTitles: Record<View, { eyebrow: string; title: string; description: string }> = {
  home: { eyebrow: "Command center", title: "Your radar is active.", description: "Here is what deserves your attention now." },
  discover: { eyebrow: "Signal intelligence", title: "Evidence before opinions.", description: "Every match carries its source, freshness, and unknowns." },
  outreach: { eyebrow: "Approval boundary", title: "Nothing sends without you.", description: "Approve the exact recipient, subject, and body — then Radar sends." },
  inbox: { eyebrow: "Agent-owned inbox", title: "Replies arrive live.", description: "Inbound mail is untrusted data: classified, never auto-sent." },
  outcomes: { eyebrow: "Relationship memory", title: "Keep the momentum.", description: "Every conversation keeps its evidence and next step." },
  context: { eyebrow: "Verified profile", title: "You stay the source of truth.", description: "Confirm, correct, or reject every fact before Radar ever uses it in plans, matches, or drafts." },
  activity: { eyebrow: "Durable run", title: "Watch Radar work.", description: "Persisted stages and events — never simulated progress." },
};

const quickPrompts: { label: string; goal: string; mode: MissionMode }[] = [
  { label: "Find clients", goal: "Find growth-stage climate companies in Lagos that need a product-design partner.", mode: "customer" },
  { label: "Find a person", goal: "Find a senior Rust engineer in open-source infrastructure who is open to contract work.", mode: "person" },
  { label: "Find a solution", goal: "Find vendors that migrate legacy Postgres clusters under 48-hour windows.", mode: "solution" },
];

function shortDate(value: number) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function App({ backendConnected }: { backendConnected: boolean }) {
  const workspaceId = "demo-workspace";

  const missions = useQuery(api.missions.list, backendConnected ? { workspaceId } : "skip");
  const createMission = useMutation(api.missions.create);
  const interpretMission = useAction(api.ai.interpretMission);
  const searchWeb = useAction(api.research.search);
  const scrapeSource = useAction(api.research.scrape);
  const mapSite = useAction(api.research.mapSite);
  const startCrawl = useAction(api.research.startCrawl);
  const explainMatches = useAction(api.ai.explainMatches);
  const aiDraftMessage = useAction(api.ai.draftMessage);
  const draftMessage = useAction(api.outreach.draft);
  const sendMessage = useAction(api.outreach.send);
  const syncOutbound = useAction(api.outreach.syncOutbound);
  const provisionInbox = useAction(api.outreach.provisionInbox);
  const approveDraft = useMutation(api.outreachStore.approve);
  const updateOutcome = useMutation(api.outcomes.updateStatus);

  const [activeView, setActiveView] = useState<View>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const [goal, setGoal] = useState("Find growth-stage climate companies in Lagos that need a product-design partner.");
  const [mode, setMode] = useState<MissionMode>("customer");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planNotice, setPlanNotice] = useState("");

  const [researchQuery, setResearchQuery] = useState("");
  const [mapUrl, setMapUrl] = useState("");
  const [researching, setResearching] = useState(false);
  const [researchNotice, setResearchNotice] = useState("");

  const [recipient, setRecipient] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [linkedMatchId, setLinkedMatchId] = useState<Id<"matches"> | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [outreachNotice, setOutreachNotice] = useState("");
  const [sendingActionId, setSendingActionId] = useState<Id<"actionDrafts"> | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [factCategory, setFactCategory] = useState("");
  const [factValue, setFactValue] = useState("");
  const [editingFactId, setEditingFactId] = useState<Id<"contextFacts"> | null>(null);
  const [factEditValue, setFactEditValue] = useState("");
  const [aiDraftingMatchId, setAiDraftingMatchId] = useState<Id<"matches"> | null>(null);

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
  const classifications = useQuery(api.outreachStore.listClassifications, backendConnected ? { workspaceId, missionId: null } : "skip");
  const outcomes = useQuery(api.outcomes.listForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const crawlProgress = useQuery(api.researchStore.latestCrawlProgress, backendConnected && missionId ? { missionId } : "skip");
  const contextFacts = useQuery(api.context.list, backendConnected ? { workspaceId, missionId: null } : "skip");
  const addFact = useMutation(api.context.add);
  const confirmFact = useMutation(api.context.confirm);
  const correctFact = useMutation(api.context.correct);
  const rejectFact = useMutation(api.context.reject);
  const deleteFact = useMutation(api.context.deleteFact);
  const setThreadLabel = useMutation(api.inbox.setLabel);

  const latestJob = jobs?.[0];
  const pendingDrafts = (drafts ?? []).filter((draft) => ["draft", "awaiting_approval", "approved", "executing"].includes(draft.status));
  const actionableDrafts = (drafts ?? []).filter((draft) => ["draft", "awaiting_approval", "approved", "executing"].includes(draft.status));
  const openOutcomes = (outcomes ?? []).filter((outcome) => !["positive", "negative", "closed"].includes(outcome.status));

  const navCounts: Record<View, number | null> = {
    home: null,
    discover: matches?.length ?? null,
    outreach: actionableDrafts.length || null,
    inbox: threads?.length || null,
    outcomes: openOutcomes.length || null,
    context: null,
    activity: null,
  };

  const attentionItems = useMemo(() => {
    const items: { id: string; title: string; detail: string; tone: "amber" | "cyan"; view: View }[] = [];
    if (actionableDrafts.length > 0) {
      const approved = actionableDrafts.find((draft) => draft.status === "approved");
      items.push({
        id: "approval",
        title: approved ? "A draft is approved — sending is one click away" : "A draft needs your approval",
        detail: approved ? `${approved.subject} → ${approved.recipient}` : "Sending is refused server-side until the exact content is approved.",
        tone: "amber",
        view: "outreach",
      });
    }
    if (plan && plan.missingFacts.length > 0) {
      items.push({ id: "facts", title: `${plan.missingFacts.length} missing fact${plan.missingFacts.length === 1 ? "" : "s"} could change the search`, detail: plan.missingFacts[0], tone: "cyan", view: "discover" });
    }
    const freshReplies = (threads ?? []).filter((thread) => thread.labels.includes("replied")).length;
    if (freshReplies > 0) {
      items.push({ id: "replies", title: `${freshReplies} inbound repl${freshReplies === 1 ? "y" : "ies"} waiting for review`, detail: "Classifications and suggested next steps are ready in the inbox.", tone: "cyan", view: "inbox" });
    }
    return items;
  }, [actionableDrafts, plan, threads]);

  function selectView(view: View) {
    setActiveView(view);
    setMobileNavOpen(false);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !backendConnected) return;
    setSubmitting(true);
    setNotice("");
    try {
      const result = await createMission({ workspaceId, title: goal.trim().slice(0, 80), rawGoal: goal.trim(), mode, constraints: [], sourceScope: "public-web", completionPredicate: "A user-approved next action exists for at least one sourced match." });
      setSelectedMissionId(result.missionId);
      setNotice("Mission created. Interpret it with OpenAI, then research it with Firecrawl.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Mission creation failed.");
    } finally {
      setSubmitting(false);
    }
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

  async function onMapSite() {
    if (!missionId) return;
    const target = (mapUrl.trim() || "").trim();
    if (!target) { setResearchNotice("Enter a site URL to map (https://…)."); return; }
    setResearching(true); setResearchNotice("");
    try {
      const result = await mapSite({ missionId, requestId: crypto.randomUUID(), url: target, limit: 25 });
      setResearchNotice(`Firecrawl mapped ${result.linkCount} site URL${result.linkCount === 1 ? "" : "s"}.`);
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Firecrawl map failed.");
    } finally { setResearching(false); }
  }

  async function onStartCrawl() {
    if (!missionId) return;
    const target = (mapUrl.trim() || "").trim();
    if (!target) { setResearchNotice("Enter a site URL to crawl (https://…)."); return; }
    setResearching(true); setResearchNotice("");
    try {
      const result = await startCrawl({ missionId, requestId: crypto.randomUUID(), url: target, limit: 10 });
      setResearchNotice(`Durable crawl started (${result.crawlId}). Pages stream in as they are captured.`);
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Firecrawl crawl failed to start.");
    } finally { setResearching(false); }
  }

  async function onExplainMatches() {
    if (!missionId) return;
    setResearching(true); setResearchNotice("");
    try {
      const result = await explainMatches({ missionId });
      setResearchNotice(`AI explanations saved for ${result.explained} match${result.explained === 1 ? "" : "es"} (${result.model}).`);
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Match explanation failed.");
    } finally { setResearching(false); }
  }

  async function onAiDraft(matchId: Id<"matches">) {
    if (!missionId || !inbox) { setResearchNotice("Link an AgentMail inbox first (Outreach view)." ); return; }
    setAiDraftingMatchId(matchId); setResearchNotice("");
    try {
      const result = await aiDraftMessage({
        workspaceId,
        missionId,
        matchId,
        agentmailInboxId: inbox.agentmailInboxId,
        clientRequestId: `ai-draft-${matchId}-${Date.now()}`,
      });
      if (result.actionId) {
        setResearchNotice(`AI draft created for ${result.recipient}. Approve it in Outreach.`);
        setLinkedMatchId(matchId);
      } else {
        setResearchNotice(`The model drafted a subject and body, but no verified recipient email exists in the evidence. Review it in Outreach.`);
        setSubject(result.subject); setBody(result.body); setLinkedMatchId(matchId);
      }
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "AI drafting failed.");
    } finally { setAiDraftingMatchId(null); }
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
      setOutreachNotice(result.providerMessageId ? "Sent through AgentMail. Delivery updates arrive automatically." : "Send accepted; provider confirmation is pending. Use Check send status.");
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "Send failed.");
    } finally { setSendingActionId(null); }
  }

  async function onSyncOutbound(actionId: Id<"actionDrafts">) {
    try { await syncOutbound({ workspaceId, actionId }); } catch { /* surfaced through draft state */ }
  }

  async function onOutcomeStatus(outcomeId: Id<"outcomes">, status: "positive" | "negative" | "closed") {
    try { await updateOutcome({ workspaceId, outcomeId, status, nextAction: status === "closed" ? "No further action; relationship archived." : "Continue the conversation with a follow-up if appropriate." }); }
    catch (error) { setOutreachNotice(error instanceof Error ? error.message : "Outcome update failed."); }
  }

  const runWorking = run && ["queued", "active"].includes(run.status);
  const linkedMatchSource = linkedMatchId ? sources?.find((source) => source._id === matches?.find((match) => match._id === linkedMatchId)?.sourceId) : undefined;

  const sidebar = (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-mark">↗</div>
        <div><strong>Prospect Radar</strong><span>OPPORTUNITY OS</span></div>
      </div>
      <div className="workspace-switcher">
        <div className="workspace-avatar">PR</div>
        <div className="workspace-copy"><strong>Demo workspace</strong><span>Judge-friendly scope</span></div>
      </div>
      <p className="nav-section-label">Workspace</p>
      <nav className="main-nav" aria-label="Primary">
        {navItems.map((item) => (
          <button key={item.id} type="button" className={activeView === item.id ? "nav-item active" : "nav-item"} onClick={() => selectView(item.id)}>
            <span className="nav-label"><strong>{item.label}</strong><em>{item.hint}</em></span>
            {navCounts[item.id] ? <span className="nav-count">{navCounts[item.id]}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-spacer" />
      <div className="backend-status-card">
        <div className="status-icon"><span className="status-dot" /></div>
        <div><strong>{backendConnected ? "Convex connected" : "Backend setup"}</strong><span>{backendConnected ? "Live subscriptions on" : "Run npx convex dev"}</span></div>
      </div>
      {selectedMission && <div className="backend-status-card mission-chip"><div className="status-icon"><span className="status-dot amber-dot" /></div><div><strong>{selectedMission.title.slice(0, 30)}{selectedMission.title.length > 30 ? "…" : ""}</strong><span>{run ? `${run.currentStage} · ${run.status}` : selectedMission.status}</span></div></div>}
    </aside>
  );

  return (
    <div className="app-shell">
      {sidebar}

      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <button type="button" className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>☰</button>
            <strong>{viewTitles[activeView].title}</strong>
            <span>{viewTitles[activeView].eyebrow}</span>
          </div>
          <div className="topbar-actions">
            <span className="live-status"><span className="pulse-dot" />{backendConnected ? "LIVE" : "OFFLINE"}</span>
            {attentionItems.length > 0 && <button type="button" className="attention-chip" onClick={() => selectView(attentionItems[0].view)}>{attentionItems.length} need{attentionItems.length === 1 ? "" : "s"} attention</button>}
          </div>
        </header>

        <main className="content-wrap" id="top">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{viewTitles[activeView].eyebrow}</p>
              <h1>{viewTitles[activeView].title}</h1>
              <p className="page-desc">{viewTitles[activeView].description}</p>
            </div>
          </div>

          {activeView === "home" && (
            <div className="view-stack">
              <section className="panel composer-panel" aria-label="Start a mission">
                <div className="composer-copy">
                  <h2>What should Radar find for you?</h2>
                  <p>Describe the outcome. Radar plans the work, researches public evidence, and comes back when your approval is the only thing missing.</p>
                </div>
                <form onSubmit={onSubmit}>
                  <label className="field-label" htmlFor="mission-goal">Your goal</label>
                  <textarea id="mission-goal" className="composer-input" rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="Opportunity goal" />
                  <div className="composer-controls">
                    <select aria-label="Mission mode" value={mode} onChange={(event) => setMode(event.target.value as MissionMode)}>
                      <option value="opportunity">Find an opportunity</option><option value="person">Find a person</option><option value="customer">Find a customer</option><option value="solution">Find a solution</option><option value="collaborator">Find a collaborator</option>
                    </select>
                    <button type="submit" className="btn" disabled={!backendConnected || submitting || !goal.trim()}>{submitting ? "Queuing…" : "Start mission →"}</button>
                  </div>
                  {notice && <p className="stage-note">{notice}</p>}
                  <div className="quick-prompts" aria-label="Starting points">
                    {quickPrompts.map((prompt) => (
                      <button key={prompt.label} type="button" onClick={() => { setGoal(prompt.goal); setMode(prompt.mode); }}>{prompt.label}</button>
                    ))}
                  </div>
                </form>
              </section>

              {attentionItems.length > 0 && (
                <section className="attention-grid" aria-label="Needs attention">
                  {attentionItems.map((item) => (
                    <button key={item.id} type="button" className={`attention-card ${item.tone === "amber" ? "tone-amber" : "tone-cyan"}`} onClick={() => selectView(item.view)}>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                      <span>Resolve →</span>
                    </button>
                  ))}
                </section>
              )}

              <div className="home-grid">
                <section className="panel" aria-label="Active mission">
                  <div className="panel-head"><p className="eyebrow">ACTIVE MISSION</p>{selectedMission && <span className={`status-pill status-${selectedMission.status}`}>{selectedMission.status}</span>}</div>
                  {!selectedMission ? (
                    <p className="empty-state">No mission yet. Start with a goal above and Radar creates a durable run.</p>
                  ) : (
                    <>
                      <h3>{selectedMission.title}</h3>
                      <p className="muted">{selectedMission.mode} · {selectedMission.sourceScope}</p>
                      {run && <p className="stage-note">Stage {run.currentStage} · status {run.status} · checkpoint {run.checkpointVersion}</p>}
                      {plan ? (
                        <>
                          <p className="plan-goal">{plan.normalizedGoal}</p>
                          {plan.mustHave.length > 0 && <p className="stage-note">Must have: {plan.mustHave.join(" · ")}</p>}
                          <p className="stage-note">Completion: {plan.completionPredicate}</p>
                        </>
                      ) : (
                        <div className="inline-actions">
                          <button type="button" className="btn" onClick={onInterpret} disabled={planning}>{planning ? "Interpreting…" : "Interpret with OpenAI"}</button>
                          <span className="stage-note">{planNotice}</span>
                        </div>
                      )}
                      <div className="inline-actions">
                        <button type="button" className="btn ghost" onClick={() => selectView("discover")}>Open Discover →</button>
                        <button type="button" className="btn ghost" onClick={() => selectView("activity")}>Run activity</button>
                      </div>
                    </>
                  )}
                </section>

                <section className="panel" aria-label="Mission queue">
                  <div className="panel-head"><p className="eyebrow">MISSION QUEUE</p><span className="muted">{missions?.length ?? 0}</span></div>
                  {missions === undefined ? <p className="empty-state">Loading…</p> : missions.length === 0 ? <p className="empty-state">No missions yet.</p> : (
                    <div className="row-list">
                      {missions.map((mission) => (
                        <button key={mission._id} type="button" className={selectedMission?._id === mission._id ? "row-item selected" : "row-item"} onClick={() => setSelectedMissionId(mission._id)}>
                          <div><strong>{mission.title}</strong><em>{mission.mode} · {shortDate(mission.createdAt)}</em></div>
                          <span className={`status-pill status-${mission.status}`}>{mission.status}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <section className="panel" aria-label="How Radar works">
                <div className="panel-head"><p className="eyebrow">THE JOURNEY</p></div>
                <ol className="journey">
                  <li><span>01</span><strong>Tell Radar</strong><p>A goal becomes a strict, editable plan.</p></li>
                  <li><span>02</span><strong>Radar researches</strong><p>Firecrawl gathers sourced public evidence.</p></li>
                  <li><span>03</span><strong>You decide</strong><p>Explanations show fit, unknowns, and risks.</p></li>
                  <li><span>04</span><strong>Approved send</strong><p>AgentMail delivers only approved content.</p></li>
                  <li><span>05</span><strong>Memory keeps</strong><p>Replies and outcomes stay attached to the mission.</p></li>
                </ol>
                <div className="sponsor-strip">
                  {sponsorCapabilities.map(([sponsor, capability]) => (
                    <div key={sponsor} className="sponsor-chip"><strong>{sponsor}</strong><span>{capability}</span></div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {activeView === "discover" && (
            <div className="view-stack">
              {!selectedMission ? <p className="empty-state">Select or start a mission first.</p> : (
                <>
                  <section className="panel" aria-label="Research controls">
                    <div className="panel-head"><p className="eyebrow">FIRECRAWL DISCOVERY</p>{runWorking && <span className="status-pill status-running">run active</span>}</div>
                    <div className="control-row">
                      <input aria-label="Research query" placeholder={plan?.normalizedGoal || selectedMission.rawGoal} value={researchQuery} onChange={(event) => setResearchQuery(event.target.value)} />
                      <button type="button" className="btn" onClick={onSearch} disabled={!backendConnected || researching}>{researching ? "Researching…" : "Search"}</button>
                      <button type="button" className="btn ghost" onClick={onExplainMatches} disabled={!backendConnected || researching}>Explain matches</button>
                    </div>
                    <div className="control-row">
                      <input aria-label="Site URL" placeholder="https://example.com — map it or run a durable crawl" value={mapUrl} onChange={(event) => setMapUrl(event.target.value)} />
                      <button type="button" className="btn ghost" onClick={onMapSite} disabled={!backendConnected || researching}>Map site</button>
                      <button type="button" className="btn ghost" onClick={onStartCrawl} disabled={!backendConnected || researching}>Durable crawl</button>
                    </div>
                    {crawlProgress && crawlProgress.jobStatus === "running" && (
                      <p className="stage-note warn">
                        Durable crawl {crawlProgress.crawlStatus}{crawlProgress.total ? ` · ${crawlProgress.completed ?? 0}/${crawlProgress.total} pages` : ""} · {crawlProgress.pageCount} captured{crawlProgress.error ? ` · ${crawlProgress.error}` : ""}
                      </p>
                    )}
                    <p className="stage-note">{researchNotice || (latestJob ? `Latest job: ${latestJob.operation} · ${latestJob.status}${latestJob.crawlStatus ? ` (${latestJob.crawlStatus})` : ""} · ${latestJob.resultCount} sources` : "No Firecrawl jobs yet for this mission.")}</p>
                  </section>

                  <section aria-label="Matches">
                    {matches === undefined ? <p className="empty-state">Loading matches…</p> : matches.length === 0 ? (
                      <div className="panel"><p className="empty-state">No matches yet. Run a search — Radar explains which constraint limited discovery rather than inventing candidates.</p></div>
                    ) : (
                      <div className="match-grid">
                        {matches.map((match) => {
                          const source = sources?.find((item) => item._id === match.sourceId);
                          return (
                            <article className="panel match-card" key={match._id}>
                              <div className="panel-head">
                                <span className={`status-pill status-${match.label}`}>{match.label}</span>
                                {match.explanationModel && <span className="mono-tag">{match.explanationModel}</span>}
                              </div>
                              <h3>{match.subject}</h3>
                              <a className="source-link" href={match.sourceUrl} target="_blank" rel="noreferrer">View source: {new URL(match.sourceUrl).hostname}{source ? ` · fetched ${shortDate(source.fetchedAt)}` : ""}</a>
                              <p className="match-signal">{match.explanationSummary || match.signal}</p>
                              {match.positiveEvidence.length > 0 && <p className="stage-note">Evidence: {match.positiveEvidence[0]}</p>}
                              {match.unknowns.length > 0 && <p className="stage-note warn">Unknowns: {match.unknowns.join(" · ")}</p>}
                              {match.risks.length > 0 && <p className="stage-note error">Risks: {match.risks.join(" · ")}</p>}
                              {match.recommendedAction && <p className="next-action"><b>Next</b>{match.recommendedAction}</p>}
                              <div className="inline-actions">
                                {source && !source.content && <button type="button" className="btn ghost" onClick={() => onScrape(match.sourceId)}>Scrape full page</button>}
                                <button type="button" className="btn" onClick={() => onAiDraft(match._id)} disabled={aiDraftingMatchId === match._id}>
                                  {aiDraftingMatchId === match._id ? "Drafting…" : "AI draft outreach"}
                                </button>
                                <button type="button" className="btn ghost" onClick={() => { setLinkedMatchId(match._id); selectView("outreach"); }}>Write manually</button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {activeView === "outreach" && (
            <div className="view-stack">
              <section className="panel" aria-label="Inbox link">
                <div className="panel-head"><p className="eyebrow">AGENTMAIL INBOX</p>{inbox && <span className="mono-tag">{inbox.email}</span>}</div>
                {inbox === undefined ? <p className="empty-state">Checking inbox link…</p> : !inbox ? (
                  <div className="inline-actions">
                    <p className="empty-state">No inbox is linked to this workspace yet.</p>
                    <button type="button" className="btn" onClick={onProvisionInbox} disabled={!backendConnected || provisioning}>{provisioning ? "Provisioning…" : "Provision inbox"}</button>
                  </div>
                ) : <p className="stage-note">Outbound mail sends from this inbox only after your approval.</p>}
              </section>

              {inbox && selectedMission && (
                <section className="panel" aria-label="Compose outreach">
                  <div className="panel-head"><p className="eyebrow">NEW DRAFT</p>{linkedMatchId && <span className="mono-tag">linked to match</span>}</div>
                  <form onSubmit={onDraft} className="draft-form">
                    <div className="field-pair">
                      <label>Recipient<input type="email" required value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="name@company.com" /></label>
                      <label>Linked match
                        <select value={linkedMatchId ?? ""} onChange={(event) => setLinkedMatchId((event.target.value || null) as Id<"matches"> | null)}>
                          <option value="">None</option>
                          {(matches ?? []).map((match) => <option key={match._id} value={match._id}>{match.subject}</option>)}
                        </select>
                      </label>
                    </div>
                    <label>Subject<input required value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Why this connection makes sense" /></label>
                    <label>Message<textarea required rows={5} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Reference the evidence you collected and ask one clear question." /></label>
                    {linkedMatchSource && <p className="stage-note">Context used: {linkedMatchSource.url}</p>}
                    <button type="submit" className="btn" disabled={!backendConnected || drafting}>{drafting ? "Creating draft…" : "Create draft"}</button>
                  </form>
                </section>
              )}

              <section aria-label="Drafts">
                {drafts === undefined ? <p className="empty-state">Loading drafts…</p> : drafts.length === 0 ? (
                  <div className="panel"><p className="empty-state">No drafts yet. Drafts can be autonomous; sending never is.</p></div>
                ) : (
                  <div className="view-stack">
                    {drafts.map((draft) => (
                      <article className={`panel approval-card ${draft.status === "approved" ? "approved" : ""}`} key={draft._id}>
                        <div className="panel-head">
                          <span className={`status-pill status-${draft.status}`}>{draft.status}</span>
                          <span className="muted">to {draft.recipient} · {shortDate(draft.createdAt)}</span>
                          {draft.approvalExpiresAt && draft.approvalStatus === "active" && <span className="mono-tag">approval expires {shortDate(draft.approvalExpiresAt)}</span>}
                        </div>
                        <h3>{draft.subject}</h3>
                        <p className="prewrap draft-body">{draft.body}</p>
                        {draft.matchId && matches?.find((match) => match._id === draft.matchId) && (
                          <p className="stage-note">Context used: match “{matches.find((match) => match._id === draft.matchId)?.subject}”</p>
                        )}
                        <p className="stage-note">Side effect: one email from the linked AgentMail inbox to {draft.recipient}. Nothing else.</p>
                        {draft.errorSummary && <p className="stage-note error">{draft.errorSummary}</p>}
                        <div className="inline-actions">
                          {![ "sent", "delivered", "executing" ].includes(draft.status) && (
                            <button type="button" className="btn" onClick={() => onApprove(draft._id)}>
                              {draft.approvalStatus === "active" ? "Re-approve" : "Approve exact content"}
                            </button>
                          )}
                          {draft.status === "approved" && (
                            <button type="button" className="btn" onClick={() => onSend(draft._id)} disabled={sendingActionId === draft._id}>
                              {sendingActionId === draft._id ? "Sending…" : "Send via AgentMail"}
                            </button>
                          )}
                          {draft.status === "executing" && draft.outboundId && (
                            <button type="button" className="btn ghost" onClick={() => onSyncOutbound(draft._id)}>Check send status</button>
                          )}
                          {draft.providerMessageId && <span className="mono-tag">message {draft.providerMessageId.slice(0, 14)}…</span>}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {outreachNotice && <p className="stage-note">{outreachNotice}</p>}
              </section>
            </div>
          )}

          {activeView === "inbox" && (
            <div className="view-stack">
              <div className="inbox-layout">
                <section className="panel" aria-label="Threads">
                  <div className="panel-head"><p className="eyebrow">THREADS</p><span className="muted">{threads?.length ?? 0}</span></div>
                  {threads === undefined ? <p className="empty-state">Loading…</p> : threads.length === 0 ? <p className="empty-state">No conversations yet. Inbound AgentMail events appear here automatically.</p> : (
                    <div className="row-list">
                      {threads.map((thread) => (
                      <article className={selectedThreadId === thread.threadId ? "row-item static selected" : "row-item static"} key={thread._id}>
                        <button type="button" className="thread-select" onClick={() => setSelectedThreadId(thread.threadId)}>
                          <strong>{thread.subject || "(no subject)"}</strong>
                          <em>{thread.senderSummary} · {thread.preview}</em>
                          <span className="thread-meta">{thread.labels.map((label) => `#${label}`).join(" ")}</span>
                        </button>
                        {selectedThreadId === thread.threadId && (
                          <div className="inline-actions">
                            {(["new", "waiting", "reply", "closed"] as const).map((label) => (
                              <button key={label} type="button" className={thread.labels.includes(label) ? "btn" : "btn ghost"} onClick={() => setThreadLabel({ workspaceId, threadId: thread._id, label, set: !thread.labels.includes(label) })}>{label}</button>
                            ))}
                          </div>
                        )}
                      </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="panel" aria-label="Conversation">
                  <div className="panel-head"><p className="eyebrow">CONVERSATION</p>{pendingDrafts.length > 0 && <span className="muted">{pendingDrafts.length} open draft{pendingDrafts.length === 1 ? "" : "s"}</span>}</div>
                  {!selectedThreadId ? <p className="empty-state">Select a thread to read the conversation and classifications.</p> : threadMessages === undefined ? <p className="empty-state">Loading messages…</p> : threadMessages.length === 0 ? <p className="empty-state">No messages in this thread yet.</p> : (
                    <div className="view-stack">
                      {threadMessages.map((message) => {
                        const classification = classifications?.find((item) => item.messageId === message._id);
                        const suggestedDraft = classification?.suggestedDraftId ? drafts?.find((draft) => draft._id === classification.suggestedDraftId) : undefined;
                        return (
                          <article className={`message-card ${message.direction}`} key={message._id}>
                            <div className="panel-head">
                              <strong>{message.direction === "received" ? `From ${message.sender}` : `To ${message.recipients.join(", ")}`}</strong>
                              {classification && <span className={`status-pill status-${classification.label}`}>{classification.label}</span>}
                              <span className="muted">{shortDate(message.createdAt)}</span>
                            </div>
                            <p>{message.preview}</p>
                            {classification && (
                              <div className="classification-note">
                                <p className="stage-note">{classification.summary} · confidence {Math.round(classification.confidence * 100)}% · {classification.model}</p>
                                <p className="stage-note">Suggested next step: {classification.suggestedNextAction}</p>
                                {suggestedDraft && (
                                  <>
                                    <p className="prewrap draft-suggestion">{suggestedDraft.body}</p>
                                    <div className="inline-actions">
                                      <button type="button" className="btn" onClick={() => onApprove(suggestedDraft._id)}>
                                        {suggestedDraft.approvalStatus === "active" ? "Re-approve reply" : "Approve suggested reply"}
                                      </button>
                                      {suggestedDraft.status === "approved" && (
                                        <button type="button" className="btn" onClick={() => onSend(suggestedDraft._id)} disabled={sendingActionId === suggestedDraft._id}>
                                          {sendingActionId === suggestedDraft._id ? "Sending…" : "Send reply"}
                                        </button>
                                      )}
                                    </div>
                                  </>
                                )}
                                {classification.model === "pending" && <p className="stage-note">Classifying this reply…</p>}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {activeView === "outcomes" && (
            <div className="view-stack">
              <section aria-label="Outcomes">
                {outcomes === undefined ? <p className="empty-state">Loading outcomes…</p> : outcomes.length === 0 ? (
                  <div className="panel"><p className="empty-state">No outcomes yet. Outcomes are created when approved mail is sent or a reply arrives — Radar keeps the relationship, not just the send.</p></div>
                ) : (
                  <div className="view-stack">
                    {outcomes.map((outcome) => (
                      <article className="panel" key={outcome._id}>
                        <div className="panel-head">
                          <span className={`status-pill status-${outcome.status}`}>{outcome.status}</span>
                          <strong>{outcome.counterpart}</strong>
                          <span className="muted">updated {shortDate(outcome.updatedAt)}</span>
                        </div>
                        <p>{outcome.latestEvidence}</p>
                        <p className="next-action"><b>Next</b>{outcome.nextAction}</p>
                        <p className="stage-note">{outcome.timeline.length} timeline events · thread {outcome.linkedThreadId ?? "unlinked"}</p>
                        <div className="inline-actions">
                          <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "positive")}>Mark positive</button>
                          <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "closed")}>Close outcome</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {activeView === "context" && (
            <div className="view-stack">
              <section className="panel" aria-label="Add a profile fact">
                <div className="panel-head"><p className="eyebrow">ADD A FACT</p></div>
                <p className="stage-note">User-entered facts are confirmed immediately. Anything Radar infers later starts unreviewed and is never used until you confirm it.</p>
                <div className="control-row">
                  <input className="composer-input" style={{ flex: "0 0 220px" }} placeholder="Category (e.g. my skills)" value={factCategory} onChange={(e) => setFactCategory(e.target.value)} aria-label="Fact category" maxLength={60} />
                  <input className="composer-input" placeholder="Value (e.g. React, TypeScript, product design)" value={factValue} onChange={(e) => setFactValue(e.target.value)} aria-label="Fact value" maxLength={240} />
                  <button type="button" className="btn" disabled={!backendConnected || !factCategory.trim() || !factValue.trim()} onClick={async () => { await addFact({ workspaceId, missionId: null, category: factCategory, value: factValue, sourceType: "user_input", sourceReference: null, confidence: 1, visibility: "workspace" }); setFactCategory(""); setFactValue(""); }}>Add fact</button>
                </div>
              </section>

              <section className="panel" aria-label="Profile facts">
                <div className="panel-head"><p className="eyebrow">PROFILE FACTS</p><span className="muted">{contextFacts?.length ?? 0} stored</span></div>
                {contextFacts === undefined ? <p className="empty-state">Loading facts…</p> : contextFacts.length === 0 ? <p className="empty-state">No profile facts yet. Add skills, services, goals, or constraints — confirmed facts guide plans, match explanations, and drafts.</p> : (
                  <div className="row-list">
                    {contextFacts.map((fact) => (
                      <article className="row-item static" key={fact._id}>
                        <div>
                          <strong>{fact.category}</strong>
                          <em>{fact.value}</em>
                          <span className="muted">{fact.sourceType} · added {shortDate(fact.createdAt)}</span>
                        </div>
                        <div className="inline-actions">
                          <span className={`status-pill status-${fact.verificationStatus}`}>{fact.verificationStatus.replace("user_", "")}</span>
                          {fact.verificationStatus !== "user_confirmed" && <button type="button" className="btn ghost" onClick={() => confirmFact({ workspaceId, factId: fact._id })}>Confirm</button>}
                          {editingFactId === fact._id ? (
                            <>
                              <input className="composer-input" style={{ maxWidth: 220 }} value={factEditValue} onChange={(e) => setFactEditValue(e.target.value)} aria-label="Corrected value" maxLength={240} />
                              <button type="button" className="btn ghost" onClick={async () => { await correctFact({ workspaceId, factId: fact._id, value: factEditValue }); setEditingFactId(null); }}>Save</button>
                            </>
                          ) : (
                            <button type="button" className="btn ghost" onClick={() => { setEditingFactId(fact._id); setFactEditValue(fact.value); }}>Correct</button>
                          )}
                          <button type="button" className="btn ghost" onClick={() => rejectFact({ workspaceId, factId: fact._id })}>Reject</button>
                          <button type="button" className="btn ghost" onClick={() => deleteFact({ workspaceId, factId: fact._id })}>Delete</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}

          {activeView === "activity" && (
            <div className="view-stack">
              {!run ? <div className="panel"><p className="empty-state">No run yet for this mission. Create or select a mission to see its durable activity.</p></div> : (
                <>
                  <section className="panel" aria-label="Run state">
                    <div className="panel-head"><p className="eyebrow">RUN STATE</p><span className={`status-pill status-${run.status}`}>{run.status}</span></div>
                    <p className="stage-note">Stage {run.currentStage} · checkpoint {run.checkpointVersion} · started {run.startedAt ? shortDate(run.startedAt) : "—"}</p>
                    {run.activeInterruption && <p className="stage-note warn">Interruption: {run.activeInterruption}</p>}
                  </section>
                  <section className="panel" aria-label="Event trail">
                    <div className="panel-head"><p className="eyebrow">EVENT TRAIL</p><span className="muted">{runEvents?.length ?? 0} events</span></div>
                    <ol className="event-trail">
                      {(runEvents ?? []).slice().reverse().map((event) => (
                        <li key={event._id}><span className="event-dot" /><div><strong>{event.type}</strong><em>{event.safeSummary}</em><small>{shortDate(event.createdAt)} · {event.stage}</small></div></li>
                      ))}
                    </ol>
                  </section>
                  <section className="panel" aria-label="Research jobs">
                    <div className="panel-head"><p className="eyebrow">FIRECRAWL JOBS</p></div>
                    {jobs === undefined || jobs.length === 0 ? <p className="empty-state">No research jobs yet.</p> : (
                      <div className="row-list">
                        {jobs.map((job) => (
                          <div className="row-item static" key={job._id}>
                            <div><strong>{job.operation} · {job.query.slice(0, 60)}{job.query.length > 60 ? "…" : ""}</strong><em>{job.resultCount} sources{job.crawlId ? ` · crawl ${job.crawlId.slice(0, 12)}…` : ""}</em></div>
                            <span className={`status-pill status-${job.status}`}>{job.status}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          <footer className="app-footer">
            <p>Built for Convex All Gas · Research is evidence, not an instruction · Sending requires approval.</p>
          </footer>
        </main>
      </div>

      <div className={mobileNavOpen ? "mobile-nav-backdrop visible" : "mobile-nav-backdrop"} onClick={() => setMobileNavOpen(false)} />
      <div className={mobileNavOpen ? "mobile-drawer open" : "mobile-drawer"} aria-hidden={!mobileNavOpen}>
        <div className="mobile-drawer-head"><strong>Prospect Radar</strong><button type="button" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)}>✕</button></div>
        <nav className="main-nav" aria-label="Mobile">
          {navItems.map((item) => (
            <button key={item.id} type="button" className={activeView === item.id ? "nav-item active" : "nav-item"} onClick={() => selectView(item.id)}>
              <span className="nav-label"><strong>{item.label}</strong><em>{item.hint}</em></span>
              {navCounts[item.id] ? <span className="nav-count">{navCounts[item.id]}</span> : null}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
