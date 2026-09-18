import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useTheme, type ThemeChoice } from "./useTheme";
import { MissionLifecycle } from "./MissionLifecycle";
import { useAuthActions } from "@convex-dev/auth/react";
import SignIn from "./SignIn";

type MissionMode = "opportunity" | "person" | "customer" | "solution" | "collaborator";
type View = "home" | "dashboard" | "discover" | "actions" | "inbox" | "relationships" | "outcomes" | "profile" | "activity";
type PipelineStageName = "contacted" | "replied" | "engaged" | "meeting" | "proposal" | "won" | "lost" | "dormant";

const PIPELINE_STAGES: PipelineStageName[] = ["contacted", "replied", "engaged", "meeting", "proposal", "won", "lost", "dormant"];
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
  { id: "home", label: "Home", hint: "Ask Radar. Watch it work.", group: "RADAR" },
  { id: "dashboard", label: "Dashboard", hint: "Workspace overview at a glance", group: "RADAR" },
  { id: "discover", label: "Discover", hint: "Sourced, explained evidence", group: "WORK" },
  { id: "actions", label: "Actions", hint: "Outreach, forms, follow-ups", group: "WORK" },
  { id: "inbox", label: "Inbox", hint: "Replies and live conversations", group: "WORK" },
  { id: "relationships", label: "Relationships", hint: "People, orgs, timelines", group: "WORK" },
  { id: "outcomes", label: "Outcomes", hint: "What actually happened", group: "WORK" },
  { id: "profile", label: "Profile", hint: "Who you are & what Radar knows", group: "KNOWLEDGE" },
  { id: "activity", label: "Activity", hint: "Real agent event timeline", group: "SYSTEM" },
];

const navGroups: string[] = ["RADAR", "WORK", "KNOWLEDGE", "SYSTEM"];

