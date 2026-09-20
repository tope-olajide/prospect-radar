import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useTheme, type ThemeChoice } from "./useTheme";
import { MissionLifecycle } from "./MissionLifecycle";
import { useAuthActions } from "@convex-dev/auth/react";
import SignIn from "./SignIn";

type View = "home" | "discover" | "actions" | "inbox" | "outcomes" | "profile" | "activity";
type PipelineStageName = "contacted" | "replied" | "engaged" | "meeting" | "proposal" | "won" | "lost" | "dormant";

const PIPELINE_LABELS: Record<PipelineStageName, string> = {
  contacted: "Contacted", replied: "Replied", engaged: "Engaged", meeting: "Meeting",
  proposal: "Proposal", won: "Won", lost: "Lost", dormant: "Dormant",
};

const sponsorCapabilities: Array<[string, string]> = [
  ["Convex", "Durable missions, guarded run transitions, reactive subscriptions, scheduling, and signed webhook routes."],
  ["Firecrawl", "Official component: public-web search, scrape, site maps, and durable crawls with completion callbacks."],
  ["OpenAI", "Compatible LLM endpoint: strict mission plans, evidence-grounded match explanations, reply classification, and drafting."],
  ["AgentMail", "Official component: agent-owned inboxes, durable approved sends, delivery state, and inbound threads."],
];

/**
 * Navigation is grouped by the user's mental model of the agent, not by
 * implementation module: where you direct Radar, what it produces, what it
 * knows about you, and how the machinery is doing.
 */
const navItems: { id: View; label: string; hint: string; group: string }[] = [
  { id: "home", label: "Home", hint: "What is Radar doing?", group: "RADAR" },
  { id: "discover", label: "Discover", hint: "What did Radar find?", group: "WORK" },
  { id: "actions", label: "Actions", hint: "What is Radar going to do?", group: "WORK" },
  { id: "inbox", label: "Inbox", hint: "What happened externally?", group: "WORK" },
  { id: "outcomes", label: "Outcomes", hint: "What resulted?", group: "WORK" },
  { id: "profile", label: "Profile", hint: "What does Radar know about me?", group: "KNOWLEDGE" },
];

const navGroups: string[] = ["RADAR", "WORK", "KNOWLEDGE", "SYSTEM"];

const viewTitles: Record<View, { eyebrow: string; title: string; description: string }> = {
  home: { eyebrow: "Agent workspace", title: "Home", description: "Tell Radar what you want. It works in the background — leave, and it calls you only when your attention is needed." },
  discover: { eyebrow: "Signal intelligence", title: "What Radar found, and why.", description: "Every match carries its source, freshness, unknowns, and the decision Radar reached about it." },
  actions: { eyebrow: "Approval boundary", title: "What Radar proposes and does.", description: "Each draft is approved as its own exact payload, then Radar executes and observes it on its own." },
  inbox: { eyebrow: "Agent-owned inbox", title: "Replies arrive live.", description: "Inbound mail is untrusted data: classified, never auto-sent." },
  outcomes: { eyebrow: "Results", title: "What actually happened.", description: "Contacted, replied, interested, meeting, proposal, converted — tied back to the mission that caused it." },
  profile: { eyebrow: "Your identity", title: "Who you are to Radar.", description: "Sources, skills, preferences, and what Radar has learned — all in one place." },
  activity: { eyebrow: "Agent timeline", title: "What Radar did.", description: "Real run events from real execution — nothing animated, nothing invented." },
};

/**
 * Starting points that mirror what Radar is actually for.
 *
 * One per side of the network — work to win, expertise to hire, a vendor to
 * fulfil a need, and buyers for your own product — deliberately spread across
 * industries, because a set of engineering examples reads as a tool for
 * engineers. Each goal is concrete enough to research well (a market, a
 * deliverable, a geography, a qualifying signal) instead of a topic to browse.
 */
const quickPrompts: { label: string; goal: string }[] = [
  { label: "Find clients", goal: "Find growth-stage climate companies in Lagos that need a product-design partner." },
  { label: "Find talent", goal: "Find a video editor who can turn our launch demos into five short films." },
  { label: "Find a solution", goal: "Find firms that run SOC 2 readiness audits for a 40-person startup." },
  { label: "Find customers", goal: "Find US veterinary clinics that could use my scheduling software." },
];

const themeOptions: { value: ThemeChoice; label: string; glyph: string }[] = [
  { value: "system", label: "System", glyph: "◐" },
  { value: "light", label: "Light", glyph: "☀" },
  { value: "dark", label: "Dark", glyph: "☾" },
];