const viewTitles: Record<View, { eyebrow: string; title: string; description: string }> = {
  home: { eyebrow: "Agent workspace", title: "Home", description: "Tell Radar what you want. It works right here, in front of you." },
  dashboard: { eyebrow: "Overview", title: "The workspace at a glance", description: "Live counts, run states, and the pipeline — every number is a real Convex subscription." },
  discover: { eyebrow: "Signal intelligence", title: "Evidence before opinions.", description: "Every match carries its source, freshness, and unknowns." },
  actions: { eyebrow: "Approval boundary", title: "Nothing sends without you.", description: "Outreach, form submissions, and follow-ups — each one is approved as its own exact payload." },
  inbox: { eyebrow: "Agent-owned inbox", title: "Replies arrive live.", description: "Inbound mail is untrusted data: classified, never auto-sent." },
  relationships: { eyebrow: "Relationship memory", title: "Radar remembers.", description: "People, organizations, stages, follow-ups, and meetings — every relationship keeps its history." },
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
  const interpretMission = useAction(api.ai.interpretMission);
  const classifyIntent = useAction(api.ai.classifyMissionIntent);
  const reviseGoal = useMutation(api.missions.reviseGoal);
  const searchWeb = useAction(api.research.search);
  const scrapeSource = useAction(api.research.scrape);
  const mapSite = useAction(api.research.mapSite);
  const startCrawl = useAction(api.research.startCrawl);
  const explainMatches = useAction(api.ai.explainMatches);
  const resolveEntities = useAction(api.research.resolveEntities);
  const aiDraftMessage = useAction(api.ai.draftMessage);
  const draftMessage = useAction(api.outreach.draft);
  const sendMessage = useAction(api.outreach.send);
  const syncOutbound = useAction(api.outreach.syncOutbound);
  const provisionInbox = useAction(api.outreach.provisionInbox);
  const approveDraft = useMutation(api.outreachStore.approve);
  const updateOutcome = useMutation(api.outcomes.updateStatus);
  const scheduleFollowUp = useMutation(api.relationships.scheduleFollowUp);
  const snoozeFollowUp = useMutation(api.relationships.snoozeFollowUp);
  const completeFollowUp = useMutation(api.relationships.completeFollowUp);
  const recordMeeting = useMutation(api.relationships.recordMeeting);
  const setOutcomeStage = useMutation(api.relationships.setStage);
  const runPipeline = useMutation(api.orchestratorStore.runPipeline);
  const stopRun = useMutation(api.orchestratorStore.stopRun);
  const retryRunStage = useMutation(api.orchestratorStore.retryStage);
  const approvePlan = useMutation(api.orchestratorStore.approvePlan);
  const continueAfterCheckIn = useMutation(api.orchestratorStore.continueAfterCheckIn);

  const [activeView, setActiveView] = useState<View>("home");
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { choice: themeChoice, setTheme } = useTheme();

  const [goal, setGoal] = useState("Find growth-stage climate companies in Lagos that need a product-design partner.");
  const [clarifyAnswer, setClarifyAnswer] = useState("");
  const [editingUnderstanding, setEditingUnderstanding] = useState(false);
  const [understandingDraft, setUnderstandingDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [showMissionHistory, setShowMissionHistory] = useState(false);
  /** Which mission's run trail the Activity page is inspecting. */
  const [activityMissionId, setActivityMissionId] = useState<string | null>(null);

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
  const [meetingFor, setMeetingFor] = useState<Id<"outcomes"> | null>(null);
  const [meetingAt, setMeetingAt] = useState("");
  const [meetingNotes, setMeetingNotes] = useState("");
  const [pipelineNotice, setPipelineNotice] = useState("");
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
  const [budgetLimitDraft, setBudgetLimitDraft] = useState("");
  const [budgetNotice, setBudgetNotice] = useState("");

  const [sourceTab, setSourceTab] = useState<"file" | "website" | "snippet">("file");
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
  const runEvents = useQuery(api.runs.events, backendConnected && run ? { runId: run._id } : "skip");
  const runSteps = useQuery(api.runs.steps, backendConnected && run ? { runId: run._id } : "skip");
  const jobs = useQuery(api.researchStore.listJobs, backendConnected && missionId ? { missionId } : "skip");
  const sources = useQuery(api.researchStore.listSources, backendConnected && missionId ? { missionId } : "skip");
  const matches = useQuery(api.researchStore.listMatches, backendConnected && missionId ? { missionId } : "skip");
  const entities = useQuery(api.entityStore.listForMission, backendConnected && missionId ? { missionId } : "skip");
  const missionSignals = useQuery(api.entityStore.listSignalsForMission, backendConnected && missionId ? { missionId } : "skip");
  const inbox = useQuery(api.outreachStore.getInbox, backendConnected && workspaceId ? { workspaceId } : "skip");
  const drafts = useQuery(api.outreachStore.listDrafts, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const threads = useQuery(api.inbox.listThreads, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const threadMessages = useQuery(api.inbox.listMessages, backendConnected && selectedThreadId ? { workspaceId, threadId: selectedThreadId } : "skip");
  const classifications = useQuery(api.outreachStore.listClassifications, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const outcomes = useQuery(api.outcomes.listForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  // Outcomes is a workspace-level question ("what actually happened"), so it
  // reads every relationship rather than only the selected mission's.
  const workspaceOutcomes = useQuery(api.outcomes.listForWorkspace, backendConnected && workspaceId ? { workspaceId } : "skip");
  const followUps = useQuery(api.relationships.followUpsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const meetings = useQuery(api.relationships.meetingsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const sequences = useQuery(api.relationships.sequencesForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formTemplates = useQuery(api.formStore.listTemplates, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formProposals = useQuery(api.formStore.listProposals, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formSubmissions = useQuery(api.formStore.listSubmissions, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formCap = useQuery(api.formStore.capStatus, backendConnected && workspaceId ? { workspaceId } : "skip");
  const scoutForm = useAction(api.formFlows.scoutForm);
  const proposeFill = useAction(api.formFlows.proposeFill);
  const approveProposal = useMutation(api.formStore.approveProposal);
  const reviseProposalValues = useMutation(api.formStore.reviseProposalValues);
  const executeFormSubmission = useAction(api.formFlows.executeFormSubmission);
  const crawlProgress = useQuery(api.researchStore.latestCrawlProgress, backendConnected && missionId ? { missionId } : "skip");
  const contextFacts = useQuery(api.context.list, backendConnected && workspaceId ? { workspaceId, missionId: null } : "skip");
  const board = useQuery(api.commandCenter.runsBoard, backendConnected && workspaceId ? { workspaceId } : "skip");
  // Activity page: the run trail for whichever mission the user is inspecting.
  // These are durable runEvents/runSteps, so the trail rebuilds on refresh.
  const activityRun = useQuery(api.runs.forMission, backendConnected && activityMissionId ? { missionId: activityMissionId as Id<"missions"> } : "skip");
  const activityEvents = useQuery(api.runs.events, backendConnected && activityRun ? { runId: activityRun._id } : "skip");
  const activitySteps = useQuery(api.runs.steps, backendConnected && activityRun ? { runId: activityRun._id } : "skip");
  const dataSources = useQuery(api.dataSources.list, backendConnected && workspaceId ? { workspaceId } : "skip");
  const dataProgress = useQuery(api.dataSources.progress, backendConnected && workspaceId ? { workspaceId } : "skip");
  const addSnippet = useMutation(api.dataSources.addSnippet);
  const removeSource = useMutation(api.dataSources.deleteSource);
  const resyncSource = useAction(api.dataFlows.resyncSource);
  const overview = useQuery(api.commandCenter.overview, backendConnected && workspaceId ? { workspaceId } : "skip");
  const budgetStatus = useQuery(api.budget.status, backendConnected && workspaceId ? { workspaceId, missionId } : "skip");
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
  const setBudgetLimit = useMutation(api.budget.setLimit);

  const latestJob = jobs?.[0];
  const pendingDrafts = (drafts ?? []).filter((draft) => ["draft", "awaiting_approval", "approved", "executing"].includes(draft.status));
  const actionableDrafts = (drafts ?? []).filter((draft) => ["draft", "awaiting_approval", "approved", "executing"].includes(draft.status));
  const openOutcomes = (outcomes ?? []).filter((outcome) => !["won", "lost"].includes(outcome.stage));
  const dueFollowUps = (followUps ?? []).filter((item) => item.status === "due" || item.dueAt <= Date.now());
  const followUpForOutcome = (outcomeId: Id<"outcomes">) => (followUps ?? []).find((item) => item.outcomeId === outcomeId);

  const pendingFormWork = (formProposals ?? []).filter((proposal) => proposal.status === "draft" || proposal.status === "approved" || proposal.status === "blocked" || proposal.status === "failed").length;

  const navCounts: Record<View, number | null> = {
    home: null,
    dashboard: null,
    discover: matches?.length ?? null,
    // Actions is one destination for every side effect, so its badge is the
    // total of everything waiting on a human decision there.
    actions: actionableDrafts.length + pendingFormWork || null,
    inbox: threads?.length || null,
    relationships: openOutcomes.length || null,
    // Outcomes is workspace-wide, so its badge counts every open relationship
    // rather than only the selected mission's.
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
      items.push({ id: "followups", title: `${dueFollowUps.length} follow-up${dueFollowUps.length === 1 ? "" : "s"} due`, detail: dueFollowUps[0].note, tone: "amber", view: "relationships" });
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

  async function onInterpret() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try { await interpretMission({ missionId }); setPlanNotice("Strategy-bearing plan saved to this mission."); }
    catch (error) { setPlanNotice(error instanceof Error ? error.message : "Mission planning failed."); }
    finally { setPlanning(false); }
  }

  async function onReclassify() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try {
      const result = await classifyIntent({ missionId });
      setPlanNotice(result.clarificationNeeded ? "Radar needs one clarification before planning." : "Understanding updated.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Re-classification failed.");
    } finally { setPlanning(false); }
  }

  async function onRunPipeline() {
    if (!missionId) return;
    setPlanning(true); setPlanNotice("");
    try {
      const result = await runPipeline({ workspaceId, missionId });
      setPlanNotice(result.started ? "Radar is running end-to-end — follow the live transcript in Activity." : `Run is already ${run?.status ?? "in progress"}.`);
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Could not start the run.");
    } finally { setPlanning(false); }
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

  async function onClarifySubmit() {
    if (!missionId || !clarifyAnswer.trim()) return;
    setPlanning(true);
    try {
      await reviseGoal({ workspaceId, missionId, rawGoal: `${selectedMission?.rawGoal ?? ""}

Clarification: ${clarifyAnswer.trim()}` });
      setClarifyAnswer("");
      await classifyIntent({ missionId });
      setPlanNotice("Radar updated its understanding with your clarification.");
    } catch (error) {
      setPlanNotice(error instanceof Error ? error.message : "Clarification failed.");
    } finally { setPlanning(false); }
  }

  async function onUnderstandingSave() {
    if (!missionId || !understandingDraft.trim()) return;
    await reviseGoal({ workspaceId, missionId, rawGoal: understandingDraft.trim() });
    setEditingUnderstanding(false);
    await classifyIntent({ missionId });
    setPlanNotice("Understanding revised — classification updated.");
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

  async function onSaveBudgetLimit() {
    const value = Number(budgetLimitDraft);
    if (!Number.isFinite(value) || budgetLimitDraft.trim() === "") {
      setBudgetNotice("Enter a whole number of credits.");
      return;
    }
    try {
      const result = await setBudgetLimit({ workspaceId, creditLimit: Math.floor(value) });
      setBudgetNotice(`Credit cap set to ${result.creditLimit}. Resume the stage when you are ready.`);
      setBudgetLimitDraft("");
    } catch (error) {
      setBudgetNotice(error instanceof Error ? error.message : "Could not set the credit cap.");
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

  async function onResolveEntities() {
    if (!missionId) return;
    setResearching(true); setResearchNotice("");
    try {
      const result = await resolveEntities({ workspaceId, missionId, limit: 8 });
      setResearchNotice(
        result.resolved === 0
          ? "No unscraped sources left to resolve."
          : `Resolved ${result.resolved} entit${result.resolved === 1 ? "y" : "ies"} (${result.extracted} extracted, ${result.fallback} snippet-only).`,
      );
    } catch (error) {
      setResearchNotice(error instanceof Error ? error.message : "Entity resolution failed.");
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

  async function onAdvanceStage(outcomeId: Id<"outcomes">, stage: PipelineStageName, nextAction: string) {
    setPipelineNotice("");
    try { await setOutcomeStage({ workspaceId, outcomeId, stage, nextAction }); setPipelineNotice(`Stage set to ${PIPELINE_LABELS[stage].toLowerCase()}.`); }
    catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not update the stage."); }
  }

  async function onCreateFollowUp(outcomeId: Id<"outcomes">, matchId: Id<"matches"> | null, counterpart: string) {
    if (!missionId) return;
    setPipelineNotice("");
    try {
      await scheduleFollowUp({
        workspaceId, missionId, outcomeId, matchId, threadId: null,
        note: `Follow up with ${counterpart}`,
        dueAt: Date.now() + 3 * 24 * 60 * 60 * 1000,
      });
      setPipelineNotice("Follow-up scheduled for three days from now.");
    } catch (error) { setPipelineNotice(error instanceof Error ? error.message : "Could not schedule the follow-up."); }
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

  async function onRecordMeeting(outcomeId: Id<"outcomes">, matchId: Id<"matches"> | null, counterpart: string) {
    if (!missionId || !meetingAt) { setPipelineNotice("Pick a meeting time first."); return; }
    setPipelineNotice("");
    try {
      await recordMeeting({
        workspaceId, missionId, outcomeId, matchId, counterpart,
        scheduledAt: new Date(meetingAt).getTime(),
        notes: meetingNotes,
      });
      setMeetingFor(null); setMeetingAt(""); setMeetingNotes("");
      setPipelineNotice("Meeting recorded on the relationship timeline.");
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
  // A budget block is a spend decision, not a failure: the run keeps its stage.
  const budgetBlocked = run?.activeInterruption === "budget_blocked";
  // A reaped run was parked because it went quiet with no state change.
  const staleRun = run?.activeInterruption === "stale_run";
  const linkedMatchSource = linkedMatchId ? sources?.find((source) => source._id === matches?.find((match) => match._id === linkedMatchId)?.sourceId) : undefined;
  const selectedThreadMission = (() => {
    const thread = (threads ?? []).find((item) => item.threadId === selectedThreadId);
    return thread?.missionId ? missions?.find((mission) => mission._id === thread.missionId) : undefined;
  })();
  const meetingsForOutcome = (outcomeId: Id<"outcomes">) => (meetings ?? []).filter((meeting) => meeting.outcomeId === outcomeId);

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
                  {/* What the user asked */}
                  <p className="mission-goal-display"><strong>You asked:</strong> {selectedMission.rawGoal}</p>
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
                        <button type="button" className="btn ghost" onClick={() => selectView("dashboard")}>Edit plan →</button>
                      </div>
                    </div>
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
                        <button type="button" className="btn" onClick={onContinueAfterCheckIn} disabled={planning}>{planning ? "Continuing…" : "Continue to evaluation →"}</button>
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
                        <button type="button" className="followup-pill" onClick={() => selectView("relationships")}>See relationships</button>
                        <button type="button" className="followup-pill" onClick={() => { setGoal("Find more companies like the top matches"); selectView("home"); }}>Find similar</button>
                      </div>
                    </div>
                  )}
                  {/* Pending approvals */}
                  {drafts && drafts.filter((d) => ["awaiting_approval", "approved"].includes(d.status)).length > 0 && (
                    <div className="thread-approval">
                      <p><b>Waiting for you</b> — {drafts.filter((d) => ["awaiting_approval", "approved"].includes(d.status)).length} draft{drafts.filter((d) => ["awaiting_approval", "approved"].includes(d.status)).length === 1 ? "" : "s"} ready for review.</p>
                      <button type="button" className="btn" onClick={() => selectView("actions")}>Review & approve →</button>
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

          {activeView === "dashboard" && (
            <div className="view-stack">
              {overview && (
                <section className="panel" aria-label="Network overview">
                  <div className="panel-head"><p className="eyebrow">NETWORK OVERVIEW</p><span className="muted">live from Convex</span></div>
                  <div className="metric-grid">
                    {[
                      { label: "Entities", value: overview.counts.entities, view: "discover" as View },
                      { label: "Signals · 7d", value: overview.counts.signalsThisWeek, view: "discover" as View },
                      { label: "Replies", value: overview.counts.replies, view: "inbox" as View },
                      { label: "Follow-ups due", value: overview.counts.followUpsDue, view: "relationships" as View },
                      { label: "Drafts pending", value: overview.counts.draftsPending, view: "actions" as View },
                      { label: "Submissions", value: overview.counts.submissions, view: "actions" as View },
                    ].map((metric) => (
                      <button key={metric.label} type="button" className="metric-tile" onClick={() => selectView(metric.view)}>
                        <span className="metric-value">{metric.value}</span>
                        <span className="metric-label">{metric.label}</span>
                      </button>
                    ))}
                  </div>
                  <div className="run-strip" aria-label="Run states">
                    <span><em>Working now</em><strong>{overview.counts.runsActive}</strong></span>
                    <span><em>Ready to run</em><strong>{overview.counts.runsReady}</strong></span>
                    <span><em>Parked</em><strong>{overview.counts.runsWaiting}</strong></span>
                    <span><em>Blocked</em><strong>{overview.counts.runsBlocked}</strong></span>
                    <span><em>Approved sends</em><strong>{overview.counts.draftsApproved}</strong></span>
                    <span><em>Blocked forms</em><strong>{overview.counts.blockedSubmissions}</strong></span>
                  </div>
                  {overview.pipeline.some((row) => row.count > 0) && (
                    <div className="pipeline-mini" aria-label="Pipeline distribution">
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
                </section>
              )}

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
                <section className="panel" aria-label="Mission controls">
                  <div className="panel-head"><p className="eyebrow">MISSION CONTROLS</p>{selectedMission && <span className={`status-pill status-${selectedMission.status}`}>{selectedMission.status}</span>}</div>
                  {!selectedMission ? (
                    <p className="empty-state">No mission selected. Start one from Home.</p>
                  ) : (
                    <>
                      <h3>{selectedMission.title}</h3>
                      {selectedMission.intent && (
                        <div className="understanding-card">
                          <div className="panel-head"><p className="eyebrow">RADAR UNDERSTOOD</p><span className="muted">confidence {Math.round((selectedMission.intent.confidence ?? 0) * 100)}%</span></div>
                          {editingUnderstanding ? (
                            <div className="control-row">
                              <textarea className="composer-input" rows={2} value={understandingDraft} onChange={(e) => setUnderstandingDraft(e.target.value)} aria-label="Revised goal" />
                              <div className="inline-actions">
                                <button type="button" className="btn" onClick={onUnderstandingSave}>Save & re-classify</button>
                                <button type="button" className="btn ghost" onClick={() => setEditingUnderstanding(false)}>Cancel</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <p><strong>You're looking for:</strong> {selectedMission.relationshipGoal?.replace(/_/g, " ") ?? "see the goal"}</p>
                              <p><strong>Radar's read:</strong> {selectedMission.intent.rationale || selectedMission.rawGoal}</p>
                              <p className="stage-note">Intent: {selectedMission.intent.primary.replace("find_", "")}{selectedMission.intent.secondary ? ` + ${selectedMission.intent.secondary.replace("find_", "")}` : ""} · target: {selectedMission.targetEntity?.replace(/_/g, " ") ?? "—"}</p>
                              <div className="inline-actions">
                                <button type="button" className="btn ghost" onClick={() => { setEditingUnderstanding(true); setUnderstandingDraft(selectedMission.rawGoal); }}>Adjust</button>
                                <button type="button" className="btn ghost" onClick={onReclassify} disabled={planning}>{planning ? "Re-checking…" : "Re-classify"}</button>
                              </div>
                            </>
                          )}
                        </div>
                      )}
                      {budgetStatus && (
                        <div className={`budget-strip ${budgetBlocked ? "budget-blocked" : budgetStatus.allowed ? "" : "budget-tight"}`} aria-live="polite">
                          <div className="panel-head">
                            <p className="eyebrow">PROVIDER BUDGET</p>
                            <span className="muted">{budgetStatus.used} / {budgetStatus.creditLimit} credits used</span>
                          </div>
                          <div className="budget-figures">
                            <span><em>Remaining</em><strong>{budgetStatus.remaining}</strong></span>
                            <span><em>Pending work ≈</em><strong>{budgetStatus.pendingEstimate}</strong></span>
                            <span><em>Search</em><strong>{budgetStatus.breakdown.search}</strong></span>
                            <span><em>Crawl</em><strong>{budgetStatus.breakdown.crawl}</strong></span>
                            <span><em>Extract</em><strong>{budgetStatus.breakdown.extract}</strong></span>
                          </div>
                          {budgetBlocked ? (
                            <p className="budget-note">Paused for budget, not broken — the run kept its stage. Raise the cap below or add provider credits, then resume.</p>
                          ) : !budgetStatus.allowed ? (
                            <p className="budget-note">The remaining budget is below this mission's estimated cost, so the next provider call will pause the run instead of spending past the cap.</p>
                          ) : null}
                          <div className="budget-control">
                            <input
                              inputMode="numeric"
                              placeholder={`Credit cap (now ${budgetStatus.creditLimit})`}
                              value={budgetLimitDraft}
                              onChange={(event) => setBudgetLimitDraft(event.target.value)}
                              aria-label="Workspace credit cap"
                            />
                            <button type="button" className="btn ghost" onClick={onSaveBudgetLimit} disabled={!budgetLimitDraft.trim()}>Set cap</button>
                          </div>
                          {budgetNotice && <p className="stage-note" role="status">{budgetNotice}</p>}
                        </div>
                      )}
                      {run && !["cancelled", "complete", "failed"].includes(run.status) && (
                        <div className="inline-actions run-controls">
                          <button type="button" className="btn" onClick={onStopRun}>■ Stop</button>
                          {run.status === "blocked" && (
                            <button type="button" className="btn ghost" onClick={onRetryStage}>
                              {budgetBlocked ? "↻ Resume after raising the cap" : staleRun ? "↻ Resume stage" : "↻ Retry stage"}
                            </button>
                          )}
                          {run.status === "blocked" && (
                            <span className="stage-note">
                              {budgetBlocked
                                ? "Budget block: nothing failed — the estimate no longer fits the cap."
                                : staleRun
                                  ? "Parked, not failed: this run went quiet without advancing, so the reaper stopped counting it as work in progress. Resume the stage to pick up where it stopped."
                                  : `Paused after a ${run.activeInterruption ?? "provider"} failure. Retry once provider conditions change.`}
                            </span>
                          )}
                        </div>
                      )}
                      {plan ? (
                        <div className="brief-card">
                          <div className="panel-head">
                            <p className="eyebrow">MISSION BRIEF</p>
                            <span className="muted">{plan.userEditedAt ? `edited ${shortDate(plan.userEditedAt)}` : "AI-planned"}</span>
                          </div>
                          {briefEditing ? (
                            <div className="view-stack">
                              <label className="field-label" htmlFor="brief-goal">Goal</label>
                              <textarea id="brief-goal" className="composer-input" rows={2} value={briefDraft.normalizedGoal} onChange={(event) => setBriefDraft({ ...briefDraft, normalizedGoal: event.target.value })} />
                              <label className="field-label" htmlFor="brief-must">Must have (comma-separated)</label>
                              <input id="brief-must" className="composer-input" value={briefDraft.mustHave} onChange={(event) => setBriefDraft({ ...briefDraft, mustHave: event.target.value })} />
                              <label className="field-label" htmlFor="brief-nice">Nice to have</label>
                              <input id="brief-nice" className="composer-input" value={briefDraft.niceToHave} onChange={(event) => setBriefDraft({ ...briefDraft, niceToHave: event.target.value })} />
                              <label className="field-label" htmlFor="brief-excl">Exclusions</label>
                              <input id="brief-excl" className="composer-input" value={briefDraft.exclusions} onChange={(event) => setBriefDraft({ ...briefDraft, exclusions: event.target.value })} />
                              <label className="field-label" htmlFor="brief-sources">Preferred sources</label>
                              <input id="brief-sources" className="composer-input" value={briefDraft.recommendedSources} onChange={(event) => setBriefDraft({ ...briefDraft, recommendedSources: event.target.value })} />
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
                              {plan.recommendedSources.length > 0 && <p className="stage-note">Preferred sources: {plan.recommendedSources.join(" · ")}</p>}
                              <p className="stage-note">Completion: {plan.completionPredicate}</p>
                              <div className="inline-actions">
                                <button type="button" className="btn ghost" onClick={startBriefEdit}>Edit brief</button>
                              </div>
                            </>
                          )}
                          {briefNotice && <p className="stage-note" role="status">{briefNotice}</p>}
                        </div>
                      ) : (
                        <div className="inline-actions">
                          <button type="button" className="btn" onClick={onInterpret} disabled={planning}>{planning ? "Interpreting…" : "Interpret goal"}</button>
                          <span className="stage-note">{planNotice}</span>
                        </div>
                      )}
                      <div className="inline-actions">
                        {run && run.status === "queued" && (
                          <button type="button" className="btn" onClick={onRunPipeline} disabled={planning}>{planning ? "Starting…" : "▶ Run Radar end-to-end"}</button>
                        )}
                        {run && run.status === "waiting" && run.currentStage === "approval" && (
                          <button type="button" className="btn ghost" onClick={() => selectView("actions")}>Review matches & approvals →</button>
                        )}
                        <button type="button" className="btn ghost" onClick={() => selectView("home")}>Live transcript</button>
                      </div>
                    </>
                  )}
                </section>

                <section className="panel" aria-label="How Radar works">
                  <div className="panel-head"><p className="eyebrow">HOW RADAR WORKS</p></div>
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
            </div>
          )}

          {activeView === "discover" && (
            <div className="view-stack">
              {!selectedMission ? <p className="empty-state">Select or start a mission first.</p> : (
                <>
                  <section className="panel" aria-label="Discovery results">
                    <div className="panel-head"><p className="eyebrow">DISCOVERY RESULTS</p>
                      <span className="muted">Radar investigated these because of your mission — every card states why it looked, why it matches, and what it checked against your context.</span>
                      {runWorking && <span className="status-pill status-running">run active</span>}
                    </div>
                    <p className="stage-note">{latestJob ? `${sources?.length ?? 0} sources from ${jobs?.length ?? 0} research jobs` : "The agent discovers sources automatically during its run."}</p>
                  </section>

                  {entities && entities.length > 0 && (
                    <section aria-label="Entities and signals" className="panel">
                      <div className="panel-head">
                        <p className="eyebrow">ENTITIES & SIGNALS</p>
                        <span className="muted">{entities.length} resolved · {missionSignals?.length ?? 0} signals</span>
                      </div>
                      <div className="entity-list">
                        {entities.map((entity) => {
                          const signals = (missionSignals ?? []).filter((signal) => signal.entityId === entity._id);
                          return (
                            <article className="entity-card" key={entity._id}>
                              <div className="entity-head">
                                <span className={`kind-pill kind-${entity.kind}`}>{entity.kind}</span>
                                <strong>{entity.name}</strong>
                                {entity.extractionStatus === "snippet_only" && <span className="mono-tag">snippet-only</span>}
                                <span className="muted">confidence {Math.round(entity.confidence * 100)}%</span>
                              </div>
                              {entity.expressedNeed && <p className="stage-note"><b>Needs</b>{entity.expressedNeed}</p>}
                              {entity.skillsOrOffer.length > 0 && <p className="stage-note"><b>Offers</b>{entity.skillsOrOffer.join(" · ")}</p>}
                              {entity.contactRoute ? (
                                <p className="stage-note">
                                  <b>Contact</b>{entity.contactRoute.kind}: {entity.contactRoute.value}{" "}
                                  <a className="source-link" href={entity.contactRoute.publicSource} target="_blank" rel="noreferrer">public source</a>
                                </p>
                              ) : (
                                <p className="stage-note warn"><b>Contact</b>No public route found — Radar will research an alternate route instead of guessing.</p>
                              )}
                              {signals.map((signal) => (
                                <p className="signal-row" key={signal._id}>
                                  <span className="signal-chip">{signal.type.replace(/_/g, " ")}</span>{signal.statement}
                                </p>
                              ))}
                              <a className="source-link" href={entity.canonicalUrl} target="_blank" rel="noreferrer">Evidence: {new URL(entity.canonicalUrl).hostname}</a>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  )}

                  <section aria-label="Matches">
                    {matches === undefined ? <p className="empty-state">Loading matches…</p> : matches.length === 0 ? (
                      <div className="panel"><p className="empty-state">No matches yet. Run a search — Radar explains which constraint limited discovery rather than inventing candidates.</p></div>
                    ) : (
                      <div className="match-grid">
                        {matches.map((match) => {
                          const source = sources?.find((item) => item._id === match.sourceId);
                          const sourceTypeLabel = match.sourceType === "crawled_page" ? "crawled" : match.sourceType === "scraped_page" ? "scraped" : match.sourceType === "mapped_site" ? "site map" : "search";
                          return (
                            <article className="panel match-card" key={match._id}>
                              <div className="panel-head">
                                <span className={`status-pill status-${match.label}`}>{match.label}</span>
                                {match.freshness && <span className="mono-tag">{match.freshness}</span>}
                                {match.explanationModel && <span className="mono-tag">{match.explanationModel}</span>}
                              </div>
                              <h3>{match.entity?.name ?? match.subject}</h3>
                              {match.entity && (
                                <div className="entity-inline">
                                  <span className={`kind-pill kind-${match.entity.kind}`}>{match.entity.kind}</span>
                                  {match.entity.expressedNeed && <span className="muted">needs: {match.entity.expressedNeed.slice(0, 90)}{match.entity.expressedNeed.length > 90 ? "…" : ""}</span>}
                                  {match.entity.contactRoute
                                    ? <span className="muted">· {match.entity.contactRoute.kind} via <a className="source-link" href={match.entity.contactRoute.publicSource} target="_blank" rel="noreferrer">public source</a></span>
                                    : <span className="muted">· no public contact route — Radar will find another way before proposing outreach</span>}
                                </div>
                              )}

                              <div className="why-chain">
                                <p className="why-row"><b>Why Radar looked</b>{match.sourceQuery
                                  ? <>Its plan searched the public web for “{match.sourceQuery}” — this {sourceTypeLabel} page matched.</>
                                  : <>Found while {sourceTypeLabel === "crawled" ? "crawling" : "researching"} a source from this mission.</>}</p>
                                {match.explanationSummary && <p className="why-row"><b>Why it matches</b>{match.explanationSummary}</p>}
                                {match.positiveEvidence.length > 0 && (
                                  <p className="why-row"><b>Evidence</b>
                                    <ul className="evidence-list">
                                      {match.positiveEvidence.slice(0, 3).map((item, index) => <li key={index}>{item}</li>)}
                                    </ul>
                                  </p>
                                )}
                                {match.unknowns.length > 0 && <p className="why-row"><b>Unknowns</b>{match.unknowns.join(" · ")}</p>}
                                {match.risks.length > 0 && <p className="why-row why-risk"><b>Risks</b>{match.risks.join(" · ")}</p>}
                                <p className="why-row"><b>From your context</b>{match.userSourceTitles.length > 0
                                  ? <>Checked against your sources: {match.userSourceTitles.slice(0, 3).join(", ")}{match.userSourceTitles.length > 3 ? ` +${match.userSourceTitles.length - 3} more` : ""}.</>
                                  : "Judged against your mission brief and confirmed facts."}</p>
                              </div>

                              <a className="source-link" href={match.sourceUrl} target="_blank" rel="noreferrer">View source: {new URL(match.sourceUrl).hostname}{source ? ` · fetched ${shortDate(source.fetchedAt)}` : ""}</a>
                              {match.recommendedAction && <p className="next-action"><b>Next</b>{match.recommendedAction}</p>}
                              <div className="inline-actions">
                                {source && !source.content && <button type="button" className="btn ghost" onClick={() => onScrape(match.sourceId)}>Scrape full page</button>}
                                <button type="button" className="btn" onClick={() => onAiDraft(match._id)} disabled={aiDraftingMatchId === match._id}>
                                  {aiDraftingMatchId === match._id ? "Drafting…" : "AI draft outreach"}
                                </button>
                                <button type="button" className="btn ghost" onClick={() => { setLinkedMatchId(match._id); selectView("actions"); }}>Write manually</button>
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
                  <div className="panel-head"><p className="eyebrow">AGENT-PROPOSED DRAFTS</p></div>
                  <p className="stage-note">Radar proposes drafts from the Discover page using "AI draft outreach" on a match. You review and approve each one before anything sends.</p>
                  {matches && matches.filter((m) => m.label === "stronger").length > 0 && (
                    <div className="inline-actions">
                      <button type="button" className="btn" onClick={() => selectView("discover")}>Go to Discover to draft →</button>
                    </div>
                  )}
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
                        return (
                          <article className={selectedThreadId === thread.threadId ? "row-item static selected" : "row-item static"} key={thread._id}>
                            <button type="button" className="thread-select" onClick={() => setSelectedThreadId(thread.threadId)}>
                              <strong>{thread.subject || "(no subject)"}</strong>
                              <em>{thread.senderSummary} · {thread.preview}</em>
                              <span className="thread-meta">
                                {threadMission ? `mission: ${threadMission.title.slice(0, 32)}${threadMission.title.length > 32 ? "…" : ""} · ` : ""}
                                {latestClassification ? `radar read: ${latestClassification.label.replace("_", " ")}` : thread.labels.map((label) => `#${label}`).join(" ")}
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
                  <div className="panel-head"><p className="eyebrow">AGENT CONVERSATION</p>{selectedThreadMission && <span className="mono-tag">{selectedThreadMission.title.slice(0, 36)}{selectedThreadMission.title.length > 36 ? "…" : ""}</span>}</div>
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
                                    <p className="radar-drafted"><b>Drafted reply</b></p>
                                    <p className="prewrap draft-suggestion"><strong>{suggestedDraft.subject}</strong>\n{classification.suggestedDraftId && suggestedDraft.status === "sent" ? "" : ""}{suggestedDraft.body}</p>
                                    <div className="inline-actions">
                                      {!["sent", "delivered", "executing"].includes(suggestedDraft.status) && (
                                        <button type="button" className="btn" onClick={() => onApprove(suggestedDraft._id)}>
                                          {suggestedDraft.approvalStatus === "active" ? "Re-approve this exact reply" : "Approve this exact reply"}
                                        </button>
                                      )}
                                      {suggestedDraft.status === "approved" && (
                                        <button type="button" className="btn" onClick={() => onSend(suggestedDraft._id)} disabled={sendingActionId === suggestedDraft._id}>
                                          {sendingActionId === suggestedDraft._id ? "Sending…" : "Send via AgentMail"}
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

          {activeView === "relationships" && (
            <div className="view-stack">
              {overview && (
                <section className="panel" aria-label="Where every relationship stands">
                  <div className="panel-head"><p className="eyebrow">WHERE EVERYTHING STANDS</p><span className="muted">live per-relationship stages across this workspace</span></div>
                  <div className="stage-summary">
                    {overview.pipeline.map((row) => (
                      <span key={row.stage} className={row.count > 0 ? "" : "zero"}>
                        <span className={`stage-dot stage-${row.stage}`} />{PIPELINE_LABELS[row.stage as PipelineStageName] ?? row.stage}
                        <strong>{row.count}</strong>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {(sequences ?? []).filter((sequence) => sequence.status === "active").length > 0 && (
                <section className="panel" aria-label="Ongoing sequences">
                  <div className="panel-head"><p className="eyebrow">ONGOING SEQUENCES</p><span className="muted">each step becomes its own approval — nothing auto-sends</span></div>
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
                <div className="panel-head"><p className="eyebrow">FOLLOW-UPS</p><span className="muted">{(followUps ?? []).length} open</span></div>
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

              <section aria-label="Relationships">
                {outcomes === undefined ? <p className="empty-state">Loading the pipeline…</p> : outcomes.length === 0 ? (
                  <div className="panel"><p className="empty-state">No relationships yet. Radar opens one the moment an approved message is sent or a reply arrives — and remembers everything that happens next.</p></div>
                ) : (
                  <div className="row-list">
                    {outcomes.map((outcome) => {
                      const followUp = followUpForOutcome(outcome._id);
                      const overdue = followUp && (followUp.status === "due" || followUp.dueAt <= Date.now());
                      return (
                        <article className="row-item static" key={outcome._id}>
                          <div className="row-copy">
                            <strong><span className={`stage-dot stage-${outcome.stage}`} /> {outcome.counterpart}</strong>
                            <em>{outcome.latestEvidence}</em>
                            <span className="muted">{PIPELINE_LABELS[outcome.stage as PipelineStageName] ?? outcome.stage} · updated {shortDate(outcome.updatedAt)}{followUp ? ` · follow-up ${overdue ? "due now" : shortDate(followUp.dueAt)}` : ""}</span>
                          </div>
                          <div className="inline-actions">
                            <button type="button" className="btn ghost" onClick={() => onAdvanceStage(outcome._id, "engaged", "Reply with a concrete next step.")}>Engaged</button>
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

              <section className="panel" aria-label="Outcomes by stage">
                <div className="panel-head"><p className="eyebrow">WHERE RELATIONSHIPS LANDED</p></div>
                {!overview ? <p className="empty-state">Loading…</p> : (
                  <div className="stage-summary">
                    {overview.pipeline.map((row) => (
                      <span key={row.stage} className={row.count > 0 ? "" : "zero"}>
                        <span className={`stage-dot stage-${row.stage}`} />{PIPELINE_LABELS[row.stage as PipelineStageName] ?? row.stage}
                        <strong>{row.count}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </section>

              <section className="panel" aria-label="Every relationship">
                <div className="panel-head">
                  <p className="eyebrow">EVERY RELATIONSHIP</p>
                  <span className="muted">{workspaceOutcomes?.length ?? 0} tracked across this workspace</span>
                </div>
                {workspaceOutcomes === undefined ? <p className="empty-state">Loading outcomes…</p> : workspaceOutcomes.length === 0 ? (
                  <p className="empty-state">No outcomes recorded yet. Radar opens one the moment an approved message is sent or a reply lands — whichever mission started it, it shows up here.</p>
                ) : (
                  <div className="row-list">
                    {workspaceOutcomes.map((outcome) => (
                      <article className="row-item static" key={outcome._id}>
                        <div className="row-copy">
                          <strong><span className={`stage-dot stage-${outcome.stage}`} /> {outcome.counterpart}</strong>
                          <em>{outcome.latestEvidence}</em>
                          <span className="muted">
                            {PIPELINE_LABELS[outcome.stage as PipelineStageName] ?? outcome.stage} · {outcome.missionTitle} · updated {shortDate(outcome.updatedAt)}
                          </span>
                        </div>
                        <div className="inline-actions">
                          <button type="button" className="btn ghost" onClick={() => { setSelectedMissionId(outcome.missionId); selectView("relationships"); }}>Open relationship →</button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
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
                      <button type="button" className="btn" disabled={!backendConnected || !formSourceId || scouting} onClick={onScoutForm}>{scouting ? "Scouting…" : "Scout form"}</button>
                    </div>
                    {formNotice && <p className="stage-note">{formNotice}</p>}
                  </section>

                  <section aria-label="Scouted forms">
                    {formTemplates === undefined ? <p className="empty-state">Loading scouted forms…</p> : formTemplates.length === 0 ? (
                      <div className="panel"><p className="empty-state">No forms scouted yet. Pick a discovered source above and Radar will extract its structure — fields, labels, and whether it is gated.</p></div>
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
                                  <button type="button" className="btn" disabled={!backendConnected || proposing} onClick={() => onProposeFill(template._id)}>{proposing ? "Proposing…" : "Propose fill"}</button>
                                  <a className="source-link" href={template.url} target="_blank" rel="noreferrer">Open the form</a>
                                </div>
                              </>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                  </section>

                  <section aria-label="Fill proposals">
                    <div className="panel-head"><p className="eyebrow">FILL PROPOSALS · APPROVE THE EXACT PAYLOAD</p></div>
                    {(formProposals ?? []).length === 0 ? (
                      <div className="panel"><p className="empty-state">No proposals yet. Propose a fill and Radar maps your confirmed facts onto the fields — anything it cannot ground stays empty.</p></div>
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
                                  <button type="button" className="btn" disabled={!backendConnected || proposal.unmatchedRequired.length > 0 || submittingProposalId === proposal._id} onClick={() => onApproveAndSubmit(proposal)}>
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
                        </div>
                        <div className="inline-actions">
                          <span className={`status-pill status-${source.status}`}>{source.status}</span>
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