function shortDate(value: number) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function hostLabel(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

/**
 * Auth gate.
 *
 * This is deliberately a thin wrapper. React requires the same hooks on every
 * render, and the workspace shell below calls a large number of them; gating
 * inside that shell would render it with fewer hooks while identity loads.
 */
export default function App({ backendConnected }: { backendConnected: boolean }) {
  const user = useQuery(api.users.current);
  if (user === undefined) return <AuthSplash label="Checking your session…" />;
  if (!user) return <SignIn />;
  return <WorkspaceApp backendConnected={backendConnected} />;
}

function AuthSplash({ label }: { label: string }) {
  return (
    <div className="auth-page" role="status" aria-live="polite">
      <div className="auth-card auth-splash">
        <div className="brand-mark">↗</div>
        <p className="eyebrow">PROSPECT RADAR</p>
        <p className="stage-note">{label}</p>
      </div>
    </div>
  );
}

function WorkspaceApp({ backendConnected }: { backendConnected: boolean }) {
  const { signOut } = useAuthActions();
  const user = useQuery(api.users.current);
  const workspace = useQuery(api.users.workspace);
  const provisionWorkspace = useMutation(api.users.provisionWorkspace);

  // Auto-provision workspace on first login
  useEffect(() => {
    if (user && workspace === null) {
      provisionWorkspace().catch(() => {});
    }
  }, [user, workspace, provisionWorkspace]);

  const workspaceId: string = workspace?._id ?? "";

  const missions = useQuery(api.missions.list, backendConnected && workspaceId ? { workspaceId } : "skip");
  const createMission = useMutation(api.missions.create);
  const scrapeSource = useAction(api.research.scrape);
  const sendMessage = useAction(api.outreach.send);
  const syncOutbound = useAction(api.outreach.syncOutbound);
  const provisionInbox = useAction(api.outreach.provisionInbox);
  const approveDraft = useMutation(api.outreachStore.approve);
  const updateOutcome = useMutation(api.outcomes.updateStatus);
  const snoozeFollowUp = useMutation(api.relationships.snoozeFollowUp);
  const completeFollowUp = useMutation(api.relationships.completeFollowUp);
  const setOutcomeStage = useMutation(api.relationships.setStage);
  const recordMeeting = useMutation(api.relationships.recordMeeting);
  const runPipeline = useMutation(api.orchestratorStore.runPipeline);
  const stopRun = useMutation(api.orchestratorStore.stopRun);
  const retryRunStage = useMutation(api.orchestratorStore.retryStage);
  const approvePlan = useMutation(api.orchestratorStore.approvePlan);
  const continueAfterCheckIn = useMutation(api.orchestratorStore.continueAfterCheckIn);
  const answerClarification = useMutation(api.orchestratorStore.answerClarification);
  const answerContextCheck = useMutation(api.orchestratorStore.answerContextCheck);

  const [activeView, setActiveView] = useState<View>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { choice: themeChoice, setTheme } = useTheme();

  const [goal, setGoal] = useState("Find growth-stage climate companies in Lagos that need a product-design partner.");
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [contextCheckAnswer, setContextCheckAnswer] = useState("");
  const [contextCheckKey, setContextCheckKey] = useState("");
  // Which competing value the user picked for a conflicting requirement.
  const [conflictChoice, setConflictChoice] = useState<Record<string, string>>({});
  const [contextArtifactUploading, setContextArtifactUploading] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [showMissionHistory, setShowMissionHistory] = useState(false);
  /** Which mission's run trail the Activity page is inspecting. */
  const [activityMissionId, setActivityMissionId] = useState<string | null>(null);

  const [planning, setPlanning] = useState(false);
  const [planNotice, setPlanNotice] = useState("");

  const [researchNotice, setResearchNotice] = useState("");

  const [outreachNotice, setOutreachNotice] = useState("");
  const [sendingActionId, setSendingActionId] = useState<Id<"actionDrafts"> | null>(null);
  const [provisioning, setProvisioning] = useState(false);

  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [factCategory, setFactCategory] = useState("");
  const [factValue, setFactValue] = useState("");
  const [editingFactId, setEditingFactId] = useState<Id<"contextFacts"> | null>(null);
  const [factEditValue, setFactEditValue] = useState("");
  const [approvalNotice, setApprovalNotice] = useState("");
  const [pipelineNotice, setPipelineNotice] = useState("");
  // One inline meeting form at a time, opened from a relationship row. This is
  // the user reporting an off-platform event, not operating the workflow.
  const [meetingDraft, setMeetingDraft] = useState<{
    outcomeId: string; matchId: string | null; counterpart: string; scheduledAt: string; notes: string;
  } | null>(null);
  const [formSourceId, setFormSourceId] = useState("");
  const [formNotice, setFormNotice] = useState("");
  const [scouting, setScouting] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [submittingProposalId, setSubmittingProposalId] = useState<Id<"formProposals"> | null>(null);
  const [proposalEdits, setProposalEdits] = useState<Record<string, Record<string, string>>>({});
  const [commandTerm, setCommandTerm] = useState("");
  const [briefEditing, setBriefEditing] = useState(false);
  const [briefNotice, setBriefNotice] = useState("");
  const [briefDraft, setBriefDraft] = useState({ normalizedGoal: "", mustHave: "", niceToHave: "", exclusions: "", recommendedSources: "", completionPredicate: "" });
  // What "done" means for this mission. Empty means "untouched", so the control
  // shows the plan's own objective until the user changes it.
  const [objectiveKind, setObjectiveKind] = useState("");
  const [objectiveCount, setObjectiveCount] = useState(1);
  const [objectiveNotice, setObjectiveNotice] = useState("");
  // The provider-credit intervention. Deliberately not a standing dashboard
  // control: it renders only when the run actually paused for budget, because
  // the agent state then says "raise the cap" and the user needs a way to.
  const [budgetLimitDraft, setBudgetLimitDraft] = useState("");
  const [budgetNotice, setBudgetNotice] = useState("");
  // Correcting the objective is not operating the workflow: Radar re-reads the
  // goal and rebuilds the plan, and everything else about the mission stays put.
  const [goalEditing, setGoalEditing] = useState(false);
  const [goalDraft, setGoalDraft] = useState("");
  const [goalNotice, setGoalNotice] = useState("");

  // Discover is an evidence graph, not a search console: a match is the entry
  // point, and each one drills into the page it was read from, the entity on
  // that page, and the decision Radar reached. The lens picks the entry node.
  const [discoverLens, setDiscoverLens] = useState<"matches" | "sources" | "entities">("matches");
  const [discoverFocus, setDiscoverFocus] = useState<{ kind: "source" | "entity"; id: string; label: string } | null>(null);
  const [expandedMatchId, setExpandedMatchId] = useState<string | null>(null);

  const [sourceTab, setSourceTab] = useState<"file" | "website" | "snippet">("file");
  const [outcomesTab, setOutcomesTab] = useState<"results" | "relationships" | "pipeline">("results");
  const [fileDrag, setFileDrag] = useState(false);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [addingWebsite, setAddingWebsite] = useState(false);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [websiteTitle, setWebsiteTitle] = useState("");
  const [websiteMode, setWebsiteMode] = useState<"single" | "crawl" | "sitemap">("single");
  const [websitePageLimit, setWebsitePageLimit] = useState(5);
  const [websiteInclude, setWebsiteInclude] = useState("");
  const [websiteExclude, setWebsiteExclude] = useState("");
  const [websiteNotice, setWebsiteNotice] = useState("");
  const [addingSnippet, setAddingSnippet] = useState(false);
  const [snippetTitle, setSnippetTitle] = useState("");
  const [snippetText, setSnippetText] = useState("");
  const [snippetNotice, setSnippetNotice] = useState("");
  const [resyncingId, setResyncingId] = useState<Id<"dataSources"> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedMission = missions?.find((mission) => mission._id === selectedMissionId) ?? missions?.[0];
  const missionId = selectedMission?._id ?? null;

  const plan = useQuery(api.plans.getForMission, backendConnected && missionId ? { missionId } : "skip");
  const run = useQuery(api.runs.forMission, backendConnected && missionId ? { missionId } : "skip");
  const runSteps = useQuery(api.runs.steps, backendConnected && run ? { runId: run._id } : "skip");
  const jobs = useQuery(api.researchStore.listJobs, backendConnected && missionId ? { missionId } : "skip");
  const sources = useQuery(api.researchStore.listSources, backendConnected && missionId ? { missionId } : "skip");
  const matches = useQuery(api.researchStore.listMatches, backendConnected && missionId ? { missionId } : "skip");
  // Radar's own record of what it chose to do about each match, and why. The
  // UI renders the agent's decision rather than asking the user to make it.
  const decisions = useQuery(api.actionStore.decisions, backendConnected && workspaceId && missionId ? { workspaceId, missionId } : "skip");
  const entities = useQuery(api.entityStore.listForMission, backendConnected && missionId ? { missionId } : "skip");
  const missionSignals = useQuery(api.entityStore.listSignalsForMission, backendConnected && missionId ? { missionId } : "skip");
  const inbox = useQuery(api.outreachStore.getInbox, backendConnected && workspaceId ? { workspaceId } : "skip");
  // The same registry the decision layer reads, resolved against this
  // workspace and mission — so the app never offers an action Radar cannot do.
  const capabilities = useQuery(
    api.capabilities.list,
    backendConnected && workspaceId ? { workspaceId, missionId: missionId ?? undefined } : "skip",
  );
  const drafts = useQuery(api.outreachStore.listDrafts, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const threads = useQuery(api.inbox.listThreads, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const threadMessages = useQuery(api.inbox.listMessages, backendConnected && selectedThreadId ? { workspaceId, threadId: selectedThreadId } : "skip");
  const classifications = useQuery(api.outreachStore.listClassifications, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const readiness = useQuery(api.contextCheckQuery.readiness, backendConnected && missionId && run?.status === "waiting" && run.currentStage === "context_check" ? { missionId } : "skip");
  // Outcomes is a workspace-level question ("what actually happened"), so it
  // reads every relationship rather than only the selected mission's.
  const workspaceOutcomes = useQuery(api.outcomes.listForWorkspace, backendConnected && workspaceId ? { workspaceId } : "skip");
  const followUps = useQuery(api.relationships.followUpsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const sequences = useQuery(api.relationships.sequencesForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  // Meetings are relationship state, not a destination of their own: they are
  // rendered inside each relationship rather than given a page.
  const meetings = useQuery(api.relationships.meetingsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formTemplates = useQuery(api.formStore.listTemplates, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formProposals = useQuery(api.formStore.listProposals, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formSubmissions = useQuery(api.formStore.listSubmissions, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formCap = useQuery(api.formStore.capStatus, backendConnected && workspaceId ? { workspaceId } : "skip");
  const scoutForm = useAction(api.formFlows.scoutForm);
  const proposeFill = useAction(api.formFlows.proposeFill);
  const approveProposal = useMutation(api.formStore.approveProposal);
  const reviseProposalValues = useMutation(api.formStore.reviseProposalValues);
  const executeFormSubmission = useAction(api.formFlows.executeFormSubmission);
  // Only read while a mission is selected: the intervention is mission context.
  const budgetStatus = useQuery(api.budget.status, backendConnected && workspaceId ? { workspaceId, missionId } : "skip");
  const contextFacts = useQuery(api.context.list, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const board = useQuery(api.commandCenter.runsBoard, backendConnected && workspaceId ? { workspaceId } : "skip");
  // Activity page: the run trail for whichever mission the user is inspecting.
  // These are durable runEvents/runSteps, so the trail rebuilds on refresh.
  const activityRun = useQuery(api.runs.forMission, backendConnected && activityMissionId ? { missionId: activityMissionId as Id<"missions"> } : "skip");
  const activityEvents = useQuery(api.runs.events, backendConnected && activityRun ? { runId: activityRun._id } : "skip");
  const activitySteps = useQuery(api.runs.steps, backendConnected && activityRun ? { runId: activityRun._id } : "skip");
  const dataSources = useQuery(api.dataSources.list, backendConnected && workspaceId ? { workspaceId } : "skip");
  const addSnippet = useMutation(api.dataSources.addSnippet);
  const removeSource = useMutation(api.dataSources.deleteSource);
  const resyncSource = useAction(api.dataFlows.resyncSource);
  const overview = useQuery(api.commandCenter.overview, backendConnected && workspaceId ? { workspaceId } : "skip");
  const searchResults = useQuery(
    api.commandCenter.search,
    backendConnected && commandTerm.trim().length >= 2 ? { workspaceId, query: commandTerm.trim() } : "skip",
  );
  const addFileSource = useMutation(api.dataSources.addFile);
  const fileReady = useMutation(api.dataSources.fileReady);
  const addWebsiteSource = useMutation(api.dataSources.addWebsite);
  const addFact = useMutation(api.context.add);
  const confirmFact = useMutation(api.context.confirm);
  const correctFact = useMutation(api.context.correct);
  const rejectFact = useMutation(api.context.reject);
  const deleteFact = useMutation(api.context.deleteFact);
  const setThreadLabel = useMutation(api.inbox.setLabel);
  const updateBrief = useMutation(api.plans.updateBrief);
  const setObjective = useMutation(api.plans.setObjective);
  const setBudgetLimit = useMutation(api.budget.setLimit);
  const reviseGoal = useMutation(api.missions.reviseGoal);
  const interpretMission = useAction(api.ai.interpretMission);
  const setRepresentationAllowed = useMutation(api.dataSources.setRepresentationAllowed);

  // Capability state, read from the registry rather than guessed at the button.
  // While the query has not answered, buttons stay enabled: an unanswered
  // question about availability is not evidence that something is unavailable.
  const capability = (key: string) => (capabilities ?? []).find((entry) => entry.key === key) ?? null;
  const emailCapability = capability("send_email");
  const formCapability = capability("submit_form");
  const investigateCapability = capability("investigate");
  const blockerFor = (entry: ReturnType<typeof capability>) => (entry && !entry.available ? entry.unavailableReason ?? entry.label : null);
  const emailBlocker = blockerFor(emailCapability);

  const latestJob = jobs?.[0];
  const actionableDrafts = (drafts ?? []).filter((draft) => ["draft", "awaiting_approval", "approved", "executing"].includes(draft.status));
  const dueFollowUps = (followUps ?? []).filter((item) => item.status === "due" || item.dueAt <= Date.now());
  const followUpForOutcome = (outcomeId: Id<"outcomes">) => (followUps ?? []).find((item) => item.outcomeId === outcomeId);
  const meetingsForOutcome = (outcomeId: Id<"outcomes">) => (meetings ?? []).filter((item) => item.outcomeId === outcomeId);

  const pendingFormWork = (formProposals ?? []).filter((proposal) => proposal.status === "draft" || proposal.status === "approved" || proposal.status === "blocked" || proposal.status === "failed").length;

  // The approval gate.
  //
  // The orchestrator parks every mission at `approval/waiting` and never creates
  // a draft, so "waiting for you" was previously a dead end: the gate rendered a
  // CTA only when a draft already existed, which could not happen on its own.
  // The card below now always says what the next step is and, when the user has
  // one, offers the click that produces the thing they are there to approve.
  const atApprovalGate = run?.status === "waiting" && run.currentStage === "approval";
  const draftsOnGate = (drafts ?? []).filter((draft) => ["awaiting_approval", "approved"].includes(draft.status));
  // The decision Radar reached about each match. One row per match, so a card
  // can state "why it acted" or "why it chose nothing" without a second guess.
  const decisionFor = (matchId: Id<"matches">) => (decisions ?? []).find((entry) => entry.matchId === matchId) ?? null;
  // Evidence-graph traversal: match → source → entity → decision. Every edge is
  // a persisted id, so the graph is the same on reload as it was while running.
  const sourceById = (sourceId: string) => (sources ?? []).find((item) => item._id === sourceId) ?? null;
  const matchesForSource = (sourceId: string) => (matches ?? []).filter((item) => item.sourceId === sourceId);
  const matchesForEntity = (entityId: string) => (matches ?? []).filter((item) => item.entity?._id === entityId);
  const signalsForEntity = (entityId: string) => (missionSignals ?? []).filter((item) => item.entityId === entityId);
  const SOURCE_TYPE_LABELS: Record<string, string> = {
    search_result: "search",
    scraped_page: "scraped",
    crawled_page: "crawled",
    mapped_site: "site map",
  };
  // The graph's honest edges: an entity that resolved but was never matched, and
  // a page that was fetched but produced no match, both stay visible.
  const unmatchedEntities = (entities ?? []).filter((entity) => matchesForEntity(entity._id).length === 0);
  const matchedSourceIds = new Set((matches ?? []).map((item) => item.sourceId));
  const unmatchedSources = (sources ?? []).filter((source) => !matchedSourceIds.has(source._id));
  const DECISION_LABELS: Record<string, string> = {
    send_email: "Outreach proposed",
    submit_form: "Form submission prepared",
    investigate: "Researching further",
    no_action: "No action",
  };
  // The most recent decision that actually proposed something; used by the gate
  // to say what Radar decided when the list of approvable drafts is empty.
  const latestDecision = (() => {
    const rows = decisions ?? [];
    if (rows.length === 0) return null;
    return rows.slice().sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  })();

  // A budget block is a spend decision, not a failure: the run keeps its stage.
  const budgetBlocked = run?.activeInterruption === "budget_blocked";

  // The one-line answer to "what is Radar doing right now?", rendered on every
  // page so the agent's state reads at a glance wherever the user is standing.
  // It is derived from the persisted run, never animated or invented.
  const agentState = (() => {
    if (!selectedMission) return null;
    const stageLabels: Record<string, string> = {
      intake: "Reading your goal",
      interpret: "Understanding your goal",
      context_check: "Checking what it knows",
      plan: "Planning the search",
      plan_review: "Your plan is ready to review",
      discover: "Researching sources",
      check_in: "Paused for your review",
      evaluate: "Evaluating what it found",
      approval: "Waiting for your approval",
      execute: "Executing approved actions",
      observe: "Observing what happened",
      wait: "Waiting on the outside world",
      complete: "Mission complete",
    };
    if (!run) return { tone: "muted", glyph: "○", label: "No run yet", detail: "Radar starts the moment the mission exists." };
    const label = stageLabels[run.currentStage] ?? run.currentStage;
    if (run.status === "queued" || run.status === "active") {
      return { tone: "working", glyph: "●", label, detail: "Radar is working in the background — you can leave. It waits until your attention is needed." };
    }
    if (run.status === "waiting") {
      const isApproval = run.currentStage === "approval";
      return {
        tone: "waiting",
        glyph: "◐",
        label,
        detail: isApproval
          ? draftsOnGate.length > 0
            ? `${draftsOnGate.length} action${draftsOnGate.length === 1 ? "" : "s"} ready — approve the exact content and Radar sends it.`
            : "Radar opened the gate with nothing to send; it did not invent a contact route."
          : "Radar stopped because it needs something only you can give it.",
      };
    }
    if (run.status === "complete") return { tone: "done", glyph: "✓", label, detail: "Radar reached its objective — the outcome is recorded." };
    if (run.status === "blocked") {
      return { tone: "blocked", glyph: "■", label, detail: budgetBlocked ? "Paused for budget, not broken — raise the cap, then resume." : "Paused after a provider failure — retry when conditions change." };
    }
    if (run.status === "failed") return { tone: "blocked", glyph: "✗", label, detail: "The run failed. Activity holds the recorded reason." };
    return { tone: "muted", glyph: "○", label, detail: "You stopped this mission." };
  })();

  const navCounts: Record<View, number | null> = {
    home: null,
    discover: matches?.length ?? null,
    actions: actionableDrafts.length + pendingFormWork || null,
    inbox: threads?.length || null,
    outcomes: (workspaceOutcomes ?? []).filter((outcome) => !["won", "lost"].includes(outcome.stage)).length || null,
    profile: (contextFacts ?? []).filter((f) => f.verificationStatus === "unreviewed").length || null,
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
        view: "actions",
      });
    }
    if (plan && plan.missingFacts.length > 0) {
      items.push({ id: "facts", title: `${plan.missingFacts.length} missing fact${plan.missingFacts.length === 1 ? "" : "s"} could change the search`, detail: plan.missingFacts[0], tone: "cyan", view: "discover" });
    }
    const freshReplies = (threads ?? []).filter((thread) => thread.labels.includes("replied")).length;
    if (freshReplies > 0) {
      items.push({ id: "replies", title: `${freshReplies} inbound repl${freshReplies === 1 ? "y" : "ies"} waiting for review`, detail: "Classifications and suggested next steps are ready in the inbox.", tone: "cyan", view: "inbox" });
    }
    if (dueFollowUps.length > 0) {
      items.push({ id: "followups", title: `${dueFollowUps.length} follow-up${dueFollowUps.length === 1 ? "" : "s"} due`, detail: dueFollowUps[0].note, tone: "amber", view: "outcomes" });
    }
    const queuedSteps = (sequences ?? []).flatMap((sequence) => sequence.steps).filter((step) => step.status === "draft_ready").length;
    if (queuedSteps > 0) {
      items.push({ id: "sequence", title: `${queuedSteps} sequence step${queuedSteps === 1 ? "" : "s"} drafted and awaiting approval`, detail: "A step is queued as a draft. Approving it is the only way it sends.", tone: "amber", view: "actions" });
    }
    return items;
  }, [actionableDrafts, plan, threads, dueFollowUps, sequences]);

  function selectView(view: View) {
    setActiveView(view);
    setMobileNavOpen(false);
  }

  // Scroll to the active mission panel when a new mission is created.
  useEffect(() => {
    if (activeView !== "home" || !selectedMissionId) return;
    const el = document.getElementById("active-mission");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedMissionId, activeView]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !backendConnected || !workspaceId) return;
    const requested = goal.trim();
    setSubmitting(true);
    setNotice("");
    try {
      const result = await Promise.race([
        createMission({ workspaceId, title: requested.slice(0, 80), rawGoal: requested, constraints: [], sourceScope: "public-web", completionPredicate: "A user-approved next action exists for at least one sourced match." }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Convex is not responding — check your connection. Your request is kept below; press Run Radar again.")), 10000)),
      ]);
      setSelectedMissionId(result.missionId);
      setClarifyAnswer("");
      setGoal("");
      // Start the durable run without blocking the UI on it.
      runPipeline({ workspaceId, missionId: result.missionId }).catch(() => {
        setNotice("The run did not start automatically — open Dashboard and press ▶ Run Radar end-to-end.");
      });
    } catch (error) {
      setGoal(requested);
      setNotice(error instanceof Error ? error.message : "Mission creation failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function onStopRun() {
    if (!missionId) return;
    try {
      await stopRun({ workspaceId, missionId });
      setPlanNotice("Mission stopped. No further stages will execute.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Could not stop the run.");
    }
  }

  async function onRetryStage() {
    if (!missionId) return;
    try {
      await retryRunStage({ workspaceId, missionId });
      setPlanNotice("Resuming the blocked stage.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Could not resume the run.");
    }
  }

  /**
   * Answer a clarification.
   *
   * One mutation rather than two calls: the answer becomes a confirmed context
   * fact, the run is re-scheduled, and Radar continues on its own. Appending the
   * text to the goal and calling the classifier from here left the run active
   * with nothing scheduled — it looked busy and was actually stalled.
   */
  async function onClarifySubmit() {
    if (!missionId || !clarifyAnswer.trim()) return;
    setPlanning(true);
    try {
      await answerClarification({ workspaceId, missionId, answer: clarifyAnswer.trim() });
      setClarifyAnswer("");
      setPlanNotice("Answer saved to your context — Radar is continuing.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Clarification failed.");
    } finally { setPlanning(false); }
  }

  async function onContextCheckSubmit(key: string, options?: { answer?: string; supersedes?: Id<"contextFacts">[] }) {
    if (!missionId) return;
    const raw = options?.answer ?? (contextCheckKey === key ? contextCheckAnswer : "");
    const answer = raw.trim();
    if (!answer) return;
    setPlanning(true);
    try {
      await answerContextCheck({ workspaceId, missionId, key, answer, supersedes: options?.supersedes });
      setContextCheckAnswer("");
      setContextCheckKey("");
      setConflictChoice({});
      setPlanNotice("Answer saved — Radar is re-checking its readiness.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Failed to save answer.");
    } finally { setPlanning(false); }
  }

  /**
   * Attaches a file as evidence for a requirement that wants an artifact rather
   * than a sentence (a portfolio, a product page, case studies). The source is
   * ingested and chunked before the mission re-checks readiness, so the new
   * evidence is visible to the very next pass.
   */
  async function onContextArtifactUpload(key: string, file: File | null) {
    if (!file || !backendConnected || !missionId) return;
    setContextArtifactUploading(key);
    setPlanNotice("");
    try {
      const { sourceId, uploadUrl } = await addFileSource({ workspaceId, title: file.name, sizeBytes: file.size });
      const response = await fetch(uploadUrl, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      const { storageId } = (await response.json()) as { storageId: string };
      await fileReady({ workspaceId, sourceId, storageId: storageId as Id<"_storage"> });
      await answerContextCheck({ workspaceId, missionId, key, sourceAdded: true });
      setPlanNotice(`${file.name} attached — Radar is re-checking its readiness.`);
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally { setContextArtifactUploading(""); }
  }

  async function onApprovePlan() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try {
      await approvePlan({ workspaceId, missionId });
      setPlanNotice("Plan approved — Radar is searching.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Could not approve plan.");
    } finally { setPlanning(false); }
  }

  // Retained for a deliberately paused mission: `check_in` is off the default
  // path (discovery flows straight to evaluation), so this is a resume, not a
  // workflow step the normal user has to press.
  async function onContinueAfterCheckIn() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try {
      await continueAfterCheckIn({ workspaceId, missionId });
      setPlanNotice("Continuing to evaluation.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Could not continue.");
    } finally { setPlanning(false); }
  }

  function startBriefEdit() {
    if (!plan) return;
    setBriefDraft({
      normalizedGoal: plan.normalizedGoal,
      mustHave: plan.mustHave.join(", "),
      niceToHave: plan.niceToHave.join(", "),
      exclusions: plan.exclusions.join(", "),
      recommendedSources: plan.recommendedSources.join(", "),
      completionPredicate: plan.completionPredicate,
    });
    setBriefEditing(true);
    setBriefNotice("");
  }

  async function onSaveBrief() {
    if (!missionId) return;
    const split = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
    try {
      await updateBrief({
        workspaceId,
        missionId,
        normalizedGoal: briefDraft.normalizedGoal,
        mustHave: split(briefDraft.mustHave),
        niceToHave: split(briefDraft.niceToHave),
        exclusions: split(briefDraft.exclusions),
        recommendedSources: split(briefDraft.recommendedSources),
        completionPredicate: briefDraft.completionPredicate,
      });
      setBriefEditing(false);
      setBriefNotice("Brief saved — the run's completion gate now uses your predicate.");
    } catch (error) {
      setBriefNotice(error instanceof Error ? error.message : "Could not save the brief.");
    }
  }

  /**
   * Sets what finished means for this mission.
   *
   * The planner reads an objective off the user's request; this is how the user
   * corrects it — "give me ten of them" or "I want a reply, not a list" — and
   * both the action layer and the completion gate read it back from the plan.
   */
  async function onSetObjective() {
    if (!missionId || !plan) return;
    const kind = (objectiveKind || plan.successKind || "contact_and_wait") as
      | "contact_and_wait"
      | "find_candidates"
      | "present_solution";
    const count = Math.max(1, Math.min(Math.floor(objectiveCount || 1), 100));
    setObjectiveNotice("");
    try {
      await setObjective({ workspaceId, missionId, successKind: kind, targetCount: count });
      setObjectiveNotice(
        kind === "contact_and_wait"
          ? `Understood: contact ${count} and wait for a reply.`
          : kind === "present_solution"
            ? `Understood: present ${count} credible solution${count === 1 ? "" : "s"}.`
            : `Understood: assemble ${count} qualified candidate${count === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setObjectiveNotice(error instanceof Error ? error.message : "Could not set the objective.");
    }
  }

  /**
   * Raise the research cap so a budget-paused mission can continue.
   *
   * The agent state tells the user to raise the cap when the run pauses for
   * budget; without this the instruction named an action the UI did not offer.
   */
  async function onRaiseBudgetLimit() {
    const value = Number(budgetLimitDraft);
    if (budgetLimitDraft.trim() === "" || !Number.isFinite(value)) {
      setBudgetNotice("Enter a whole number of credits.");
      return;
    }
    setBudgetNotice("");
    try {
      const result = await setBudgetLimit({ workspaceId, creditLimit: Math.floor(value) });
      setBudgetNotice(`Research budget raised to ${result.creditLimit} credits. Radar can continue.`);
      setBudgetLimitDraft("");
    } catch (error) {
      setBudgetNotice(error instanceof Error ? error.message : "Could not raise the research budget.");
    }
  }

  /**
   * Correct the objective Radar was given.
   *
   * `reviseGoal` deliberately clears the stored intent, so the follow-up
   * `interpretMission` re-reads the mission and rebuilds the plan. This is the
   * user fixing the objective, not driving the workflow: no stage is advanced
   * by hand and the agent decides everything downstream from here.
   */
  async function onCorrectGoal() {
    if (!missionId) return;
    const next = goalDraft.trim();
    if (!next) return;
    if (next === (selectedMission?.rawGoal ?? "")) {
      setGoalNotice("That is the goal Radar already has.");
      return;
    }
    setPlanning(true); setGoalNotice("");
    try {
      await reviseGoal({ workspaceId, missionId, rawGoal: next });
      await interpretMission({ missionId });
      setGoalEditing(false);
      setGoalNotice("Goal corrected — Radar re-read the objective and rebuilt the plan.");
      if (run?.status === "queued") {
        try { await runPipeline({ workspaceId, missionId }); } catch { /* the plan gate still shows it */ }
      }
    } catch (error) {
      setGoalNotice(error instanceof Error ? error.message : "Could not correct the goal.");
    } finally { setPlanning(false); }
  }

  async function onToggleRepresentation(sourceId: Id<"dataSources">, allowed: boolean) {
    try {
      await setRepresentationAllowed({ workspaceId, sourceId, allowed });
      setSnippetNotice(
        allowed
          ? "Radar may now attach this document to messages it proposes. You still approve each exact message."
          : "Radar will no longer attach this document to anything it proposes.",
      );
    } catch (error) {
      setSnippetNotice(error instanceof Error ? error.message : "Could not change that.");
    }
  }

  function openSearchResult(result: { missionId: string | null; view: View }) {
    if (result.missionId) setSelectedMissionId(result.missionId);
    selectView(result.view);
    setCommandTerm("");
  }

  async function onAddSnippet() {
    if (!snippetTitle.trim() || snippetText.trim().length < 10) {
      setSnippetNotice("Give the snippet a title and at least 10 characters of text.");
      return;
    }
    setAddingSnippet(true); setSnippetNotice("");
    try {
      await addSnippet({ workspaceId, title: snippetTitle.trim(), text: snippetText });
      setSnippetTitle(""); setSnippetText("");
      setSnippetNotice("Snippet saved — it is searchable now and will surface in relevant missions.");
    } catch (error) {
      setSnippetNotice(error instanceof Error ? error.message : "Could not save the snippet.");
    } finally { setAddingSnippet(false); }
  }

  async function onUploadFile(files: FileList | null) {
    const file = files?.[0];
    if (!file || !backendConnected) return;
    setUploadingFile(true); setSnippetNotice("");
    try {
      const { sourceId, uploadUrl } = await addFileSource({ workspaceId, title: file.name, sizeBytes: file.size });
      const response = await fetch(uploadUrl, { method: "POST", body: file, headers: { "Content-Type": file.type || "application/octet-stream" } });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      const { storageId } = (await response.json()) as { storageId: string };
      const { chunkCount } = await fileReady({ workspaceId, sourceId, storageId: storageId as Id<"_storage"> });
      setSnippetNotice(`${file.name} added — ${chunkCount} searchable chunk${chunkCount === 1 ? "" : "s"}.`);
    } catch (error) {
      setSnippetNotice(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setUploadingFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onAddWebsite() {
    if (!websiteUrl.trim()) return;
    setAddingWebsite(true); setWebsiteNotice("");
    try {
      const result = await addWebsiteSource({
        workspaceId,
        title: websiteTitle.trim() || new URL(websiteUrl.trim()).hostname,
        url: websiteUrl.trim(),
        crawlMode: websiteMode,
        includePaths: websiteInclude.trim() ? [websiteInclude.trim()] : undefined,
        excludePaths: websiteExclude.trim() ? [websiteExclude.trim()] : undefined,
        pageLimit: websiteMode === "crawl" ? websitePageLimit : undefined,
      });
      setWebsiteUrl(""); setWebsiteTitle(""); setWebsiteInclude(""); setWebsiteExclude("");
      setWebsiteNotice(result.started
        ? "Firecrawl is fetching the site now — chunks land automatically."
        : "Website registered; the crawl was already running or queued.");
    } catch (error) {
      setWebsiteNotice(error instanceof Error ? error.message : "Could not add the website.");
    } finally { setAddingWebsite(false); }
  }

  async function onResync(sourceId: Id<"dataSources">) {
    setResyncingId(sourceId);
    try { await resyncSource({ workspaceId, sourceId }); }
    catch { setWebsiteNotice("Resync failed — try again in a moment."); }
    finally { setResyncingId(null); }
  }

  async function onRemoveSource(sourceId: Id<"dataSources">, title: string) {
    if (!window.confirm(`Remove "${title}"? Missions will stop retrieving from it.`)) return;
    try { await removeSource({ workspaceId, sourceId }); }
    catch (error) { setSnippetNotice(error instanceof Error ? error.message : "Could not remove the source."); }
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

  /**
   * Create the workspace's sending inbox.
   *
   * Shared by the Actions page and the approval gate, so it returns its message
   * instead of writing to a notice: provisioning can fail (AgentMail caps the
   * account's inboxes), and a failure the user cannot see is worse than no
   * button at all. `clientRequestId` is derived from the workspace, so a second
   * click returns the existing inbox rather than creating another one.
   */
  async function provisionSendingInbox(): Promise<string> {
    const result = await provisionInbox({ workspaceId, clientRequestId: `inbox-${workspaceId}`, displayName: "Prospect Radar" });
    return `AgentMail inbox ready: ${result.email}`;
  }

  async function onProvisionInbox() {
    setProvisioning(true); setOutreachNotice("");
    try {
      setOutreachNotice(await provisionSendingInbox());
    } catch (error) {
      setOutreachNotice(error instanceof Error ? error.message : "AgentMail inbox provisioning failed.");
    } finally { setProvisioning(false); }
  }

  /** The gate's inline path: provision without sending the user to another page. */
  async function onProvisionInboxFromGate() {
    setProvisioning(true); setApprovalNotice("");
    try {
      setApprovalNotice(await provisionSendingInbox());
    } catch (error) {
      setApprovalNotice(error instanceof Error ? error.message : "AgentMail inbox provisioning failed.");
    } finally { setProvisioning(false); }
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

  async function onAdvanceStage(outcomeId: Id<"outcomes">, stage: PipelineStageName, nextAction: string) {
    setPipelineNotice("");
    try { await setOutcomeStage({ workspaceId, outcomeId, stage, nextAction }); setPipelineNotice(`Stage set to ${PIPELINE_LABELS[stage].toLowerCase()}.`); }
    catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not update the stage."); }
  }

  async function onSnoozeFollowUp(followUpId: Id<"followUps">, days: number) {
    setPipelineNotice("");
    try {
      await snoozeFollowUp({ workspaceId, followUpId, dueAt: Date.now() + days * 24 * 60 * 60 * 1000 });
      setPipelineNotice(`Follow-up snoozed ${days} day${days === 1 ? "" : "s"}.`);
    } catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not snooze the follow-up."); }
  }

  async function onCompleteFollowUp(followUpId: Id<"followUps">) {
    setPipelineNotice("");
    try { await completeFollowUp({ workspaceId, followUpId }); setPipelineNotice("Follow-up marked done."); }
    catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not complete the follow-up."); }
  }

  /**
   * Recording a meeting is the user reporting something Radar cannot observe:
   * a conversation that happened off-platform. It advances the relationship
   * stage to `meeting`, so it is state the agent then reasons from.
   */
  async function onRecordMeeting() {
    if (!missionId || !meetingDraft) return;
    setPipelineNotice("");
    const scheduledAt = Date.parse(meetingDraft.scheduledAt);
    if (!Number.isFinite(scheduledAt)) { setPipelineNotice("Pick a date for the meeting."); return; }
    try {
      await recordMeeting({
        workspaceId,
        missionId,
        outcomeId: meetingDraft.outcomeId as Id<"outcomes">,
        matchId: meetingDraft.matchId ? (meetingDraft.matchId as Id<"matches">) : null,
        counterpart: meetingDraft.counterpart,
        scheduledAt,
        notes: meetingDraft.notes,
      });
      setPipelineNotice(`Meeting with ${meetingDraft.counterpart} recorded — stage is now meeting.`);
      setMeetingDraft(null);
    } catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not record the meeting."); }
  }

  async function onScoutForm() {
    if (!missionId || !formSourceId) { setFormNotice("Choose a discovered source to scout first."); return; }
    setScouting(true); setFormNotice("");
    try {
      const result = await scoutForm({ workspaceId, missionId, sourceId: formSourceId as Id<"sourceRecords"> });
      setFormNotice(result.blockedReason
        ? `Radar stopped at this form: ${result.blockedDetail}`
        : `Scouted ${result.fieldCount} field${result.fieldCount === 1 ? "" : "s"} on ${hostLabel(result.url)}.`);
      setFormSourceId("");
    } catch (error) {
      setFormNotice(error instanceof Error ? error.message : "Form scout failed.");
    } finally { setScouting(false); }
  }

  async function onProposeFill(templateId: Id<"formTemplates">) {
    if (!missionId) return;
    setProposing(true); setFormNotice("");
    try {
      const result = await proposeFill({ workspaceId, missionId, templateId });
      setFormNotice(result.unmatchedRequired.length > 0
        ? `Proposed ${result.filled} value(s). ${result.unmatchedRequired.length} required field(s) still need a confirmed fact: ${result.unmatchedRequired.join(", ")}.`
        : `Proposed ${result.filled} value(s) from your confirmed facts. Review the payload, then approve.`);
    } catch (error) {
      setFormNotice(error instanceof Error ? error.message : "Fill proposal failed.");
    } finally { setProposing(false); }
  }

  async function onSaveProposalValues(proposal: { _id: Id<"formProposals">; fieldValues: Array<{ name: string; factId: Id<"contextFacts"> | null }> }) {
    const edits = proposalEdits[proposal._id] ?? {};
    const confirmed = (contextFacts ?? []).filter((fact) => ["user_confirmed", "user_corrected"].includes(fact.verificationStatus));
    const fieldValues = proposal.fieldValues.map((field) => {
      const edited = edits[field.name];
      const factId = edited !== undefined ? (edited || null) : field.factId;
      const fact = confirmed.find((candidate) => candidate._id === factId);
      return { name: field.name, value: fact?.value ?? "", factId: fact?._id ?? null };
    });
    return await reviseProposalValues({ workspaceId, proposalId: proposal._id, fieldValues });
  }

  async function onSaveProposal(proposal: { _id: Id<"formProposals">; fieldValues: Array<{ name: string; factId: Id<"contextFacts"> | null }> }) {
    setFormNotice("");
    try {
      const result = await onSaveProposalValues(proposal);
      setProposalEdits((prev) => ({ ...prev, [proposal._id]: {} }));
      setFormNotice(result.unmatchedRequired.length > 0
        ? `Saved. Still unmatched: ${result.unmatchedRequired.join(", ")}.`
        : "Saved. The payload hash changed, so any earlier approval was revoked — approve again to submit.");
    } catch (error) {
      setFormNotice(error instanceof Error ? error.message : "Could not save the payload.");
    }
  }

  async function onApproveAndSubmit(proposal: { _id: Id<"formProposals">; fieldValues: Array<{ name: string; factId: Id<"contextFacts"> | null }> }) {
    setSubmittingProposalId(proposal._id); setFormNotice("");
    try {
      // Persist any edits first so the approval binds to exactly what is shown.
      await onSaveProposalValues(proposal);
      setProposalEdits((prev) => ({ ...prev, [proposal._id]: {} }));
      await approveProposal({ workspaceId, proposalId: proposal._id });
      const result = await executeFormSubmission({ workspaceId, proposalId: proposal._id });
      setFormNotice(result.status === "submitted"
        ? `Submitted once with screenshot evidence${result.evidenceCaptured ? "" : " (the target returned no screenshot)"}.`
        : result.status === "already_submitted"
          ? "Radar already submitted this approval; it did not submit twice."
          : result.detail);
    } catch (error) {
      setFormNotice(error instanceof Error ? error.message : "Submission failed.");
    } finally { setSubmittingProposalId(null); }
  }

  const confirmedFactsForForms = (contextFacts ?? []).filter((fact) => ["user_confirmed", "user_corrected"].includes(fact.verificationStatus));
  const runWorking = run && ["queued", "active"].includes(run.status);
  const selectedThreadMission = (() => {
    const thread = (threads ?? []).find((item) => item.threadId === selectedThreadId);
    return thread?.missionId ? missions?.find((mission) => mission._id === thread.missionId) : undefined;
  })();
  // The relationship this conversation belongs to, so the message shows the
  // person and the stage Radar is holding for them, not just the raw address.
  const selectedThreadOutcome = (workspaceOutcomes ?? []).find((outcome) => outcome.linkedThreadId === selectedThreadId);

  const filteredMissions = useMemo(() => {
    if (!missions) return [];
    if (!sidebarSearch.trim()) return missions;
    const q = sidebarSearch.toLowerCase();
    return missions.filter((m) => m.rawGoal.toLowerCase().includes(q) || m.title.toLowerCase().includes(q));
  }, [missions, sidebarSearch]);

  const sidebar = (
    <aside className="sidebar">
      <div className="brand-lockup">
        <div className="brand-mark">↗</div>
        <div><strong>Prospect Radar</strong><span>OPPORTUNITY OS</span></div>
      </div>
      <div className="workspace-switcher">
        <div className="workspace-avatar">PR</div>
        <div className="workspace-copy"><strong>{workspace?.name ?? "Radar"}</strong><span>{user?.email ?? "Workspace"}</span></div>
      </div>
      <div className="sidebar-search">
        <input type="text" placeholder="Search missions…" value={sidebarSearch} onChange={(e) => setSidebarSearch(e.target.value)} aria-label="Search missions" />
        {sidebarSearch && <button type="button" className="sidebar-search-clear" onClick={() => setSidebarSearch("")}>✕</button>}
      </div>
      <nav className="main-nav" aria-label="Primary">
        {navGroups.map((group) => (
          <div className="nav-group" key={group}>
            <p className="nav-section-label">{group}</p>
            {navItems.filter((item) => item.group === group).map((item) => (
              <button key={item.id} type="button" className={activeView === item.id ? "nav-item active" : "nav-item"} onClick={() => selectView(item.id)}>
                <span className="nav-label"><strong>{item.label}</strong><em>{item.hint}</em></span>
                {navCounts[item.id] ? <span className="nav-count">{navCounts[item.id]}</span> : null}
              </button>
            ))}
          </div>
        ))}
      </nav>
      {/* Mission history */}
      <button type="button" className="nav-section-toggle" onClick={() => setShowMissionHistory(!showMissionHistory)}>
        <span className="nav-section-label">Missions</span>
        <span>{showMissionHistory ? "▾" : "▸"} {missions?.length ?? 0}</span>
      </button>
      {showMissionHistory && (
        <div className="mission-history">
          {filteredMissions.length === 0 ? (
            <p className="empty-state">No missions yet.</p>
          ) : (
            filteredMissions.map((mission) => {
              const missionRun = board?.find((row) => row.missionId === mission._id);
              return (
                <button key={mission._id} type="button" className={`mission-history-item${selectedMissionId === mission._id ? " selected" : ""}`} onClick={() => { setSelectedMissionId(mission._id); selectView("home"); }}>
                  <span className="mission-history-title">{mission.rawGoal.slice(0, 40)}{mission.rawGoal.length > 40 ? "…" : ""}</span>
                  <span className="mission-history-meta">
                    {missionRun ? <span className={`status-pill status-${missionRun.runStatus}`}>{missionRun.runStatus}</span> : <span className="status-pill status-draft">draft</span>}
                    <span className="muted">{shortDate(mission.createdAt)}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      <div className="sidebar-spacer" />
      <div className="theme-switch" role="radiogroup" aria-label="Theme">
        {themeOptions.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={themeChoice === option.value}
            className={themeChoice === option.value ? "active" : ""}
            onClick={() => setTheme(option.value)}
            title={`${option.label} theme`}
          >
            <span aria-hidden="true">{option.glyph}</span>{option.label}
          </button>
        ))}
      </div>
      <div className="backend-status-card">
        <div className="status-icon"><span className="status-dot" /></div>
        <div><strong>{backendConnected ? "Convex connected" : "Backend setup"}</strong><span>{backendConnected ? "Live subscriptions on" : "Run npx convex dev"}</span></div>
      </div>
      <div className="auth-bar">
        <span className="auth-user">{user?.name ?? user?.email ?? "Signed in"}</span>
        <button type="button" className="btn ghost auth-signout" onClick={() => signOut()}>Sign out</button>
      </div>
      {selectedMission && <div className="backend-status-card mission-chip"><div className="status-icon"><span className="status-dot amber-dot" /></div><div><strong>{selectedMission.title.slice(0, 30)}{selectedMission.title.length > 30 ? "…" : ""}</strong><span>{run ? `${run.currentStage} · ${run.status}` : selectedMission.status}</span></div></div>}
    </aside>
  );

  // Every hook above has already run, so this guard cannot change the hook
  // count between renders. While the workspace provisions there is nothing
  // workspace-scoped to render yet.
  if (!workspace) return <AuthSplash label="Preparing your workspace…" />;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      {sidebar}

      <div className="main-area">
        <header className="topbar">
          <div className="breadcrumb">
            <button type="button" className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNavOpen(true)}>☰</button>
            <strong>{viewTitles[activeView].title}</strong>
            <span>{viewTitles[activeView].eyebrow}</span>
          </div>
          <div className="command-bar" role="search">
            <span className="command-icon" aria-hidden="true">⌕</span>
            <input
              type="search"
              value={commandTerm}
              onChange={(event) => setCommandTerm(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") setCommandTerm(""); }}
              placeholder="Search entities, relationships, messages…"
              aria-label="Search everything across this workspace"
            />
            {commandTerm.trim().length >= 2 && (
              <div className="command-results" role="listbox" aria-label="Search results">
                {searchResults === undefined ? (
                  <p className="empty-state">Searching…</p>
                ) : searchResults.length === 0 ? (
                  <p className="empty-state">Nothing matched “{commandTerm.trim()}” yet.</p>
                ) : (
                  searchResults.map((result) => (
                    <button key={`${result.kind}-${result.id}`} type="button" className="command-result" onClick={() => openSearchResult(result)}>
                      <span className={`command-kind kind-${result.kind}`}>{result.kind}</span>
                      <span className="command-copy"><strong>{result.title}</strong><em>{result.detail}</em></span>
                      <span className="muted">{shortDate(result.at)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          <div className="topbar-actions">
            <span className="live-status"><span className="pulse-dot" />{backendConnected ? "LIVE" : "OFFLINE"}</span>
            {attentionItems.length > 0 && <button type="button" className="attention-chip" onClick={() => selectView(attentionItems[0].view)}>{attentionItems.length} need{attentionItems.length === 1 ? "" : "s"} attention</button>}
          </div>
        </header>

        <main className="content-wrap" id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <p className="eyebrow">{viewTitles[activeView].eyebrow}</p>
              <h1>{viewTitles[activeView].title}</h1>
              <p className="page-desc">{viewTitles[activeView].description}</p>
            </div>
            {agentState && (
              <div className={`agent-state tone-${agentState.tone}`} role="status" aria-live="polite">
                <span className="agent-state-glyph" aria-hidden="true">{agentState.glyph}</span>
                <div className="agent-state-copy">
                  <strong>{agentState.label}</strong>
                  <p>{agentState.detail}</p>
                </div>
                <span className="agent-state-mission" title={selectedMission?.rawGoal}>{selectedMission?.title}</span>
              </div>
            )}
          </div>

          {activeView === "home" && (
            <div className="workspace">
              {/* ── Active mission: visible the moment a run exists ── */}
              {selectedMission && (
                <section className="panel active-mission" id="active-mission" aria-label="Active mission">
                  <div className="panel-head">
                    <p className="eyebrow">ACTIVE MISSION</p>
                    <div className="control-row">
                      <span className={`status-pill status-${run?.status ?? selectedMission.status}`}>{run?.status ?? selectedMission.status}</span>
                      {run && !["cancelled", "complete", "failed"].includes(run.status) && (
                        <button type="button" className="btn ghost" onClick={onStopRun}>■ Stop</button>
                      )}
                      {run?.status === "blocked" && (
                        <button type="button" className="btn ghost" onClick={onRetryStage}>{budgetBlocked ? "↻ Resume" : "↻ Retry"}</button>
                      )}
                    </div>
                  </div>
                  {/* ── Progress timeline: what Radar is doing right now ── */}
                  {run && (() => {
                    const stages = [
                      { key: "intake", label: "Understanding" },
                      { key: "context_check", label: "Context" },
                      { key: "plan_review", label: "Planning" },
                      { key: "discover", label: "Researching" },
                      { key: "evaluate", label: "Evaluating" },
                      { key: "approval", label: "Awaiting you" },
                      { key: "execute", label: "Executing" },
                      { key: "observe", label: "Observing" },
                      { key: "complete", label: "Done" },
                    ];
                    const stageOrder = stages.map((s) => s.key);
                    const currentIdx = stageOrder.indexOf(run.currentStage);
                    const isTerminal = ["complete", "failed", "cancelled"].includes(run.status);
                    const isWaiting = run.status === "waiting";
                    const isActive = run.status === "active";
                    return (
                      <div className="progress-timeline" role="status" aria-label="Mission progress">
                        {stages.map((stage, idx) => {
                          let state: "done" | "active" | "waiting" | "pending" = "pending";
                          if (isTerminal && run.status === "complete" && idx <= currentIdx) state = "done";
                          else if (isTerminal) state = idx < currentIdx ? "done" : "pending";
                          else if (idx < currentIdx) state = "done";
                          else if (idx === currentIdx) state = isWaiting ? "waiting" : isActive ? "active" : "pending";
                          return (
                            <div key={stage.key} className={`timeline-step timeline-${state}`}>
                              <span className="timeline-dot" />
                              <span className="timeline-label">{stage.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                  {run && run.status === "active" && (
                    <p className="stage-note" style={{ marginTop: "0.5rem" }}>Radar is working in the background. You can leave this page — we'll notify you when your attention is needed.</p>
                  )}
                  {run && run.status === "waiting" && run.currentStage === "approval" && (
                    <p className="stage-note" style={{ marginTop: "0.5rem" }}>Radar found something and needs your approval before it acts. Review in Actions.</p>
                  )}
                  {/* What the user asked */}
                  <p className="mission-goal-display"><strong>You asked:</strong> {selectedMission.rawGoal}</p>

                  {/* ── Budget intervention ──
                      Radar spends real provider credits, so a mission can pause
                      purely on cost. This renders only when that has actually
                      happened (or the cap no longer covers the next stage) —
                      otherwise the agent state would tell the user to raise a
                      cap that the UI gave them no way to raise. */}
                  {budgetStatus && (budgetBlocked || budgetStatus.exhausted || !budgetStatus.allowed) && (
                    <div className="budget-strip budget-blocked" role="alert">
                      <div className="panel-head">
                        <p className="eyebrow">RESEARCH PAUSED</p>
                        <span className="muted">{budgetStatus.used} of {budgetStatus.creditLimit} credits used</span>
                      </div>
                      <p className="budget-note">
                        Radar reached your research budget of {budgetStatus.creditLimit} credits
                        {budgetStatus.pendingEstimate > 0 ? `, and the next stage is estimated at about ${budgetStatus.pendingEstimate}` : ""}.
                        {" "}Increase the limit to let Radar continue.
                      </p>
                      <div className="budget-figures">
                        <span><em>Used</em><strong>{budgetStatus.used}</strong></span>
                        <span><em>Limit</em><strong>{budgetStatus.creditLimit}</strong></span>
                        <span><em>Remaining</em><strong>{budgetStatus.remaining}</strong></span>
                        <span><em>Pending estimate ≈</em><strong>{budgetStatus.pendingEstimate}</strong></span>
                      </div>
                      <div className="budget-control">
                        <input
                          inputMode="numeric"
                          placeholder={`New limit (now ${budgetStatus.creditLimit})`}
                          value={budgetLimitDraft}
                          onChange={(event) => setBudgetLimitDraft(event.target.value)}
                          aria-label="New research credit limit"
                        />
                        <button type="button" className="btn" onClick={onRaiseBudgetLimit} disabled={!budgetLimitDraft.trim()}>Raise limit</button>
                        {run?.status === "blocked" && (
                          <button type="button" className="btn ghost" onClick={onRetryStage}>↻ Resume mission</button>
                        )}
                      </div>
                      {budgetNotice && <p className="stage-note" role="status">{budgetNotice}</p>}
                    </div>
                  )}

                  {/* Radar's understanding */}
                  {selectedMission.intent && (
                    <div className="understanding-inline">
                      <strong>Radar understands:</strong> <span>{selectedMission.intent.rationale}</span>
                      <span className="stage-note">{selectedMission.intent.primary.replace("find_", "")}{selectedMission.intent.secondary ? ` + ${selectedMission.intent.secondary.replace("find_", "")}` : ""}</span>
                    </div>
                  )}
                  {/* Clarification request */}
                  {selectedMission.clarification && (
                    <div className="thread-ask">
                      <p><b>Radar needs one detail:</b> {selectedMission.clarification}</p>
                      <div className="control-row">
                        <input value={clarifyAnswer} onChange={(e) => setClarifyAnswer(e.target.value)} placeholder="Answer in one line…" aria-label="Clarification answer" />
                        <button type="button" className="btn" disabled={!clarifyAnswer.trim() || planning} onClick={onClarifySubmit}>Answer</button>
                      </div>
                    </div>
                  )}
                  {/* Context check — Radar asks for missing information */}
                  {run?.status === "waiting" && run.currentStage === "context_check" && readiness && (
                    <div className="thread-ask">
                      {readiness.conflictCount > 0 ? (
                        <>
                          <p><b>Radar found conflicting information. Which should it use?</b></p>
                          <p className="muted">Radar will not pick a side on its own — this is your call to make.</p>
                        </>
                      ) : readiness.missingRequired.length > 0 ? (
                        <>
                          <p><b>Radar needs {readiness.missingRequired.length} detail{readiness.missingRequired.length > 1 ? "s" : ""} before it can plan:</b></p>
                          <p className="muted">These help Radar understand your situation so it can search effectively.</p>
                        </>
                      ) : readiness.missingImportant.length > 0 ? (
                        <p><b>Radar could use one more detail to search better (optional):</b></p>
                      ) : null}
                      {/* Each unresolved requirement: a conflict to settle, a question to answer, or an artifact to attach */}
                      {readiness.requirements.filter((r) => !r.satisfied && r.criticality !== "nice_to_have").map((req) => (
                        <div key={req.key} style={{ marginBottom: "0.75rem" }}>
                          <p style={{ marginBottom: "0.25rem" }}><b>{req.question}</b></p>
                          {req.why && <p className="stage-note" style={{ marginBottom: "0.25rem" }}>{req.why}</p>}

                          {req.conflictValues && req.conflictValues.length > 0 ? (
                            <>
                              {req.evidence && <p className="stage-note" style={{ marginBottom: "0.25rem" }}>In your sources: {req.evidence}</p>}
                              <div className="control-row" style={{ flexWrap: "wrap" }}>
                                {req.conflictValues.map((option) => (
                                  <label key={option.value} className="muted" style={{ display: "inline-flex", gap: "0.35rem", alignItems: "center" }}>
                                    <input
                                      type="radio"
                                      name={`conflict-${req.key}`}
                                      checked={conflictChoice[req.key] === option.value}
                                      onChange={() => setConflictChoice((prev) => ({ ...prev, [req.key]: option.value }))}
                                    />
                                    {option.value} <span className="stage-note">({option.origin})</span>
                                  </label>
                                ))}
                              </div>
                              <div className="control-row">
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={!conflictChoice[req.key] || planning}
                                  onClick={() => onContextCheckSubmit(req.key, { answer: conflictChoice[req.key], supersedes: req.supersedes ?? undefined })}
                                >
                                  {planning ? "Saving…" : "Use this"}
                                </button>
                              </div>
                            </>
                          ) : (
                            <>
                              {req.evidence && (
                                <p className="stage-note" style={{ marginBottom: "0.25rem" }}>Radar found related info in: {req.evidence}</p>
                              )}
                              <div className="control-row">
                                <input
                                  value={contextCheckKey === req.key ? contextCheckAnswer : ""}
                                  onChange={(e) => { setContextCheckKey(req.key); setContextCheckAnswer(e.target.value); }}
                                  placeholder="Your answer…"
                                  aria-label={req.question}
                                />
                                <button
                                  type="button"
                                  className="btn"
                                  disabled={!contextCheckAnswer.trim() || contextCheckKey !== req.key || planning}
                                  onClick={() => onContextCheckSubmit(req.key, { supersedes: req.supersedes ?? undefined })}
                                >
                                  {planning ? "Saving…" : "Submit"}
                                </button>
                              </div>
                              {req.artifactLabel && (req.artifactKinds ?? []).includes("file") && (
                                <div className="control-row" style={{ marginTop: "0.35rem" }}>
                                  <label className="stage-note">
                                    or attach your {req.artifactLabel}:{" "}
                                    <input
                                      type="file"
                                      disabled={contextArtifactUploading === req.key}
                                      onChange={(e) => {
                                        const file = e.target.files?.[0] ?? null;
                                        e.target.value = "";
                                        void onContextArtifactUpload(req.key, file);
                                      }}
                                    />
                                  </label>
                                  {contextArtifactUploading === req.key && <span className="stage-note">Uploading…</span>}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ))}
                      <p className="stage-note">Radar will continue automatically after you answer.</p>
                    </div>
                  )}
                  {/* Lifecycle rail — the core visual of what Radar is doing */}
                  <MissionLifecycle
                    run={run ? { status: run.status, currentStage: run.currentStage, activeInterruption: run.activeInterruption ?? null } : { status: selectedMission.status, currentStage: "intake", activeInterruption: null }}
                    latestStep={runSteps && runSteps.length > 0 ? runSteps[runSteps.length - 1] : undefined}
                  />

                  {/* ── GAP 1: Plan review card ── */}
                  {run?.status === "waiting" && run.currentStage === "plan_review" && (
                    <div className="plan-review-card">
                      <div className="panel-head"><p className="eyebrow">RADAR'S PLAN</p><span className="muted">review before searching</span></div>
                      {plan ? (
                        <>
                          <div className="plan-goal"><strong>Goal:</strong> {plan.normalizedGoal}</div>
                          {plan.mustHave.length > 0 && (
                            <div className="plan-section"><strong>Must find:</strong> {plan.mustHave.join(", ")}</div>
                          )}
                          {plan.niceToHave.length > 0 && (
                            <div className="plan-section"><strong>Nice to have:</strong> {plan.niceToHave.join(", ")}</div>
                          )}
                          {plan.exclusions && (
                            <div className="plan-section"><strong>Exclusions:</strong> {plan.exclusions}</div>
                          )}
                          {plan.recommendedSources && (
                            <div className="plan-section"><strong>Sources:</strong> {plan.recommendedSources}</div>
                          )}
                          {plan.strategyNotes && (
                            <div className="plan-section"><strong>Strategy:</strong> {plan.strategyNotes}</div>
                          )}
                        </>
                      ) : (
                        <p className="stage-note">Loading plan…</p>
                      )}
                      <div className="inline-actions">
                        <button type="button" className="btn" onClick={onApprovePlan} disabled={planning}>{planning ? "Approving…" : "✓ Approve plan"}</button>
                      </div>
                      {planNotice && <p className="stage-note" role="status">{planNotice}</p>}
                    </div>
                  )}

                  {/* ── Mission brief & objective: the mission's own knobs ──
                      Plan editing lives in mission context, not on a separate
                      dashboard. Collapsed by default — it is an override, not a
                      step in the workflow. This is where the user says what
                      "finished" means (10 candidates, or one reply). */}
                  {plan && !(run?.status === "waiting" && run.currentStage === "plan_review") && (
                    <details className="brief-card home-brief">
                      <summary className="panel-head">
                        <p className="eyebrow">MISSION BRIEF &amp; OBJECTIVE</p>
                        <span className="muted">{plan.userEditedAt ? `edited ${shortDate(plan.userEditedAt)}` : "AI-planned"} · adjust any time</span>
                      </summary>
                      {goalEditing ? (
                        <div className="view-stack">
                          <label className="field-label" htmlFor="goal-correct">Goal</label>
                          <textarea
                            id="goal-correct"
                            className="composer-input"
                            rows={2}
                            value={goalDraft}
                            onChange={(event) => setGoalDraft(event.target.value)}
                          />
                          <p className="stage-note">Radar re-reads the objective and rebuilds the plan from it. Nothing else about the mission changes, and no stage is advanced by hand.</p>
                          <div className="inline-actions">
                            <button type="button" className="btn" onClick={onCorrectGoal} disabled={!goalDraft.trim() || planning}>{planning ? "Re-reading…" : "Save goal"}</button>
                            <button type="button" className="btn ghost" onClick={() => { setGoalEditing(false); setGoalNotice(""); }}>Cancel</button>
                          </div>
                        </div>
                      ) : briefEditing ? (
                        <div className="view-stack">
                          <label className="field-label" htmlFor="brief-goal">Goal</label>
                          <textarea id="brief-goal" className="composer-input" rows={2} value={briefDraft.normalizedGoal} onChange={(event) => setBriefDraft({ ...briefDraft, normalizedGoal: event.target.value })} />
                          <label className="field-label" htmlFor="brief-must">Must have (comma-separated)</label>
                          <input id="brief-must" className="composer-input" value={briefDraft.mustHave} onChange={(event) => setBriefDraft({ ...briefDraft, mustHave: event.target.value })} />
                          <label className="field-label" htmlFor="brief-nice">Nice to have</label>
                          <input id="brief-nice" className="composer-input" value={briefDraft.niceToHave} onChange={(event) => setBriefDraft({ ...briefDraft, niceToHave: event.target.value })} />
                          <label className="field-label" htmlFor="brief-excl">Exclusions</label>
                          <input id="brief-excl" className="composer-input" value={briefDraft.exclusions} onChange={(event) => setBriefDraft({ ...briefDraft, exclusions: event.target.value })} />
                          <label className="field-label" htmlFor="brief-predicate">Completion predicate</label>
                          <input id="brief-predicate" className="composer-input" value={briefDraft.completionPredicate} onChange={(event) => setBriefDraft({ ...briefDraft, completionPredicate: event.target.value })} />
                          <div className="inline-actions">
                            <button type="button" className="btn" onClick={onSaveBrief}>Save brief</button>
                            <button type="button" className="btn ghost" onClick={() => setBriefEditing(false)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className="plan-goal">{plan.normalizedGoal}</p>
                          {plan.mustHave.length > 0 && <p className="stage-note">Must have: {plan.mustHave.join(" · ")}</p>}
                          {plan.niceToHave.length > 0 && <p className="stage-note">Nice to have: {plan.niceToHave.join(" · ")}</p>}
                          {plan.exclusions.length > 0 && <p className="stage-note">Excluding: {plan.exclusions.join(" · ")}</p>}
                          <p className="stage-note">Completion: {plan.completionPredicate}</p>
                          <div className="objective-row">
                            <label className="field-label" htmlFor="objective-kind">Finished when</label>
                            <select
                              id="objective-kind"
                              value={objectiveKind || plan.successKind || "contact_and_wait"}
                              onChange={(event) => {
                                setObjectiveKind(event.target.value);
                                setObjectiveCount(plan.targetCount ?? 1);
                              }}
                            >
                              <option value="contact_and_wait">they have been contacted and replied</option>
                              <option value="find_candidates">enough candidates are assembled</option>
                              <option value="present_solution">a solution is found and presented</option>
                            </select>
                            <input
                              aria-label="How many"
                              type="number"
                              min={1}
                              max={100}
                              value={objectiveCount || plan.targetCount || 1}
                              onChange={(event) => setObjectiveCount(Number(event.target.value))}
                            />
                            <button type="button" className="btn ghost" onClick={onSetObjective}>Set</button>
                          </div>
                          <p className="stage-note">
                            {plan.successKind
                              ? `Radar is measuring this mission against: ${plan.successKind === "contact_and_wait" ? `contacting ${plan.targetCount ?? 1} and waiting for a reply` : plan.successKind === "present_solution" ? `presenting ${plan.targetCount ?? 1} credible solution(s)` : `assembling ${plan.targetCount ?? 3} qualified candidate(s)`}${plan.userEditedAt ? " (your decision)" : " (read from your request)"}.`
                              : "This plan did not state an objective, so the default for this kind of request stands until you set one."}
                          </p>
                          {objectiveNotice && <p className="stage-note" role="status">{objectiveNotice}</p>}
                          <div className="inline-actions">
                            <button type="button" className="btn ghost" onClick={() => { setGoalEditing(true); setGoalDraft(selectedMission?.rawGoal ?? plan.normalizedGoal); setGoalNotice(""); }}>Correct goal</button>
                            <button type="button" className="btn ghost" onClick={startBriefEdit}>Edit brief</button>
                          </div>
                        </>
                      )}
                      {briefNotice && <p className="stage-note" role="status">{briefNotice}</p>}
                      {goalNotice && <p className="stage-note" role="status">{goalNotice}</p>}
                    </details>
                  )}

                  {/* ── GAP 5: Check-in card ── */}
                  {run?.status === "waiting" && run.currentStage === "check_in" && (
                    <div className="checkin-card">
                      <div className="panel-head"><p className="eyebrow">DISCOVERY SUMMARY</p><span className="muted">what Radar found</span></div>
                      <div className="checkin-stats">
                        <span><strong>{sources?.length ?? 0}</strong> sources</span>
                        <span><strong>{entities?.length ?? 0}</strong> entities</span>
                        <span><strong>{missionSignals?.length ?? 0}</strong> signals</span>
                        <span><strong>{matches?.length ?? 0}</strong> matches</span>
                      </div>
                      {matches && matches.filter((m) => m.label === "stronger").length > 0 && (
                        <p className="checkin-highlight">{matches.filter((m) => m.label === "stronger").length} strong match{matches.filter((m) => m.label === "stronger").length === 1 ? "" : "es"} found</p>
                      )}
                      <div className="inline-actions">
                        <button type="button" className="btn ghost" onClick={onContinueAfterCheckIn} disabled={planning}>{planning ? "Resuming…" : "↻ Resume this mission"}</button>
                      </div>
                    </div>
                  )}

                  {/* ── GAP 6: Parallel Firecrawl jobs ── */}
                  {jobs && jobs.length > 0 && run?.status === "active" && run.currentStage === "discover" && (
                    <div className="parallel-jobs">
                      <div className="panel-head"><p className="eyebrow">RESEARCHING</p><span className="muted">{jobs.filter((j) => j.status === "complete").length}/{jobs.length} done</span></div>
                      <div className="job-pills">
                        {jobs.slice(0, 8).map((job) => (
                          <span key={job._id} className={`job-pill job-${job.status}`}>
                            <span className="job-icon">{job.status === "running" ? "●" : job.status === "complete" ? "✓" : "✗"}</span>
                            {job.operation} · {job.query.slice(0, 30)}{job.query.length > 30 ? "…" : ""}
                            {job.resultCount > 0 ? <em>{job.resultCount}</em> : null}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── GAP 2: Inline tool cards (step transcript) ── */}
                  {runSteps && runSteps.length > 0 && (
                    <div className="step-cards">
                      <div className="panel-head"><p className="eyebrow">AGENT STEPS</p><span className="muted">{runSteps.length} receipt{runSteps.length === 1 ? "" : "s"}</span></div>
                      {runSteps.slice().reverse().map((step) => (
                        <details className="step-card" key={step._id}>
                          <summary className="step-card-head">
                            <span className={`step-dot step-${step.stage}`} />
                            <span className="step-label">{step.label}</span>
                            {step.tool && <em className="tool-chip">{step.tool}</em>}
                            <span className="step-summary">{step.summary}</span>
                          </summary>
                          <div className="step-card-body">
                            <p>{step.summary}</p>
                            <small>{shortDate(step.createdAt)} · {step.stage}{step.errorCode ? ` · ${step.errorCode}` : ""}{step.reference ? ` · ref ${step.reference.slice(0, 12)}…` : ""}</small>
                          </div>
                        </details>
                      ))}
                    </div>
                  )}

                  {/* ── GAP 4: Strong matches with source chips ── */}
                  {matches && matches.filter((m) => m.label === "stronger").length > 0 && (
                    <div className="thread-results">
                      <p className="thread-count"><strong>{matches.filter((m) => m.label === "stronger").length}</strong> strong match{matches.filter((m) => m.label === "stronger").length === 1 ? "" : "es"} · {matches.length} evaluated</p>
                      <div className="thread-cards">
                        {matches.filter((m) => m.label === "stronger").slice(0, 3).map((match) => {
                          const matchSource = match.sourceId ? sources?.find((s) => s._id === match.sourceId) : undefined;
                          return (
                            <div className="thread-result" key={match._id}>
                              <strong>{match.entity?.name ?? match.subject}</strong>
                              <span className="muted">{match.explanationSummary?.slice(0, 120)}{match.explanationSummary && match.explanationSummary.length > 120 ? "…" : ""}</span>
                              {matchSource && (
                                <span className="source-chip" title={matchSource.url}>
                                  <span className="source-icon">🔗</span>{hostLabel(matchSource.url)}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      <button type="button" className="btn ghost" onClick={() => selectView("discover")}>View all matches →</button>
                    </div>
                  )}

                  {/* ── GAP 3: Follow-up suggestions ── */}
                  {run?.status === "complete" && matches && matches.length > 0 && (
                    <div className="followup-suggestions">
                      <p className="followup-title">What next?</p>
                      <div className="followup-pills">
                        {matches.filter((m) => m.label === "stronger").length > 0 && (
                          <button type="button" className="followup-pill" onClick={() => selectView("actions")}>Draft outreach to top match</button>
                        )}
                        {entities && entities.length > 0 && (
                          <button type="button" className="followup-pill" onClick={() => selectView("discover")}>Review all entities</button>
                        )}
                        <button type="button" className="followup-pill" onClick={() => { setOutcomesTab("relationships"); selectView("outcomes"); }}>See relationships</button>
                        <button type="button" className="followup-pill" onClick={() => { setGoal("Find more companies like the top matches"); selectView("home"); }}>Find similar</button>
                      </div>
                    </div>
                  )}
                  {/* ── Approval gate: always actionable ── */}
                  {(atApprovalGate || draftsOnGate.length > 0) && (
                    <div className="thread-approval">
                      <div className="panel-head">
                        <p className="eyebrow">WAITING FOR YOU</p>
                        <span className="muted">nothing has been sent</span>
                      </div>
                      {draftsOnGate.length > 0 ? (
                        <>
                          <p><b>{draftsOnGate.length} draft{draftsOnGate.length === 1 ? "" : "s"} ready for review.</b> Each one is approved as its own exact recipient, subject, and body.</p>
                          <div className="inline-actions">
                            <button type="button" className="btn" onClick={() => selectView("actions")}>Review &amp; approve →</button>
                          </div>
                        </>
                      ) : !inbox ? (
                        <>
                          <p><b>Nowhere to send from yet.</b> Radar finished researching ahead of the gate. Link a sending inbox and it can propose the first message here.</p>
                          <div className="inline-actions">
                            <button type="button" className="btn" onClick={onProvisionInboxFromGate} disabled={!backendConnected || provisioning}>
                              {provisioning ? "Creating inbox…" : "Create sending inbox"}
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <p><b>Radar opened this gate with nothing to send.</b>{" "}
                            {latestDecision
                              ? `${DECISION_LABELS[latestDecision.decision] ?? latestDecision.decision}: ${latestDecision.detail}`
                              : "It found no match with a verified, supported contact route."}
                          </p>
                          <p className="stage-note">Radar does not invent a contact route, so this is the honest outcome of its research rather than a step waiting on you. Inspect what it found and why.</p>
                          {emailBlocker && <p className="stage-note">{emailBlocker}</p>}
                          <div className="inline-actions">
                            <button type="button" className="btn ghost" onClick={() => selectView("discover")}>Inspect what Radar found →</button>
                          </div>
                        </>
                      )}
                      {approvalNotice && <p className="stage-note">{approvalNotice}</p>}
                    </div>
                  )}
                  {/* Terminal state */}
                  {run && ["cancelled", "complete", "failed"].includes(run.status) && run.status !== "complete" && (
                    <p className="stage-note">Run {run.status}{run.status === "failed" ? " — see Activity for the reason." : " — you stopped this mission."}</p>
                  )}
                  {run?.status === "complete" && (
                    <p className="stage-note">Mission complete. <button type="button" className="btn ghost" onClick={() => selectView("outcomes")}>See outcomes →</button></p>
                  )}
                </section>
              )}

              {/* ── Workspace summary: lightweight metrics from Dashboard ── */}
              {overview && (
                <section className="panel" aria-label="Workspace summary">
                  <div className="panel-head"><p className="eyebrow">WORKSPACE</p></div>
                  <div className="metric-grid">
                    {[
                      { label: "Entities", value: overview.counts.entities, view: "discover" as View },
                      { label: "Replies", value: overview.counts.replies, view: "inbox" as View },
                      { label: "Drafts pending", value: overview.counts.draftsPending, view: "actions" as View },
                      { label: "Open outcomes", value: (workspaceOutcomes ?? []).filter((o) => !["won", "lost"].includes(o.stage)).length, view: "outcomes" as View },
                    ].map((metric) => (
                      <button key={metric.label} type="button" className="metric-tile" onClick={() => selectView(metric.view)}>
                        <span className="metric-value">{metric.value}</span>
                        <span className="metric-label">{metric.label}</span>
                      </button>
                    ))}
                  </div>
                  {overview.pipeline.some((row) => row.count > 0) && (
                    <div className="pipeline-mini" aria-label="Pipeline">
                      {overview.pipeline.filter((row) => row.count > 0).map((row) => {
                        const max = Math.max(...overview.pipeline.map((item) => item.count), 1);
                        return (
                          <div key={row.stage} className="pipeline-mini-row">
                            <span>{PIPELINE_LABELS[row.stage as PipelineStageName] ?? row.stage}</span>
                            <span className="pipeline-bar" aria-hidden="true"><span style={{ width: `${Math.round((row.count / max) * 100)}%` }} /></span>
                            <strong>{row.count}</strong>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div className="inline-actions">
                    <button type="button" className="btn ghost" onClick={() => selectView("outcomes")}>View all outcomes →</button>
                  </div>
                </section>
              )}

              {/* ── Attention items ── */}
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

              {/* ── Activity link ── */}
              {run && (
                <div className="inline-actions" style={{ justifyContent: "center", padding: "0 0 1rem" }}>
                  <button type="button" className="btn ghost" onClick={() => selectView("activity")}>View execution history →</button>
                </div>
              )}

              {/* ── Orientation, only while the workspace is still empty ── */}
              {!selectedMission && (
                <section className="panel" aria-label="How Radar works">
                  <div className="panel-head"><p className="eyebrow">HOW RADAR WORKS</p></div>
                  <ol className="journey">
                    <li><span>01</span><strong>You set a goal</strong><p>Tell Radar what you want. It plans autonomously.</p></li>
                    <li><span>02</span><strong>Radar works</strong><p>Researches, evaluates, and decides — you can leave.</p></li>
                    <li><span>03</span><strong>Radar asks you</strong><p>Only when it needs approval or missing info.</p></li>
                    <li><span>04</span><strong>You approve</strong><p>Radar acts only on your explicit approval.</p></li>
                    <li><span>05</span><strong>Radar continues</strong><p>Observes, follows up, records the outcome.</p></li>
                  </ol>
                  <div className="sponsor-strip">
                    {sponsorCapabilities.map(([sponsor, capability]) => (
                      <div key={sponsor} className="sponsor-chip"><strong>{sponsor}</strong><span>{capability}</span></div>
                    ))}
                  </div>
                </section>
              )}

              {/* ── Composer: always visible at the bottom ── */}
              <section className="panel composer-panel" aria-label="Ask Radar">
                <form onSubmit={onSubmit}>
                  <label className="field-label" htmlFor="mission-goal">What should Radar find for you?</label>
                  <textarea id="mission-goal" className="composer-input" rows={2} value={goal} onChange={(event) => setGoal(event.target.value)} aria-label="Tell Radar what you are looking for, in your own words" placeholder="Tell Radar what you're looking for… e.g. Find businesses that need React development, or I need someone to design a logo for my startup" />
                  <div className="composer-controls">
                    <button type="submit" className="btn" disabled={!backendConnected || submitting || !goal.trim()}>{submitting ? "Starting…" : "Run Radar →"}</button>
                    {notice && <span className="stage-note">{notice}</span>}
                  </div>
                  <div className="quick-prompts" aria-label="Starting points">
                    {quickPrompts.map((prompt) => (
                      <button key={prompt.label} type="button" onClick={() => setGoal(prompt.goal)}>{prompt.label}</button>
                    ))}
                  </div>
                </form>
              </section>
            </div>
          )}

          {activeView === "discover" && (
            <div className="view-stack">
              {!selectedMission ? <p className="empty-state">Select or start a mission first.</p> : (
                <>
                  <section className="panel" aria-label="Evidence graph">
                    <div className="panel-head"><p className="eyebrow">EVIDENCE GRAPH</p>
                      <span className="muted">Match → source → entity → decision. Every edge is a persisted record, not an after-the-fact summary.</span>
                      {runWorking && <span className="status-pill status-running">run active</span>}
                    </div>
                    <div className="graph-lenses" role="tablist" aria-label="Evidence lens">
                      {([
                        { key: "matches", label: "Matches", count: (matches ?? []).length },
                        { key: "sources", label: "Sources", count: (sources ?? []).length },
                        { key: "entities", label: "Entities", count: (entities ?? []).length },
                      ] as const).map((lens) => (
                        <button
                          key={lens.key}
                          type="button"
                          role="tab"
                          aria-selected={discoverLens === lens.key && !discoverFocus}
                          className={discoverLens === lens.key ? "graph-lens active" : "graph-lens"}
                          onClick={() => { setDiscoverLens(lens.key); setDiscoverFocus(null); }}
                        >
                          {lens.label}<em>{lens.count}</em>
                        </button>
                      ))}
                    </div>
                    {discoverFocus && (
                      <p className="graph-focus">
                        <span>Focused on {discoverFocus.kind}: <strong>{discoverFocus.label}</strong></span>
                        <button type="button" className="btn ghost" onClick={() => setDiscoverFocus(null)}>Clear focus</button>
                      </p>
                    )}
                    <p className="stage-note">{latestJob ? `${sources?.length ?? 0} sources from ${jobs?.length ?? 0} research jobs` : "The agent discovers sources automatically during its run."}</p>
                    {(unmatchedSources.length > 0 || unmatchedEntities.length > 0) && (
                      <p className="stage-note">
                        {unmatchedSources.length > 0
                          ? <>{unmatchedSources.length} fetched page{unmatchedSources.length === 1 ? "" : "s"} produced no match. </>
                          : null}
                        {unmatchedEntities.length > 0
                          ? <>{unmatchedEntities.length} resolved entit{unmatchedEntities.length === 1 ? "y" : "ies"} produced no match. </>
                          : null}
                        They stay in the graph rather than being discarded, so what Radar ruled out is as inspectable as what it kept.
                      </p>
                    )}
                    {researchNotice && <p className="stage-note" role="status">{researchNotice}</p>}
                  </section>

                  {discoverLens === "matches" && (
                  <section aria-label="Matches">
                    {matches === undefined ? <p className="empty-state">Loading matches…</p> : matches.length === 0 ? (
                      <div className="panel"><p className="empty-state">No matches yet. Radar explains which constraint limited discovery rather than inventing candidates.</p></div>
                    ) : (
                      <div className="graph-list">
                        {matches.map((match) => {
                          const source = sourceById(match.sourceId);
                          const matchDecision = decisionFor(match._id);
                          const typeLabel = SOURCE_TYPE_LABELS[match.sourceType] ?? match.sourceType;
                          const entityId = match.entity?._id ?? null;
                          const signals = entityId ? signalsForEntity(entityId) : [];
                          const open = expandedMatchId === match._id;
                          return (
                            <article className={`panel graph-match${open ? " open" : ""}`} key={match._id}>
                              {/* The graph edge, stated in one row: page → entity → decision. */}
                              <button
                                type="button"
                                className="graph-match-head"
                                aria-expanded={open}
                                onClick={() => setExpandedMatchId(open ? null : match._id)}
                              >
                                <span className={`status-pill status-${match.label}`}>{match.label}</span>
                                <strong>{match.entity?.name ?? match.subject}</strong>
                                {match.entity && <span className={`kind-pill kind-${match.entity.kind}`}>{match.entity.kind}</span>}
                                <span className="graph-edge">{hostLabel(match.sourceUrl)} → {match.entity ? "entity" : "no entity"} → {matchDecision ? DECISION_LABELS[matchDecision.decision] ?? matchDecision.decision : "no decision"}</span>
                                {matchDecision && <span className={`decision-pill decision-${matchDecision.decision}`}>{matchDecision.actionability.replace(/_/g, " ")}</span>}
                                <span className="graph-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
                              </button>

                              {open && (
                                <div className="graph-chain">
                                  {/* ① The page the evidence was read from. */}
                                  <div className="graph-node">
                                    <p className="eyebrow">① SOURCE</p>
                                    <a className="graph-node-link" href={match.sourceUrl} target="_blank" rel="noreferrer">{hostLabel(match.sourceUrl)}</a>
                                    <p className="stage-note">{match.sourceTitle} · {typeLabel}{match.freshness ? ` · ${match.freshness}` : ""}{source ? ` · fetched ${shortDate(source.fetchedAt)}` : ""}</p>
                                    <p className="stage-note">{match.sourceQuery
                                      ? <>Its plan searched the public web for “{match.sourceQuery}” — this {typeLabel} page matched.</>
                                      : <>Found while {typeLabel === "crawled" ? "crawling" : "researching"} a source from this mission.</>}</p>
                                    <div className="inline-actions">
                                      <button type="button" className="btn ghost" onClick={() => { setDiscoverLens("sources"); setDiscoverFocus({ kind: "source", id: match.sourceId, label: hostLabel(match.sourceUrl) }); }}>Open in sources →</button>
                                      {source && !source.content && <button type="button" className="btn ghost" disabled={!backendConnected || investigateCapability?.available === false} onClick={() => onScrape(match.sourceId)}>Scrape full page</button>}
                                    </div>
                                  </div>

                                  {/* ② The entity resolved from that page. */}
                                  <div className="graph-node">
                                    <p className="eyebrow">② ENTITY</p>
                                    {match.entity && entityId ? (
                                      <>
                                        <div className="entity-head">
                                          <span className={`kind-pill kind-${match.entity.kind}`}>{match.entity.kind}</span>
                                          <strong>{match.entity.name}</strong>
                                          <span className="muted">confidence {Math.round(match.entity.confidence * 100)}%</span>
                                          {match.entity.extractionStatus === "snippet_only" && <span className="mono-tag">snippet-only</span>}
                                        </div>
                                        {match.entity.expressedNeed && <p className="stage-note"><b>Needs</b>{match.entity.expressedNeed}</p>}
                                        {match.entity.offer.length > 0 && <p className="stage-note"><b>Offers</b>{match.entity.offer.join(" · ")}</p>}
                                        {match.entity.contactRoute ? (
                                          <p className="stage-note"><b>Contact</b>{match.entity.contactRoute.kind}: {match.entity.contactRoute.value} <a className="source-link" href={match.entity.contactRoute.publicSource} target="_blank" rel="noreferrer">public source</a></p>
                                        ) : (
                                          <p className="stage-note warn"><b>Contact</b>No public route found — Radar researches an alternate route instead of guessing.</p>
                                        )}
                                        {signals.map((signal) => (
                                          <p className="signal-row" key={signal._id}><span className="signal-chip">{signal.type.replace(/_/g, " ")}</span>{signal.statement}</p>
                                        ))}
                                        <div className="inline-actions">
                                          <button type="button" className="btn ghost" onClick={() => { setDiscoverLens("entities"); setDiscoverFocus({ kind: "entity", id: entityId, label: match.entity?.name ?? match.subject }); }}>Open in entities →</button>
                                        </div>
                                      </>
                                    ) : (
                                      <p className="empty-state">No entity was resolved from this page, so the match rests on the discovery snippet alone.</p>
                                    )}
                                  </div>

                                  {/* ③ What Radar decided about it, and why. */}
                                  <div className="graph-node">
                                    <p className="eyebrow">③ DECISION</p>
                                    {matchDecision ? (
                                      <div className={`decision-note decision-${matchDecision.decision}`}>
                                        <p className="why-row"><b>Radar decided</b>{DECISION_LABELS[matchDecision.decision] ?? matchDecision.decision} — {matchDecision.detail}</p>
                                        <p className="stage-note">Match {matchDecision.quality} · actionability {matchDecision.actionability}{matchDecision.capability ? ` · via ${matchDecision.capability}` : ""}</p>
                                        {matchDecision.missingEvidence && <p className="stage-note">Still missing: {matchDecision.missingEvidence}</p>}
                                        {matchDecision.usedFacts.length > 0 && <p className="stage-note">Authorized facts: {matchDecision.usedFacts.map((fact) => `${fact.category}: ${fact.value}`).join(" · ")}</p>}
                                        {matchDecision.artifacts.length > 0 && <p className="stage-note">Authorized documents: {matchDecision.artifacts.map((artifact) => artifact.title).join(" · ")}</p>}
                                        {matchDecision.alternatives.length > 0 && <p className="stage-note">Rejected: {matchDecision.alternatives.map((alt) => `${alt.decision} — ${alt.reason}`).join("; ")}</p>}
                                      </div>
                                    ) : (
                                      <p className="empty-state">No action decision recorded yet — Radar writes one when the mission reaches the action stage.</p>
                                    )}
                                    {match.explanationSummary && <p className="why-row"><b>Why it matches</b>{match.explanationSummary}</p>}
                                    {match.positiveEvidence.length > 0 && (
                                      <p className="why-row"><b>Evidence</b>
                                        <ul className="evidence-list">
                                          {match.positiveEvidence.slice(0, 4).map((item, index) => <li key={index}>{item}</li>)}
                                        </ul>
                                      </p>
                                    )}
                                    {match.unknowns.length > 0 && <p className="why-row"><b>Unknowns</b>{match.unknowns.join(" · ")}</p>}
                                    {match.risks.length > 0 && <p className="why-row why-risk"><b>Risks</b>{match.risks.join(" · ")}</p>}
                                    <p className="why-row"><b>From your context</b>{match.userSourceTitles.length > 0
                                      ? <>Checked against your sources: {match.userSourceTitles.slice(0, 3).join(", ")}{match.userSourceTitles.length > 3 ? ` +${match.userSourceTitles.length - 3} more` : ""}.</>
                                      : "Judged against your mission brief and confirmed facts."}</p>
                                    {match.recommendedAction && <p className="next-action"><b>Next</b>{match.recommendedAction}</p>}
                                  </div>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                  )}

                  {discoverLens === "sources" && (
                  <section aria-label="Sources">
                    {sources === undefined ? <p className="empty-state">Loading sources…</p> : sources.length === 0 ? (
                      <div className="panel"><p className="empty-state">No sources fetched yet. They appear as Radar researches.</p></div>
                    ) : (
                      <div className="graph-list">
                        {(discoverFocus?.kind === "source" ? sources.filter((item) => item._id === discoverFocus.id) : sources).map((source) => {
                          const entity = (entities ?? []).find((item) => item.sourceId === source._id) ?? null;
                          const sourceMatches = matchesForSource(source._id);
                          return (
                            <article className="panel graph-node-card" key={source._id}>
                              <div className="panel-head">
                                <p className="eyebrow">SOURCE</p>
                                <span className="mono-tag">{SOURCE_TYPE_LABELS[source.sourceType] ?? source.sourceType}</span>
                                <span className="muted">fetched {shortDate(source.fetchedAt)}</span>
                                {sourceMatches.length === 0 && <span className="decision-pill decision-no_action">no match</span>}
                              </div>
                              <a className="graph-node-link" href={source.url} target="_blank" rel="noreferrer">{hostLabel(source.url)}</a>
                              <p className="stage-note">{source.title}</p>
                              <div className="graph-edges">
                                <span>→ {entity ? `entity: ${entity.name}` : "no entity resolved"}</span>
                                <span>→ {sourceMatches.length} match{sourceMatches.length === 1 ? "" : "es"}</span>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                  )}

                  {discoverLens === "entities" && (
                  <section aria-label="Entities">
                    {entities === undefined ? <p className="empty-state">Loading entities…</p> : entities.length === 0 ? (
                      <div className="panel"><p className="empty-state">No entities resolved yet. Radar extracts them from the pages it fetches.</p></div>
                    ) : (
                      <div className="graph-list">
                        {(discoverFocus?.kind === "entity" ? entities.filter((item) => item._id === discoverFocus.id) : entities).map((entity) => {
                          const entityMatches = matchesForEntity(entity._id);
                          const signals = signalsForEntity(entity._id);
                          const source = sourceById(entity.sourceId);
                          return (
                            <article className="panel graph-node-card" key={entity._id}>
                              <div className="panel-head">
                                <span className={`kind-pill kind-${entity.kind}`}>{entity.kind}</span>
                                <strong>{entity.name}</strong>
                                <span className="muted">confidence {Math.round(entity.confidence * 100)}%</span>
                                {entity.extractionStatus === "snippet_only" && <span className="mono-tag">snippet-only</span>}
                                {entityMatches.length === 0 && <span className="decision-pill decision-no_action">unmatched</span>}
                              </div>
                              {entity.expressedNeed && <p className="stage-note"><b>Needs</b>{entity.expressedNeed}</p>}
                              {entity.skillsOrOffer.length > 0 && <p className="stage-note"><b>Offers</b>{entity.skillsOrOffer.join(" · ")}</p>}
                              {entity.contactRoute ? (
                                <p className="stage-note"><b>Contact</b>{entity.contactRoute.kind}: {entity.contactRoute.value} <a className="source-link" href={entity.contactRoute.publicSource} target="_blank" rel="noreferrer">public source</a></p>
                              ) : (
                                <p className="stage-note warn"><b>Contact</b>No public route found — Radar researches an alternate route instead of guessing.</p>
                              )}
                              {signals.slice(0, 4).map((signal) => (
                                <p className="signal-row" key={signal._id}><span className="signal-chip">{signal.type.replace(/_/g, " ")}</span>{signal.statement}</p>
                              ))}
                              <div className="graph-edges">
                                {source && <span>← source: <a href={source.url} target="_blank" rel="noreferrer">{hostLabel(source.url)}</a></span>}
                                <span>→ {entityMatches.length} match{entityMatches.length === 1 ? "" : "es"}</span>
                              </div>
                              {entityMatches.length > 0 && (
                                <div className="inline-actions">
                                  <button type="button" className="btn ghost" onClick={() => { setDiscoverLens("matches"); setDiscoverFocus(null); setExpandedMatchId(entityMatches[0]?._id ?? null); }}>Open its match →</button>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>
                  )}
                </>
              )}
            </div>
          )}

          {activeView === "actions" && (
            <div className="view-stack">
              <div className="actions-divider"><span>Outreach</span></div>
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
                <section className="panel" aria-label="Agent-proposed outreach">
                  <div className="panel-head"><p className="eyebrow">AGENT-PROPOSED ACTIONS</p></div>
                  <p className="stage-note">Radar decides when to propose an action based on what it found. You review and approve each one before anything sends.</p>
                </section>
              )}

              <section aria-label="Drafts">
                {drafts === undefined ? <p className="empty-state">Loading actions…</p> : drafts.length === 0 ? (
                  <div className="panel"><p className="empty-state">No actions yet. Radar proposes them on its own; sending never happens without your approval.</p></div>
                ) : (
                  <div className="view-stack">
                    {[
                      { key: "needs", tone: "amber", label: "Needs your approval", hint: "Approve the exact content and Radar sends it.", statuses: ["draft", "awaiting_approval"] },
                      { key: "progress", tone: "accent", label: "In progress", hint: "Approved and being executed by Radar.", statuses: ["approved", "executing"] },
                      { key: "done", tone: "green", label: "Completed", hint: "Executed, with the result observed.", statuses: ["sent", "delivered"] },
                      { key: "blocked", tone: "red", label: "Blocked or failed", hint: "Radar could not finish these, and recorded why.", statuses: ["failed", "blocked", "cancelled"] },
                    ].map((group) => {
                      const groupDrafts = drafts.filter((draft) => group.statuses.includes(draft.status));
                      if (groupDrafts.length === 0) return null;
                      return (
                        <div className={`action-group tone-${group.tone}`} key={group.key}>
                          <div className="actions-divider"><span>{group.label}</span><em>{groupDrafts.length}</em></div>
                          <p className="action-group-hint">{group.hint}</p>
                          {groupDrafts.map((draft) => (
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
                        {draft.matchId && decisionFor(draft.matchId) && (
                          <p className="stage-note">Radar proposed this because: {decisionFor(draft.matchId)!.detail}</p>
                        )}
                        {/* The approval covers the whole action, so the documents it
                            carries are shown at the moment of approving. */}
                        {draft.attachments.length > 0 && (
                          <p className="stage-note">Attached, because you authorized it: {draft.attachments.map((attachment) => attachment.title).join(" · ")}</p>
                        )}
                        <p className="stage-note">Side effect: one email from the linked AgentMail inbox to {draft.recipient}{draft.attachments.length > 0 ? `, carrying ${draft.attachments.length} of your document${draft.attachments.length === 1 ? "" : "s"}` : ""}. Nothing else.</p>
                        {draft.errorSummary && <p className="stage-note error">{draft.errorSummary}</p>}
                        <div className="inline-actions">
                          {![ "sent", "delivered", "executing" ].includes(draft.status) && (
                            <button type="button" className="btn" onClick={() => onApprove(draft._id)}>
                              {draft.approvalStatus === "active" ? "Re-approve" : "Approve exact content"}
                            </button>
                          )}
                          {draft.status === "approved" && (
                            <>
                              <span className="stage-note">Approved — Radar sends this automatically.</span>
                              <button type="button" className="btn ghost" onClick={() => onSend(draft._id)} disabled={sendingActionId === draft._id || emailCapability?.available === false}>
                                {sendingActionId === draft._id ? "Sending…" : "↻ Send now (override)"}
                              </button>
                            </>
                          )}
                          {draft.status === "executing" && draft.outboundId && (
                            <button type="button" className="btn ghost" onClick={() => onSyncOutbound(draft._id)}>Check send status</button>
                          )}
                          {draft.providerMessageId && <span className="mono-tag">message {draft.providerMessageId.slice(0, 14)}…</span>}
                        </div>
                      </article>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                )}
                {outreachNotice && <p className="stage-note">{outreachNotice}</p>}
              </section>

              {sequences && sequences.length > 0 && (
                <section className="panel" aria-label="Outreach sequences">
                  <div className="panel-head"><p className="eyebrow">SEQUENCES</p><span className="muted">{sequences.length}</span></div>
                  <p className="stage-note">A follow-up sequence opens when an approved intro is sent. Each step becomes its own draft — approving one step never approves the next.</p>
                  <div className="view-stack">
                    {sequences.map((sequence) => (
                      <article className="sequence-card" key={sequence._id}>
                        <div className="panel-head">
                          <strong>{matches?.find((match) => match._id === sequence.matchId)?.subject ?? "Match"}</strong>
                          <span className={`status-pill status-${sequence.status}`}>{sequence.status}</span>
                        </div>
                        <ol className="sequence-steps">
                          {sequence.steps.map((step) => (
                            <li className={`sequence-step ${step.status}`} key={`${sequence._id}-${step.index}`}>
                              <span className="step-index">{step.index + 1}</span>
                              <div>
                                <strong>{step.intent}</strong>
                                <em>trigger: {step.trigger.replace("_", " ")} · {step.status.replace("_", " ")}</em>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {activeView === "inbox" && (
            <div className="view-stack">
              <div className="inbox-layout">
                <section className="panel" aria-label="Conversations">
                  <div className="panel-head"><p className="eyebrow">CONVERSATIONS</p><span className="muted">{threads?.length ?? 0}</span></div>
                  {threads === undefined ? <p className="empty-state">Loading…</p> : threads.length === 0 ? <p className="empty-state">No conversations yet. They appear here when Radar reaches out and when a reply lands.</p> : (
                    <div className="row-list">
                      {threads.map((thread) => {
                        const threadMission = thread.missionId ? missions?.find((mission) => mission._id === thread.missionId) : undefined;
                        const threadApprovals = (drafts ?? []).filter((draft) => draft.threadId === thread.threadId && ["awaiting_approval", "approved"].includes(draft.status));
                        const latestClassification = classifications?.find((item) => item.threadId === thread.threadId);
                        // A message is never just a message: it belongs to a person
                        // and to a relationship Radar is tracking. The thread links
                        // to that relationship by `linkedThreadId`, so the context
                        // here is read, not guessed.
                        const threadOutcome = (workspaceOutcomes ?? []).find((outcome) => outcome.linkedThreadId === thread.threadId);
                        const threadFollowUp = threadOutcome ? followUpForOutcome(threadOutcome._id) : undefined;
                        return (
                          <article className={selectedThreadId === thread.threadId ? "row-item static selected" : "row-item static"} key={thread._id}>
                            <button type="button" className="thread-select" onClick={() => setSelectedThreadId(thread.threadId)}>
                              <strong>{threadOutcome ? threadOutcome.counterpart : thread.senderSummary}</strong>
                              <em>{thread.subject || "(no subject)"} · {thread.preview}</em>
                              <span className="thread-meta">
                                {threadOutcome ? `${PIPELINE_LABELS[threadOutcome.stage as PipelineStageName] ?? threadOutcome.stage} · relationship · ` : ""}
                                {threadMission ? `mission: ${threadMission.title.slice(0, 32)}${threadMission.title.length > 32 ? "…" : ""} · ` : ""}
                                {latestClassification ? `radar read: ${latestClassification.label.replace("_", " ")}` : thread.labels.map((label) => `#${label}`).join(" ")}
                                {threadFollowUp ? ` · follow-up ${threadFollowUp.status === "due" || threadFollowUp.dueAt <= Date.now() ? "due now" : shortDate(threadFollowUp.dueAt)}` : ""}
                              </span>
                            </button>
                            <div className="board-state">
                              {threadApprovals.length > 0 && <span className="status-pill status-awaiting_approval">{threadApprovals.length} draft{threadApprovals.length === 1 ? "" : "s"}</span>}
                              {thread.labels.includes("waiting") && <span className="status-pill status-waiting">agent waiting</span>}
                            </div>
                            {selectedThreadId === thread.threadId && (
                              <div className="inline-actions">
                                {(["new", "waiting", "reply", "closed"] as const).map((label) => (
                                  <button key={label} type="button" className={thread.labels.includes(label) ? "btn" : "btn ghost"} onClick={() => setThreadLabel({ workspaceId, threadId: thread._id, label, set: !thread.labels.includes(label) })}>{label}</button>
                                ))}
                              </div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="panel" aria-label="Agent conversation">
                  <div className="panel-head">
                    <p className="eyebrow">AGENT CONVERSATION</p>
                    {selectedThreadOutcome && <span className="mono-tag">{selectedThreadOutcome.counterpart} · {PIPELINE_LABELS[selectedThreadOutcome.stage as PipelineStageName] ?? selectedThreadOutcome.stage}</span>}
                    {selectedThreadMission && <span className="mono-tag">{selectedThreadMission.title.slice(0, 36)}{selectedThreadMission.title.length > 36 ? "…" : ""}</span>}
                  </div>
                  {!selectedThreadId ? <p className="empty-state">Select a conversation. Radar shows what it understood, what it proposes next, and what it needs from you.</p> : threadMessages === undefined ? <p className="empty-state">Loading messages…</p> : threadMessages.length === 0 ? <p className="empty-state">No messages in this conversation yet.</p> : (
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
                                <p className="radar-understood"><b>Radar understood</b>{classification.summary} <span className="muted">({Math.round(classification.confidence * 100)}% · {classification.model})</span></p>
                                <p className="radar-next"><b>Proposed next action</b>{classification.suggestedNextAction}</p>
                                {suggestedDraft ? (
                                  <>
                                    <p className="radar-drafted"><b>Drafted reply</b> <span className="muted">Radar prepared this on its own; it sends only after you approve it.</span></p>
                                    <p className="prewrap draft-suggestion"><strong>{suggestedDraft.subject}</strong>\n{classification.suggestedDraftId && suggestedDraft.status === "sent" ? "" : ""}{suggestedDraft.body}</p>
                                    <div className="inline-actions">
                                      {!["sent", "delivered", "executing"].includes(suggestedDraft.status) && (
                                        <button type="button" className="btn" onClick={() => onApprove(suggestedDraft._id)}>
                                          {suggestedDraft.approvalStatus === "active" ? "Re-approve this exact reply" : "Approve this exact reply"}
                                        </button>
                                      )}
                                      {suggestedDraft.status === "approved" && (
                                        <button type="button" className="btn ghost" onClick={() => onSend(suggestedDraft._id)} disabled={sendingActionId === suggestedDraft._id}>
                                          {sendingActionId === suggestedDraft._id ? "Sending…" : "↻ Send now (override)"}
                                        </button>
                                      )}
                                      {suggestedDraft.status === "sent" && <span className="status-pill status-sent">sent</span>}
                                      {suggestedDraft.status === "delivered" && <span className="status-pill status-delivered">delivered</span>}
                                      {suggestedDraft.providerMessageId && suggestedDraft.status !== "draft" && suggestedDraft.status !== "awaiting_approval" && <span className="mono-tag">msg {suggestedDraft.providerMessageId.slice(0, 10)}…</span>}
                                    </div>
                                    <p className="stage-note">Approval state: {suggestedDraft.approvalStatus ?? "not requested"}{suggestedDraft.approvalExpiresAt && suggestedDraft.approvalStatus === "active" ? ` · expires ${shortDate(suggestedDraft.approvalExpiresAt)}` : ""} · Radar sends only this exact content.</p>
                                  </>
                                ) : (
                                  <p className="stage-note">No draft yet — Radar proposes, you decide. Any reply it prepares lands here for approval first.</p>
                                )}
                                {classification.model === "pending" && <p className="stage-note">Radar is reading this reply…</p>}
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

          {/*
            Outcomes: what actually happened, as opposed to Relationships
            (which tracks where each one stands right now). The counts come from
            persisted records, so a judge can verify every number in the
            Convex dashboard.
          */}
          {activeView === "outcomes" && (
            <div className="view-stack">
              {/* ── Outcomes tabs ── */}
              <div className="outcomes-tabs" role="tablist" aria-label="Outcomes sections">
                {(["results", "relationships", "pipeline"] as const).map((tab) => (
                  <button key={tab} type="button" role="tab" aria-selected={outcomesTab === tab} className={outcomesTab === tab ? "active" : ""} onClick={() => setOutcomesTab(tab)}>
                    {tab === "results" ? "Results" : tab === "relationships" ? "Relationships" : "Pipeline"}
                  </button>
                ))}
              </div>

              {/* ── Results tab ── */}
              {outcomesTab === "results" && (
                <>
                  <section className="panel" aria-label="Results so far">
                    <div className="panel-head"><p className="eyebrow">RESULTS SO FAR</p><span className="muted">counted from persisted records — nothing estimated</span></div>
                    {!overview ? <p className="empty-state">Loading results…</p> : (
                      <>
                        <div className="metric-grid">
                          {[
                            { label: "Messages approved & sent", value: overview.counts.draftsApproved },
                            { label: "Replies received", value: overview.counts.replies },
                            { label: "Conversations", value: overview.counts.threads },
                            { label: "Form submissions", value: overview.counts.submissions },
                            { label: "Submissions blocked", value: overview.counts.blockedSubmissions },
                            { label: "People & orgs found", value: overview.counts.entities },
                          ].map((metric) => (
                            <div className="metric-tile static" key={metric.label}>
                              <span className="metric-value">{metric.value}</span>
                              <span className="metric-label">{metric.label}</span>
                            </div>
                          ))}
                        </div>
                        <p className="stage-note">Blocked submissions are forms Radar refused to force — a login wall or a human check is reported as a stop, never bypassed.</p>
                      </>
                    )}
                  </section>

                  {/*
                    Results answers "what happened?" — so it groups outcomes by
                    the result itself. The counterpart directory, with its
                    stages, sequences, follow-ups, and meetings, lives in the
                    Relationships tab; listing it here too made two tabs answer
                    the same question.
                  */}
                  <section className="panel" aria-label="Outcome results">
                    <div className="panel-head">
                      <p className="eyebrow">OUTCOME RESULTS</p>
                      <span className="muted">{workspaceOutcomes?.length ?? 0} recorded across this workspace</span>
                    </div>
                    {workspaceOutcomes === undefined ? <p className="empty-state">Loading outcomes…</p> : workspaceOutcomes.length === 0 ? (
                      <p className="empty-state">No outcomes recorded yet. Radar opens one the moment an approved message is sent or a reply lands — whichever mission started it, it shows up here.</p>
                    ) : (
                      <div className="view-stack">
                        {([
                          { key: "succeeded", label: "Succeeded", hint: "the counterpart engaged", statuses: ["positive"], tone: "green" },
                          { key: "waiting", label: "Waiting on them", hint: "sent, or holding for a reply", statuses: ["open", "waiting", "replied"], tone: "amber" },
                          { key: "closed", label: "Closed without a yes", hint: "declined, or Radar closed it out", statuses: ["negative", "closed"], tone: "red" },
                          { key: "unresolved", label: "Unresolved", hint: "Radar could not classify the result", statuses: ["unknown"], tone: "accent" },
                        ] as const).map((bucket) => {
                          const rows = workspaceOutcomes.filter((outcome) => (bucket.statuses as readonly string[]).includes(outcome.status));
                          if (rows.length === 0) return null;
                          return (
                            <div className={`action-group tone-${bucket.tone}`} key={bucket.key}>
                              <div className="actions-divider"><span>{bucket.label}</span><em>{rows.length} · {bucket.hint}</em></div>
                              <div className="row-list">
                                {rows.map((outcome) => (
                                  <article className="row-item static" key={outcome._id}>
                                    <div className="row-copy">
                                      <strong><span className={`stage-dot stage-${outcome.stage}`} /> {outcome.counterpart}</strong>
                                      <em>{outcome.latestEvidence}</em>
                                      <span className="muted">
                                        {PIPELINE_LABELS[outcome.stage as PipelineStageName] ?? outcome.stage} · {outcome.missionTitle} · updated {shortDate(outcome.updatedAt)}
                                      </span>
                                    </div>
                                  </article>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}

              {/* ── Relationships tab (from old Relationships page) ── */}
              {outcomesTab === "relationships" && (
                <>
                  {(sequences ?? []).filter((sequence) => sequence.status === "active").length > 0 && (
                    <section className="panel" aria-label="Ongoing sequences">
                      <div className="panel-head"><p className="eyebrow">ONGOING SEQUENCES</p><span className="muted">this mission · each step becomes its own approval — nothing auto-sends</span></div>
                      <div className="row-list">
                        {(sequences ?? []).filter((sequence) => sequence.status === "active").map((sequence) => {
                          const nextStep = sequence.steps.filter((step) => step.status === "draft_ready" || step.status === "pending")[0];
                          return (
                            <div className="row-item static" key={sequence._id}>
                              <div className="row-copy">
                                <strong>{matches?.find((match) => match._id === sequence.matchId)?.subject ?? "Relationship sequence"}</strong>
                                <em>{nextStep ? `Next: step ${nextStep.index + 1} — ${nextStep.intent} (${nextStep.status.replace("_", " ")})` : "All steps sent or awaiting approval"}</em>
                              </div>
                              <span className={`status-pill status-${sequence.status}`}>{sequence.steps.filter((step) => step.status === "sent").length}/{sequence.steps.length} sent</span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  <section className="panel" aria-label="Follow-ups">
                    <div className="panel-head"><p className="eyebrow">FOLLOW-UPS</p><span className="muted">this mission · {(followUps ?? []).length} open</span></div>
                    {(followUps ?? []).length === 0 ? (
                      <p className="empty-state">No open follow-ups. Radar schedules one when a reply defers; you can schedule your own on any relationship below.</p>
                    ) : (
                      <div className="row-list">
                        {(followUps ?? []).map((item) => (
                          <article className={`row-item static ${item.status === "due" || item.dueAt <= Date.now() ? "attention" : ""}`} key={item._id}>
                            <div className="row-copy">
                              <strong>{item.note}</strong>
                              <em>{item.source === "agent" ? "Radar scheduled this" : "You scheduled this"} · due {shortDate(item.dueAt)}{item.status === "due" ? " · due now" : ""}</em>
                            </div>
                            <div className="inline-actions">
                              <button type="button" className="btn ghost" onClick={() => onSnoozeFollowUp(item._id, 1)}>Snooze 1d</button>
                              <button type="button" className="btn ghost" onClick={() => onSnoozeFollowUp(item._id, 3)}>Snooze 3d</button>
                              <button type="button" className="btn" onClick={() => onCompleteFollowUp(item._id)}>Done</button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  {meetingDraft && (
                    <section className="panel" aria-label="Record a meeting">
                      <div className="panel-head"><p className="eyebrow">RECORD A MEETING</p><span className="muted">Radar cannot see calls that happen off-platform — tell it, and it remembers</span></div>
                      <div className="meeting-form">
                        <label>
                          <span>With</span>
                          <input value={meetingDraft.counterpart} onChange={(event) => setMeetingDraft({ ...meetingDraft, counterpart: event.target.value })} />
                        </label>
                        <label>
                          <span>Date</span>
                          <input type="date" value={meetingDraft.scheduledAt} onChange={(event) => setMeetingDraft({ ...meetingDraft, scheduledAt: event.target.value })} />
                        </label>
                        <label className="wide">
                          <span>Notes</span>
                          <input placeholder="What was discussed, and what was agreed?" value={meetingDraft.notes} onChange={(event) => setMeetingDraft({ ...meetingDraft, notes: event.target.value })} />
                        </label>
                        <div className="inline-actions">
                          <button type="button" className="btn" onClick={onRecordMeeting}>Save meeting</button>
                          <button type="button" className="btn ghost" onClick={() => setMeetingDraft(null)}>Cancel</button>
                        </div>
                      </div>
                      {pipelineNotice && <p className="stage-note">{pipelineNotice}</p>}
                    </section>
                  )}

                  <section className="panel" aria-label="Meetings">
                    <div className="panel-head"><p className="eyebrow">MEETINGS</p><span className="muted">{(meetings ?? []).length} recorded on the selected mission</span></div>
                    {(meetings ?? []).length === 0 ? (
                      <p className="empty-state">No meetings yet. Use <strong>Record meeting</strong> on a relationship below when a call happens off-platform — Radar cannot observe those on its own.</p>
                    ) : (
                      <div className="row-list">
                        {(meetings ?? []).map((meeting) => {
                          const upcoming = meeting.scheduledAt >= Date.now();
                          return (
                            <div className={`row-item static ${upcoming ? "attention" : ""}`} key={meeting._id}>
                              <div className="row-copy">
                                <strong>{meeting.counterpart}</strong>
                                <em>{meeting.notes || "No notes recorded."}</em>
                              </div>
                              <span className="muted">{upcoming ? "Scheduled" : "Held"} {shortDate(meeting.scheduledAt)} · {meeting.createdBy === "agent" ? "Radar" : "you"}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  {/*
                    Relationships answers "who are we dealing with?" — so it is
                    the counterpart directory, across the whole workspace rather
                    than only this mission. Sequences, follow-ups, and meetings
                    above are the selected mission's; rows from other missions
                    say so, and only offer the meeting control where Radar knows
                    which mission to file it under.
                  */}
                  <section className="panel" aria-label="Relationships">
                    <div className="panel-head">
                      <p className="eyebrow">COUNTERPARTS</p>
                      <span className="muted">{workspaceOutcomes?.length ?? 0} tracked across this workspace</span>
                    </div>
                    {workspaceOutcomes === undefined ? <p className="empty-state">Loading the pipeline…</p> : workspaceOutcomes.length === 0 ? (
                      <p className="empty-state">No relationships yet. Radar opens one the moment an approved message is sent or a reply arrives — and remembers everything that happens next.</p>
                    ) : (
                      <div className="row-list">
                        {workspaceOutcomes.map((outcome) => {
                          const followUp = followUpForOutcome(outcome._id);
                          const overdue = followUp && (followUp.status === "due" || followUp.dueAt <= Date.now());
                          const onThisMission = outcome.missionId === missionId;
                          return (
                            <article className="row-item static" key={outcome._id}>
                              <div className="row-copy">
                                <strong><span className={`stage-dot stage-${outcome.stage}`} /> {outcome.counterpart}</strong>
                                <em>{outcome.latestEvidence}</em>
                                <span className="muted">{PIPELINE_LABELS[outcome.stage as PipelineStageName] ?? outcome.stage} · {outcome.missionTitle} · updated {shortDate(outcome.updatedAt)}{followUp ? ` · follow-up ${overdue ? "due now" : shortDate(followUp.dueAt)}` : ""}</span>
                                {meetingsForOutcome(outcome._id).length > 0 && (
                                  <div className="meeting-list" aria-label={`Meetings with ${outcome.counterpart}`}>
                                    {meetingsForOutcome(outcome._id).map((meeting) => (
                                      <p className={`meeting-entry ${meeting.scheduledAt >= Date.now() ? "upcoming" : ""}`} key={meeting._id}>
                                        <strong>{meeting.scheduledAt >= Date.now() ? "Upcoming" : "Held"} {shortDate(meeting.scheduledAt)}</strong>
                                        {meeting.notes ? ` — ${meeting.notes}` : ""}
                                        <em>{meeting.createdBy === "agent" ? "recorded by Radar" : "recorded by you"}</em>
                                      </p>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <div className="inline-actions">
                                <button type="button" className="btn ghost" onClick={() => onAdvanceStage(outcome._id, "engaged", "Reply with a concrete next step.")}>Engaged</button>
                                {onThisMission && (
                                  <button type="button" className="btn ghost" onClick={() => setMeetingDraft({ outcomeId: outcome._id, matchId: outcome.matchId ?? null, counterpart: outcome.counterpart, scheduledAt: new Date(Date.now() + 86400000).toISOString().slice(0, 10), notes: "" })}>Record meeting</button>
                                )}
                                <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "positive")}>Won</button>
                                <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "closed")}>Lost</button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                    {pipelineNotice && <p className="stage-note">{pipelineNotice}</p>}
                  </section>
                </>
              )}

              {/* ── Pipeline tab ── */}
              {outcomesTab === "pipeline" && (
                <section className="panel" aria-label="Pipeline">
                  <div className="panel-head"><p className="eyebrow">PIPELINE</p><span className="muted">workspace-level progress</span></div>
                  {!overview ? <p className="empty-state">Loading…</p> : (
                    <>
                      <div className="stage-summary">
                        {overview.pipeline.map((row) => (
                          <span key={row.stage} className={row.count > 0 ? "" : "zero"}>
                            <span className={`stage-dot stage-${row.stage}`} />{PIPELINE_LABELS[row.stage as PipelineStageName] ?? row.stage}
                            <strong>{row.count}</strong>
                          </span>
                        ))}
                      </div>
                      <div className="run-strip" aria-label="Run states">
                        <span><em>Working now</em><strong>{overview.counts.runsActive}</strong></span>
                        <span><em>Ready to run</em><strong>{overview.counts.runsReady}</strong></span>
                        <span><em>Parked</em><strong>{overview.counts.runsWaiting}</strong></span>
                        <span><em>Blocked</em><strong>{overview.counts.runsBlocked}</strong></span>
                      </div>
                    </>
                  )}
                </section>
              )}
            </div>
          )}

          {/*
            Activity: the real execution trail. Rows come from the runs board,
            and the event log is the durable runEvents/runSteps the orchestrator
            already writes — so this page cannot show work that did not happen.
          */}
          {activeView === "activity" && (
            <div className="view-stack">
              <section className="panel" aria-label="Run trail">
                <div className="panel-head"><p className="eyebrow">RUN TRAIL</p><span className="muted">{board?.length ?? 0} mission{(board?.length ?? 0) === 1 ? "" : "s"}</span></div>
                {board === undefined ? <p className="empty-state">Loading the trail…</p> : board.length === 0 ? (
                  <p className="empty-state">Nothing has run yet. Start a mission on Home and every step Radar takes is recorded here.</p>
                ) : (
                  <div className="row-list">
                    {[...board].sort((a, b) => b.updatedAt - a.updatedAt).map((row) => (
                      <article className={`row-item static${activityMissionId === row.missionId ? " selected" : ""}`} key={row.missionId}>
                        <button type="button" className="thread-select" onClick={() => { setActivityMissionId(row.missionId); setSelectedMissionId(row.missionId); }}>
                          <strong>{row.missionTitle}</strong>
                          <em>{row.lastStep ? `${row.lastStep.label} — ${row.lastStep.summary}` : "No step recorded yet"}</em>
                          <span className="thread-meta">
                            {row.currentStage ?? "—"}{row.lastStep?.tool ? ` · ${row.lastStep.tool}` : ""} · {shortDate(row.updatedAt)}{row.lastStep?.errorCode ? ` · ${row.lastStep.errorCode}` : ""}
                          </span>
                        </button>
                        <div className="board-state">
                          <span className={`status-pill status-${row.runStatus}`}>{row.runStatus}</span>
                          {row.awaitingApprovals > 0 && <span className="status-pill status-awaiting_approval">{row.awaitingApprovals} waiting</span>}
                          {row.activeInterruption && <span className="status-pill status-blocked">{row.activeInterruption.replace(/_/g, " ")}</span>}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {activityMissionId && (
                <section className="panel" aria-label="Event log">
                  <div className="panel-head"><p className="eyebrow">EVENT LOG</p><span className="muted">durable runEvents, oldest first</span></div>
                  {activityEvents === undefined ? <p className="empty-state">Loading events…</p> : activityEvents.length === 0 ? (
                    <p className="empty-state">No events recorded for this run yet.</p>
                  ) : (
                    <ol className="activity-log">
                      {activityEvents.map((evt) => (
                        <li key={evt._id}>
                          <span className="activity-time">{shortDate(evt.createdAt)}</span>
                          <span className="status-pill status-draft">{evt.stage.replace(/_/g, " ")}</span>
                          <span className="activity-copy"><strong>{evt.type}</strong> — {evt.safeSummary}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              )}

              {activityMissionId && activitySteps && activitySteps.length > 0 && (
                <section className="panel" aria-label="Step record">
                  <div className="panel-head"><p className="eyebrow">STEP RECORD</p><span className="muted">{activitySteps.length} recorded</span></div>
                  <div className="row-list">
                    {activitySteps.map((step) => (
                      <div className="row-item static" key={step._id}>
                        <div className="row-copy">
                          <strong>{step.label}</strong>
                          <em>{step.summary}</em>
                          <span className="muted">{step.stage}{step.tool ? ` · ${step.tool}` : ""} · {shortDate(step.createdAt)}{step.errorCode ? ` · ${step.errorCode}` : ""}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {activeView === "actions" && (
            <div className="view-stack">
              <div className="actions-divider"><span>Form submissions</span></div>
              {!selectedMission ? <p className="empty-state">Select or start a mission first.</p> : (
                <>
                  {/* Manual form controls are an override, never the workflow.
                      Radar decides on its own whether a form route is worth
                      investigating and prepares the fill; this stays collapsed so
                      the normal experience is the proposal below rather than a
                      Firecrawl control panel. */}
                  <details className="advanced-override">
                    <summary>
                      <span className="eyebrow">ADVANCED · MANUAL FORM CONTROLS</span>
                      <span className="muted">Scout one specific source by hand. Radar normally decides this itself.</span>
                    </summary>
                  <section className="panel" aria-label="Form scout">
                    <div className="panel-head">
                      <p className="eyebrow">FIRECRAWL FORM SCOUT</p>
                      {formCap && <span className="muted">{formCap.used}/{formCap.cap} submissions today</span>}
                    </div>
                    <p className="stage-note">Radar reads a public form, proposes a fill from your confirmed facts only, and submits one approved payload at a time with a screenshot as evidence. Login walls and CAPTCHAs are detected and never bypassed.</p>
                    <div className="control-row">
                      <select aria-label="Source to scout" value={formSourceId} onChange={(event) => setFormSourceId(event.target.value)}>
                        <option value="">Choose a discovered source…</option>
                        {(sources ?? []).map((source) => (
                          <option key={source._id} value={source._id}>{source.title.slice(0, 60)} — {hostLabel(source.url)}</option>
                        ))}
                      </select>
                      <button type="button" className="btn ghost" disabled={!backendConnected || !formSourceId || scouting || formCapability?.available === false} onClick={onScoutForm}>{scouting ? "Scouting…" : "Scout form"}</button>
                    </div>
                    {formNotice && <p className="stage-note">{formNotice}</p>}
                  </section>

                  <section aria-label="Scouted forms">
                    {formTemplates === undefined ? <p className="empty-state">Loading scouted forms…</p> : formTemplates.length === 0 ? (
                      <div className="panel"><p className="empty-state">Nothing scouted by hand. Radar scouts form routes itself when a target has no email route.</p></div>
                    ) : (
                      <div className="view-stack">
                        {formTemplates.map((template) => (
                          <article className="panel form-card" key={template._id}>
                            <div className="panel-head">
                              <strong>{template.formTitle}</strong>
                              <span className="muted">{hostLabel(template.url)} · scouted {shortDate(template.scoutedAt)}</span>
                            </div>
                            {template.blockedReason ? (
                              <>
                                <span className="status-pill status-blocked">{template.blockedReason.replace(/_/g, " ")}</span>
                                <p className="stage-note error">{template.blockedDetail}</p>
                              </>
                            ) : (
                              <>
                                <p className="stage-note">{template.fields.length} field{template.fields.length === 1 ? "" : "s"} · confidence {Math.round(template.confidence * 100)}%{template.submitLabel ? ` · submit: “${template.submitLabel}”` : ""}</p>
                                <ul className="field-list">
                                  {template.fields.map((field) => (
                                    <li key={field.name}>
                                      <span className="mono-tag">{field.type}</span>
                                      <strong>{field.label}</strong>
                                      {field.required && <span className="status-pill status-awaiting_approval">required</span>}
                                      {field.options.length > 0 && <em className="muted">options: {field.options.join(" | ")}</em>}
                                    </li>
                                  ))}
                                </ul>
                                <div className="inline-actions">
                                  <button type="button" className="btn ghost" disabled={!backendConnected || proposing || formCapability?.available === false} onClick={() => onProposeFill(template._id)}>{proposing ? "Proposing…" : "Propose fill"}</button>
                                  <a className="source-link" href={template.url} target="_blank" rel="noreferrer">Open the form</a>
                                </div>
                              </>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                  </details>

                  <section aria-label="Fill proposals">
                    <div className="panel-head">
                      <p className="eyebrow">FILL PROPOSALS · APPROVE THE EXACT PAYLOAD</p>
                      <span className="muted">Radar prepares these on its own when a form is the only legitimate route</span>
                    </div>
                    {(formProposals ?? []).length === 0 ? (
                      <div className="panel"><p className="empty-state">No proposals yet. Radar scouts a form route itself when a target has no email route, then maps your confirmed facts onto the fields — anything it cannot ground stays empty.</p></div>
                    ) : (
                      <div className="view-stack">
                        {(formProposals ?? []).map((proposal) => {
                          const editable = !["submitted", "executing"].includes(proposal.status);
                          const template = (formTemplates ?? []).find((item) => item._id === proposal.templateId);
                          const requiredNames = new Set((template?.fields ?? []).filter((field) => field.required).map((field) => field.name));
                          return (
                            <article className="panel form-card" key={proposal._id}>
                              <div className="panel-head">
                                <strong>{proposal.formTitle}</strong>
                                <span className={`status-pill status-${proposal.status}`}>{proposal.status}</span>
                              </div>
                              <p className="stage-note">{hostLabel(proposal.url)} · payload {proposal.payloadHash.slice(0, 12)}…{proposal.approvalStatus ? ` · approval ${proposal.approvalStatus}` : ""}</p>
                              <div className="proposal-fields">
                                {proposal.fieldValues.map((field) => {
                                  const edited = proposalEdits[proposal._id]?.[field.name];
                                  const current = edited !== undefined ? edited : (field.factId ?? "");
                                  return (
                                    <label className="proposal-field" key={field.name}>
                                      <span>{field.label}{requiredNames.has(field.name) ? " *" : ""}</span>
                                      {editable ? (
                                        <select
                                          aria-label={`Value for ${field.label}`}
                                          value={current}
                                          onChange={(event) => setProposalEdits((prev) => ({
                                            ...prev,
                                            [proposal._id]: { ...(prev[proposal._id] ?? {}), [field.name]: event.target.value },
                                          }))}
                                        >
                                          <option value="">Leave empty</option>
                                          {confirmedFactsForForms.map((fact) => (
                                            <option key={fact._id} value={fact._id}>{fact.category}: {fact.value.slice(0, 50)}</option>
                                          ))}
                                        </select>
                                      ) : (
                                        <em className="muted">{field.value || "—"}</em>
                                      )}
                                      {field.factCategory && <small className="muted">grounded in your confirmed fact: {field.factCategory}</small>}
                                    </label>
                                  );
                                })}
                              </div>
                              {proposal.unmatchedRequired.length > 0 && (
                                <p className="stage-note warn"><b>Needs you</b>{proposal.unmatchedRequired.join(", ")} — confirm a fact in Context, then choose it here.</p>
                              )}
                              {proposal.errorSummary && <p className="stage-note error">{proposal.errorSummary}</p>}
                              {editable && (
                                <div className="inline-actions">
                                  <button type="button" className="btn ghost" disabled={!backendConnected} onClick={() => onSaveProposal(proposal)}>Save changes</button>
                                  <button type="button" className="btn" disabled={!backendConnected || proposal.unmatchedRequired.length > 0 || submittingProposalId === proposal._id || formCapability?.available === false} onClick={() => onApproveAndSubmit(proposal)}>
                                    {submittingProposalId === proposal._id ? "Submitting…" : "Approve & submit"}
                                  </button>
                                  <button type="button" className="btn ghost" onClick={() => selectView("profile")}>Add a fact</button>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </section>

                  <section className="panel" aria-label="Submission history">
                    <div className="panel-head"><p className="eyebrow">SUBMISSION HISTORY</p><span className="muted">{(formSubmissions ?? []).length} recorded</span></div>
                    {(formSubmissions ?? []).length === 0 ? (
                      <p className="empty-state">No submissions yet. Every approved submission lands here with its status, time, and screenshot evidence.</p>
                    ) : (
                      <div className="row-list">
                        {(formSubmissions ?? []).map((submission) => (
                          <article className="row-item static" key={submission._id}>
                            <div>
                              <strong>{submission.formTitle}</strong>
                              <em>{hostLabel(submission.url)} · {submission.fieldCount} field{submission.fieldCount === 1 ? "" : "s"} · {submission.submittedAt ? shortDate(submission.submittedAt) : shortDate(submission.createdAt)}</em>
                              {submission.postSubmitExcerpt && <span className="muted">{submission.postSubmitExcerpt.slice(0, 140)}{submission.postSubmitExcerpt.length > 140 ? "…" : ""}</span>}
                              {submission.errorSummary && <span className="muted">{submission.errorSummary}</span>}
                            </div>
                            <div className="inline-actions">
                              <span className={`status-pill status-${submission.status}`}>{submission.status.replace(/_/g, " ")}</span>
                              {submission.evidenceUrl && <a className="source-link" href={submission.evidenceUrl} target="_blank" rel="noreferrer">Evidence screenshot</a>}
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {activeView === "profile" && (
            <div className="view-stack">
              {/* ── Profile header ── */}
              <section className="panel profile-header">
                <div className="panel-head"><p className="eyebrow">YOUR PROFILE</p><span className="muted">what Radar knows about you</span></div>
                <div className="profile-stats">
                  <span><strong>{contextFacts?.filter((f) => ["user_confirmed", "user_corrected"].includes(f.verificationStatus) || f.sourceType === "source_extraction").length ?? 0}</strong> trusted facts</span>
                  <span><strong>{contextFacts?.filter((f) => f.verificationStatus === "unreviewed").length ?? 0}</strong> need review</span>
                  <span><strong>{(dataSources ?? []).length}</strong> sources</span>
                </div>
              </section>

              {/* ── About / Information ── */}
              <section className="panel" aria-label="About">
                <div className="panel-head"><p className="eyebrow">ABOUT</p><span className="muted">who you are</span></div>
                <div className="profile-add-fact">
                  <input className="composer-input" placeholder="Category (e.g. name, role, location)" value={factCategory} onChange={(e) => setFactCategory(e.target.value)} maxLength={60} />
                  <input className="composer-input" placeholder="Value (e.g. Temitope, Full-stack Developer, Lagos)" value={factValue} onChange={(e) => setFactValue(e.target.value)} maxLength={240} />
                  <button type="button" className="btn" disabled={!backendConnected || !factCategory.trim() || !factValue.trim()} onClick={async () => { await addFact({ workspaceId, missionId: null, category: factCategory, value: factValue, sourceType: "user_input", sourceReference: null, confidence: 1, visibility: "workspace" }); setFactCategory(""); setFactValue(""); }}>Add</button>
                </div>
                {(contextFacts ?? []).filter((f) => ["user_input", "user_confirmed", "user_corrected"].includes(f.sourceType) || ["user_confirmed", "user_corrected"].includes(f.verificationStatus)).length === 0 ? (
                  <p className="empty-state">No information yet. Add facts about yourself or upload a source — Radar extracts skills, experience, and preferences automatically.</p>
                ) : (
                  <div className="row-list">
                    {(contextFacts ?? []).filter((f) => ["user_input", "user_confirmed", "user_corrected"].includes(f.sourceType) || ["user_confirmed", "user_corrected"].includes(f.verificationStatus)).slice(0, 10).map((fact) => (
                      <article className="row-item static profile-fact" key={fact._id}>
                        <div className="row-copy">
                          <strong>{fact.category}</strong>
                          <em>{fact.value}</em>
                          <span className="muted">
                            {fact.sourceType === "user_input" ? "added by you" : fact.sourceType === "source_extraction" ? `from ${fact.sourceReference ?? "a source"}` : fact.verificationStatus === "user_corrected" ? "corrected by you" : "confirmed"}
                          </span>
                        </div>
                        <div className="inline-actions">
                          {editingFactId === fact._id ? (
                            <>
                              <input className="composer-input" style={{ maxWidth: 180 }} value={factEditValue} onChange={(e) => setFactEditValue(e.target.value)} maxLength={240} />
                              <button type="button" className="btn ghost" onClick={async () => { await correctFact({ workspaceId, factId: fact._id, value: factEditValue }); setEditingFactId(null); }}>Save</button>
                            </>
                          ) : (
                            <button type="button" className="btn ghost" onClick={() => { setEditingFactId(fact._id); setFactEditValue(fact.value); }}>Edit</button>
                          )}
                          <button type="button" className="btn ghost" onClick={() => deleteFact({ workspaceId, factId: fact._id })}>Remove</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {/* ── Sources ── */}
              <section className="panel" aria-label="Sources">
                <div className="panel-head"><p className="eyebrow">SOURCES</p><span className="muted">files, websites, and snippets Radar reads</span></div>
                <div className="source-tabs" role="tablist" aria-label="Source type">
                  {(["file", "website", "snippet"] as const).map((tab) => (
                    <button key={tab} type="button" role="tab" aria-selected={sourceTab === tab} className={sourceTab === tab ? "active" : ""} onClick={() => setSourceTab(tab)}>
                      {tab === "file" ? "File" : tab === "website" ? "Website" : "Snippet"}
                    </button>
                  ))}
                </div>
                {sourceTab === "file" && (
                  <div className={fileDrag ? "drop-zone dragging" : "drop-zone"} onDragOver={(e) => { e.preventDefault(); setFileDrag(true); }} onDragLeave={() => setFileDrag(false)} onDrop={(e) => { e.preventDefault(); setFileDrag(false); void onUploadFile(e.dataTransfer.files); }}>
                    <input ref={fileInputRef} type="file" accept=".pdf,.doc,.docx,.txt,.md" onChange={(e) => void onUploadFile(e.target.files)} className="visually-hidden" />
                    <button type="button" className="drop-inner" onClick={() => fileInputRef.current?.click()} disabled={!backendConnected || uploadingFile}>
                      <strong>{uploadingFile ? "Reading your file…" : fileDrag ? "Drop to add it" : "Click to choose a file, or drop it here"}</strong>
                      <span>PDF, DOC, DOCX, TXT, MD · up to 20 MB</span>
                    </button>
                  </div>
                )}
                {sourceTab === "website" && (
                  <form className="source-form" onSubmit={(e) => { e.preventDefault(); void onAddWebsite(); }}>
                    <div className="field-pair">
                      <label>URL<input required type="url" placeholder="https://example.com" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} /></label>
                      <label>Title<input placeholder="Optional" value={websiteTitle} onChange={(e) => setWebsiteTitle(e.target.value)} /></label>
                    </div>
                    <div className="field-pair">
                      <label>How deep<select value={websiteMode} onChange={(e) => setWebsiteMode(websiteMode as typeof websiteMode)}><option value="single">Just this page</option><option value="crawl">Crawl linked pages</option><option value="sitemap">Follow the sitemap</option></select></label>
                      {websiteMode === "crawl" && <label>Limit<input type="number" min={1} max={50} value={websitePageLimit} onChange={(e) => setWebsitePageLimit(Number(e.target.value))} /></label>}
                    </div>
                    <button type="submit" className="btn" disabled={!backendConnected || addingWebsite}>{addingWebsite ? "Starting…" : "Add website"}</button>
                    {websiteNotice && <p className="stage-note" role="status">{websiteNotice}</p>}
                  </form>
                )}
                {sourceTab === "snippet" && (
                  <form className="source-form" onSubmit={(e) => { e.preventDefault(); void onAddSnippet(); }}>
                    <label>Title<input required value={snippetTitle} onChange={(e) => setSnippetTitle(e.target.value)} placeholder="e.g. Services I offer" /></label>
                    <label>Text<textarea required rows={3} value={snippetText} onChange={(e) => setSnippetText(e.target.value)} placeholder="Paste anything Radar should know." /></label>
                    <div className="inline-actions">
                      <button type="submit" className="btn" disabled={!backendConnected || addingSnippet}>{addingSnippet ? "Saving…" : "Add snippet"}</button>
                      <span className="muted">{snippetText.length}/20,000</span>
                    </div>
                    {snippetNotice && <p className="stage-note" role="status">{snippetNotice}</p>}
                  </form>
                )}
                {(dataSources ?? []).length > 0 && (
                  <div className="row-list" style={{ marginTop: 12 }}>
                    {(dataSources ?? []).map((source) => (
                      <article className="row-item static" key={source._id}>
                        <div className="row-copy">
                          <strong><span className={`kind-pill kind-${source.kind}`}>{source.kind}</span> {source.title}</strong>
                          <em>{source.summary || source.url || ""}</em>
                          <span className="muted">{source.chunkCount} chunks · {source.pageCount} pages</span>
                          {/* Reading a document and signing the user's name to it are
                              different acts, so attaching is opt-in per document. */}
                          <span className="muted">{source.representationAllowed ? "Radar may attach this to a message you approve" : "Radar may read this, but not attach it"}</span>
                        </div>
                        <div className="inline-actions">
                          <span className={`status-pill status-${source.status}`}>{source.status}</span>
                          <button
                            type="button"
                            className={`btn ghost${source.representationAllowed ? " active" : ""}`}
                            disabled={!backendConnected}
                            onClick={() => void onToggleRepresentation(source._id, !source.representationAllowed)}
                          >
                            {source.representationAllowed ? "✓ Attachable" : "Allow attaching"}
                          </button>
                          {source.kind === "website" && source.status !== "syncing" && <button type="button" className="btn ghost" disabled={!backendConnected || resyncingId === source._id} onClick={() => void onResync(source._id)}>{resyncingId === source._id ? "Syncing…" : "Resync"}</button>}
                          {source.url && <a className="source-link" href={source.url} target="_blank" rel="noreferrer">Open</a>}
                          <button type="button" className="btn ghost" onClick={() => void onRemoveSource(source._id, source.title)}>Remove</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>

              {/* ── AI Context: trusted facts ── */}
              {(contextFacts ?? []).filter((f) => f.sourceType === "source_extraction" && f.verificationStatus !== "user_rejected").length > 0 && (
                <section className="panel" aria-label="Source-backed facts">
                  <div className="panel-head"><p className="eyebrow">SOURCE-BACKED</p><span className="muted">extracted from your sources — Radar uses these automatically</span></div>
                  <div className="row-list">
                    {(contextFacts ?? []).filter((f) => f.sourceType === "source_extraction" && f.verificationStatus !== "user_rejected").map((fact) => (
                      <article className="row-item static profile-fact" key={fact._id}>
                        <div className="row-copy">
                          <strong>{fact.category}</strong>
                          <em>{fact.value}</em>
                          <span className="muted">from {fact.sourceReference ?? "a source"}</span>
                        </div>
                        <div className="inline-actions">
                          {editingFactId === fact._id ? (
                            <>
                              <input className="composer-input" style={{ maxWidth: 180 }} value={factEditValue} onChange={(e) => setFactEditValue(e.target.value)} maxLength={240} />
                              <button type="button" className="btn ghost" onClick={async () => { await correctFact({ workspaceId, factId: fact._id, value: factEditValue }); setEditingFactId(null); }}>Save</button>
                            </>
                          ) : (
                            <button type="button" className="btn ghost" onClick={() => { setEditingFactId(fact._id); setFactEditValue(fact.value); }}>Correct</button>
                          )}
                          <button type="button" className="btn ghost" onClick={() => rejectFact({ workspaceId, factId: fact._id })}>Reject</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {/* ── AI Context: inferences needing review ── */}
              {(contextFacts ?? []).filter((f) => f.verificationStatus === "unreviewed").length > 0 && (
                <section className="panel" aria-label="AI inferences">
                  <div className="panel-head"><p className="eyebrow">AI INFERENCES</p><span className="muted">Radar inferred these — confirm, correct, or reject</span></div>
                  <div className="row-list">
                    {(contextFacts ?? []).filter((f) => f.verificationStatus === "unreviewed").map((fact) => (
                      <article className="row-item static profile-fact profile-fact-inferred" key={fact._id}>
                        <div className="row-copy">
                          <strong>{fact.category}</strong>
                          <em>{fact.value}</em>
                          <span className="muted">inferred by Radar · confidence {Math.round(fact.confidence * 100)}%</span>
                        </div>
                        <div className="inline-actions">
                          <button type="button" className="btn" onClick={() => confirmFact({ workspaceId, factId: fact._id })}>Confirm</button>
                          {editingFactId === fact._id ? (
                            <>
                              <input className="composer-input" style={{ maxWidth: 180 }} value={factEditValue} onChange={(e) => setFactEditValue(e.target.value)} maxLength={240} />
                              <button type="button" className="btn ghost" onClick={async () => { await correctFact({ workspaceId, factId: fact._id, value: factEditValue }); setEditingFactId(null); }}>Save</button>
                            </>
                          ) : (
                            <button type="button" className="btn ghost" onClick={() => { setEditingFactId(fact._id); setFactEditValue(fact.value); }}>Correct</button>
                          )}
                          <button type="button" className="btn ghost" onClick={() => rejectFact({ workspaceId, factId: fact._id })}>Reject</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}

              {/* ── AI Context: rejected ── */}
              {(contextFacts ?? []).filter((f) => f.verificationStatus === "user_rejected").length > 0 && (
                <section className="panel" aria-label="Rejected facts">
                  <div className="panel-head"><p className="eyebrow">REJECTED</p><span className="muted">excluded from all agent reasoning</span></div>
                  <div className="row-list">
                    {(contextFacts ?? []).filter((f) => f.verificationStatus === "user_rejected").map((fact) => (
                      <article className="row-item static profile-fact" key={fact._id} style={{ opacity: 0.5 }}>
                        <div className="row-copy">
                          <strong>{fact.category}</strong>
                          <em>{fact.value}</em>
                          <span className="muted">rejected · {shortDate(fact.updatedAt)}</span>
                        </div>
                        <div className="inline-actions">
                          <button type="button" className="btn ghost" onClick={() => confirmFact({ workspaceId, factId: fact._id })}>Restore</button>
                          <button type="button" className="btn ghost" onClick={() => deleteFact({ workspaceId, factId: fact._id })}>Delete</button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
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
          {navGroups.map((group) => (
            <div className="nav-group" key={group}>
              <p className="nav-section-label">{group}</p>
              {navItems.filter((item) => item.group === group).map((item) => (
                <button key={item.id} type="button" className={activeView === item.id ? "nav-item active" : "nav-item"} onClick={() => selectView(item.id)}>
                  <span className="nav-label"><strong>{item.label}</strong><em>{item.hint}</em></span>
                  {navCounts[item.id] ? <span className="nav-count">{navCounts[item.id]}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="theme-switch mobile-theme" role="radiogroup" aria-label="Theme">
          {themeOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={themeChoice === option.value}
              className={themeChoice === option.value ? "active" : ""}
              onClick={() => setTheme(option.value)}
            >
              <span aria-hidden="true">{option.glyph}</span>{option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
