import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { useTheme, type ThemeChoice } from "./useTheme";
import { MissionLifecycle } from "./MissionLifecycle";

type MissionMode = "opportunity" | "person" | "customer" | "solution" | "collaborator";
type View = "home" | "dashboard" | "discover" | "outreach" | "inbox" | "outcomes" | "forms" | "context" | "sources" | "activity";
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

const navItems: { id: View; label: string; hint: string }[] = [
  { id: "home", label: "Home", hint: "Ask Radar. Watch it work." },
  { id: "dashboard", label: "Dashboard", hint: "Workspace overview & how it works" },
  { id: "discover", label: "Discover", hint: "Sourced, explained matches" },
  { id: "outreach", label: "Outreach", hint: "Draft, approve, send" },
  { id: "inbox", label: "Inbox", hint: "Live replies and threads" },
  { id: "outcomes", label: "Pipeline", hint: "Relationship stages" },
  { id: "forms", label: "Forms", hint: "Approval-bound submissions" },
  { id: "sources", label: "Data sources", hint: "Files, sites, and snippets Radar reads" },
  { id: "context", label: "Context", hint: "Your profile facts Radar may use" },
  { id: "activity", label: "Activity", hint: "The run's truthful trail" },
];

const viewTitles: Record<View, { eyebrow: string; title: string; description: string }> = {
  home: { eyebrow: "Agent workspace", title: "Home", description: "Tell Radar what you want. It works right here, in front of you." },
  dashboard: { eyebrow: "Overview", title: "The workspace at a glance", description: "Live counts, run states, and the pipeline — every number is a real Convex subscription." },
  discover: { eyebrow: "Signal intelligence", title: "Evidence before opinions.", description: "Every match carries its source, freshness, and unknowns." },
  outreach: { eyebrow: "Approval boundary", title: "Nothing sends without you.", description: "Approve the exact recipient, subject, and body — then Radar sends." },
  inbox: { eyebrow: "Agent-owned inbox", title: "Replies arrive live.", description: "Inbound mail is untrusted data: classified, never auto-sent." },
  outcomes: { eyebrow: "Relationship pipeline", title: "Keep the momentum.", description: "Every relationship keeps its stage, evidence, next step, and history — and Radar never closes a loop without you." },
  forms: { eyebrow: "Approval boundary", title: "Paperwork, handled honestly.", description: "Radar reads a public form, fills it from confirmed facts only, and submits one approved payload at a time — with a screenshot as evidence." },
  sources: { eyebrow: "Your side of the ledger", title: "Give Radar what it cannot find on the web.", description: "Documents, sites, and snippets you add here are chunked, searchable, and pulled into the missions they're relevant to — nothing more." },
  context: { eyebrow: "Verified profile", title: "You stay the source of truth.", description: "Confirm, correct, or reject every fact before Radar ever uses it in plans, matches, or drafts." },
  activity: { eyebrow: "Durable run", title: "Watch Radar work.", description: "Persisted stages and events — never simulated progress." },
};

const quickPrompts: { label: string; goal: string }[] = [
  { label: "Find clients", goal: "Find growth-stage climate companies in Lagos that need a product-design partner." },
  { label: "Find talent", goal: "Find a senior Rust engineer in open-source infrastructure who is open to contract work." },
  { label: "Find a solution", goal: "Find vendors that migrate legacy Postgres clusters under 48-hour windows." },
  { label: "Find customers for my SaaS", goal: "Find potential customers for my SaaS." },
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

export default function App({ backendConnected }: { backendConnected: boolean }) {
  const workspaceId = "demo-workspace";

  const missions = useQuery(api.missions.list, backendConnected ? { workspaceId } : "skip");
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
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);
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
  const inbox = useQuery(api.outreachStore.getInbox, backendConnected ? { workspaceId } : "skip");
  const drafts = useQuery(api.outreachStore.listDrafts, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const threads = useQuery(api.inbox.listThreads, backendConnected ? { workspaceId, missionId: null } : "skip");
  const threadMessages = useQuery(api.inbox.listMessages, backendConnected && selectedThreadId ? { workspaceId, threadId: selectedThreadId } : "skip");
  const classifications = useQuery(api.outreachStore.listClassifications, backendConnected ? { workspaceId, missionId: null } : "skip");
  const outcomes = useQuery(api.outcomes.listForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const followUps = useQuery(api.relationships.followUpsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const meetings = useQuery(api.relationships.meetingsForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const sequences = useQuery(api.relationships.sequencesForMission, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formTemplates = useQuery(api.formStore.listTemplates, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formProposals = useQuery(api.formStore.listProposals, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formSubmissions = useQuery(api.formStore.listSubmissions, backendConnected && missionId ? { workspaceId, missionId } : "skip");
  const formCap = useQuery(api.formStore.capStatus, backendConnected ? { workspaceId } : "skip");
  const scoutForm = useAction(api.formFlows.scoutForm);
  const proposeFill = useAction(api.formFlows.proposeFill);
  const approveProposal = useMutation(api.formStore.approveProposal);
  const reviseProposalValues = useMutation(api.formStore.reviseProposalValues);
  const executeFormSubmission = useAction(api.formFlows.executeFormSubmission);
  const crawlProgress = useQuery(api.researchStore.latestCrawlProgress, backendConnected && missionId ? { missionId } : "skip");
  const contextFacts = useQuery(api.context.list, backendConnected ? { workspaceId, missionId: null } : "skip");
  const board = useQuery(api.commandCenter.runsBoard, backendConnected ? { workspaceId } : "skip");
  const dataSources = useQuery(api.dataSources.list, backendConnected ? { workspaceId } : "skip");
  const dataProgress = useQuery(api.dataSources.progress, backendConnected ? { workspaceId } : "skip");
  const addSnippet = useMutation(api.dataSources.addSnippet);
  const removeSource = useMutation(api.dataSources.deleteSource);
  const resyncSource = useAction(api.dataFlows.resyncSource);
  const overview = useQuery(api.commandCenter.overview, backendConnected ? { workspaceId } : "skip");
  const budgetStatus = useQuery(api.budget.status, backendConnected ? { workspaceId, missionId } : "skip");
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

  const navCounts: Record<View, number | null> = {
    home: null,
    discover: matches?.length ?? null,
    outreach: actionableDrafts.length || null,
    inbox: threads?.length || null,
    outcomes: openOutcomes.length || null,
    forms: (formProposals ?? []).filter((proposal) => proposal.status === "draft" || proposal.status === "approved" || proposal.status === "blocked" || proposal.status === "failed").length || null,
    context: null,
    sources: null,
    dashboard: null,
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
    if (dueFollowUps.length > 0) {
      items.push({ id: "followups", title: `${dueFollowUps.length} follow-up${dueFollowUps.length === 1 ? "" : "s"} due`, detail: dueFollowUps[0].note, tone: "amber", view: "outcomes" });
    }
    const queuedSteps = (sequences ?? []).flatMap((sequence) => sequence.steps).filter((step) => step.status === "draft_ready").length;
    if (queuedSteps > 0) {
      items.push({ id: "sequence", title: `${queuedSteps} sequence step${queuedSteps === 1 ? "" : "s"} drafted and awaiting approval`, detail: "A step is queued as a draft. Approving it is the only way it sends.", tone: "amber", view: "outreach" });
    }
    return items;
  }, [actionableDrafts, plan, threads, dueFollowUps, sequences]);

  function selectView(view: View) {
    setActiveView(view);
    setMobileNavOpen(false);
  }

  // Conversation thread per mission: the run's real steps, oldest first, so a
  // refresh reconstructs the same history the user saw live. Persisted in
  // Convex — nothing here is frontend-only state.
  const threadStepsByMission = useQuery(
    api.commandCenter.threadSteps,
    backendConnected && selectedMissionId ? { missionId: selectedMissionId as Id<"missions"> } : "skip",
  );
  // Step streams for the last three missions, so earlier threads stay live
  // while the user talks about a newer goal.
  const recentThreadSteps = useQuery(
    api.commandCenter.threadStepsMany,
    backendConnected && board && board.length > 0 ? { missionIds: board.slice(0, 3).map((row) => row.missionId) } : "skip",
  );

  // Home is the agent conversation: the newest mission is what the user came
  // to watch, so it starts expanded without any click. A user toggle pins
  // their choice; otherwise the newest mission with a live run expands.
  const autoExpandedId = useMemo(() => {
    if (openThreadId !== null) return openThreadId;
    if (!board || board.length === 0) return null;
    const liveStatuses = ["queued", "active", "waiting", "blocked"];
    const live = board.find((row) => liveStatuses.includes(row.runStatus));
    return (live ?? board[0]).missionId;
  }, [board, openThreadId]);

  // ChatGPT-pattern: the moment the user sends, the exchange must appear in
  // the viewport. Submitting selects the new mission; Home scrolls the thread
  // into view as soon as it mounts.
  useEffect(() => {
    if (!selectedMissionId || activeView !== "home") return;
    document.getElementById(`thread-${selectedMissionId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [selectedMissionId, activeView]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!goal.trim() || !backendConnected) return;
    setSubmitting(true);
    setNotice("");
    try {
      const result = await createMission({ workspaceId, title: goal.trim().slice(0, 80), rawGoal: goal.trim(), constraints: [], sourceScope: "public-web", completionPredicate: "A user-approved next action exists for at least one sourced match." });
      setSelectedMissionId(result.missionId);
      setClarifyAnswer("");
      setGoal("");
      // The agent's work must appear in front of the user immediately: start
      // the durable run now instead of waiting for a second click.
      try {
        await runPipeline({ workspaceId, missionId: result.missionId });
      } catch {
        // Surface nothing fatal — the run can be started from the thread if the
        // immediate start lost a race with the scheduler.
      }
    } catch (error) {
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
      {selectedMission && <div className="backend-status-card mission-chip"><div className="status-icon"><span className="status-dot amber-dot" /></div><div><strong>{selectedMission.title.slice(0, 30)}{selectedMission.title.length > 30 ? "…" : ""}</strong><span>{run ? `${run.currentStage} · ${run.status}` : selectedMission.status}</span></div></div>}
    </aside>
  );

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
              {(() => {
                // Render from the runs board (authoritative, updates instantly),
                // not from the steps list — a brand-new mission has zero steps
                // for its first seconds, and hiding it then is exactly the
                // "clicked start and nothing happened" bug.
                const stepMap = new Map((recentThreadSteps ?? []).map((thread) => [thread.missionId as string, thread.steps]));
                const stepsFor = (id: string) => stepMap.get(id) ?? [];
                const liveStatuses = ["queued", "active", "waiting", "blocked"];
                const rows = (board ?? []).filter((row) => stepsFor(row.missionId).length > 0 || row.runStatus !== "none" || row.missionId === selectedMissionId);
                const ordered = [...rows].sort((a, b) => {
                  const live = (row: typeof a) => liveStatuses.includes(row.runStatus);
                  if (live(a) !== live(b)) return live(a) ? -1 : 1;
                  return stepsFor(b.missionId).length - stepsFor(a.missionId).length;
                });
                return ordered.map((row) => {
                const thread = { missionId: row.missionId, steps: stepsFor(row.missionId) };
                const mission = missions?.find((item) => item._id === thread.missionId);
                if (!mission) return null;
                const threadRun = row;
                const threadMatches = thread.missionId === selectedMissionId ? matches : undefined;
                const threadDrafts = thread.missionId === selectedMissionId ? drafts : undefined;
                const threadApprovals = (threadDrafts ?? []).filter((draft) => ["awaiting_approval", "approved"].includes(draft.status));
                const isOpen = autoExpandedId === thread.missionId;
                const strongCount = (threadMatches ?? []).filter((match) => match.label === "stronger").length;
                const rawRunState = threadRun ? { status: threadRun.runStatus, currentStage: threadRun.currentStage, activeInterruption: threadRun.activeInterruption } : null;
                const runState = rawRunState && rawRunState.status !== "none" ? { status: rawRunState.status, currentStage: rawRunState.currentStage ?? "intake", activeInterruption: rawRunState.activeInterruption } : null;
                const headStep = thread.steps.length > 0 ? thread.steps[thread.steps.length - 1] : null;
                const runLive = runState ? ["queued", "active", "waiting", "blocked"].includes(runState.status) : false;
                return (
                  <article className={`panel thread-card${isOpen ? " open" : ""}`} key={thread.missionId} id={`thread-${thread.missionId}`}>
                    <button type="button" className="thread-card-head" onClick={() => setOpenThreadId(isOpen ? null : thread.missionId)} aria-expanded={isOpen}>
                      <span className={`status-pill status-${runState?.status ?? mission.status}`}>{runState?.status ?? mission.status}</span>
                      <strong className="thread-goal">{mission.rawGoal}</strong>
                      {!isOpen && (
                        <span className={`head-step${runLive ? " live" : ""}`}>{headStep ? <><em>{headStep.label}</em> {headStep.summary}</> : runLive ? "Radar is working…" : ""}</span>
                      )}
                      <span className="muted">{shortDate(mission.createdAt)}</span>
                    </button>
                    {isOpen && (
                      <div className="thread-body">
                        <div className="thread-msg you">
                          <span className="thread-who">You</span>
                          <p>{mission.rawGoal}</p>
                        </div>
                        <div className="thread-msg radar">
                          <span className="thread-who">Radar</span>
                          {thread.steps.length === 0 && (
                            <p className="thread-picking-up" aria-live="polite">Picking up your request…</p>
                          )}
                          {mission.intent && (
                            <p className="thread-understanding">{mission.intent.rationale}</p>
                          )}
                          {mission.clarification && (
                            <div className="thread-ask">
                              <p><b>Radar needs one detail</b>{mission.clarification}</p>
                              <div className="control-row">
                                <input value={clarifyAnswer} onChange={(e) => setClarifyAnswer(e.target.value)} placeholder="Answer in one line…" aria-label="Clarification answer" />
                                <button type="button" className="btn" disabled={!clarifyAnswer.trim() || planning} onClick={onClarifySubmit}>Answer</button>
                              </div>
                            </div>
                          )}
                          <MissionLifecycle run={runState} latestStep={thread.steps.length > 0 ? thread.steps[thread.steps.length - 1] : null} />
                          {thread.steps.length > 0 && (
                            <details className="thread-steps">
                              <summary>{thread.steps.length} step{thread.steps.length === 1 ? "" : "s"} — every receipt from the run</summary>
                              <ol className="event-trail compact">
                                {thread.steps.slice().reverse().map((step) => (
                                  <li key={step._id}>
                                    <span className="event-dot" />
                                    <div><strong>{step.label}{step.tool ? <em className="tool-chip">{step.tool}</em> : null}</strong><em>{step.summary}</em><small>{shortDate(step.createdAt)} · {step.stage}{step.errorCode ? ` · ${step.errorCode}` : ""}</small></div>
                                  </li>
                                ))}
                              </ol>
                            </details>
                          )}
                          {thread.missionId === selectedMissionId && strongCount > 0 && (
                            <div className="thread-results">
                              <p className="thread-count"><strong>{strongCount}</strong> strong {strongCount === 1 ? "match" : "matches"} · {(threadMatches ?? []).length} evaluated</p>
                              <div className="thread-cards">
                                {(threadMatches ?? []).filter((match) => match.label === "stronger").slice(0, 2).map((match) => (
                                  <div className="thread-result" key={match._id}>
                                    <strong>{match.entity?.name ?? match.subject}</strong>
                                    <span className="muted">{match.explanationSummary?.slice(0, 110)}{match.explanationSummary && match.explanationSummary.length > 110 ? "…" : ""}</span>
                                  </div>
                                ))}
                              </div>
                              <button type="button" className="btn ghost" onClick={() => selectView("discover")}>View all matches →</button>
                            </div>
                          )}
                          {threadApprovals.length > 0 && (
                            <div className="thread-approval">
                              <p><b>Waiting for you</b>{threadApprovals.length} draft{threadApprovals.length === 1 ? "" : "s"} cannot send until you approve the exact content.</p>
                              <button type="button" className="btn" onClick={() => selectView("outreach")}>Review & approve</button>
                            </div>
                          )}
                          {runState && ["cancelled", "complete", "failed"].includes(runState.status) && runState.status !== "complete" && (
                            <p className="stage-note">Run {runState.status}{runState.status === "failed" ? " — the transcript in Activity has the reason" : " — you stopped this mission"}.</p>
                          )}
                        </div>
                      </div>
                    )}
                  </article>
                );
                });
              })()}

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
                      { label: "Follow-ups due", value: overview.counts.followUpsDue, view: "outcomes" as View },
                      { label: "Drafts pending", value: overview.counts.draftsPending, view: "outreach" as View },
                      { label: "Submissions", value: overview.counts.submissions, view: "forms" as View },
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
                          <button type="button" className="btn ghost" onClick={() => selectView("outreach")}>Review matches & approvals →</button>
                        )}
                        <button type="button" className="btn ghost" onClick={() => selectView("activity")}>Live transcript</button>
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
                  <section className="panel" aria-label="Research controls">
                    <div className="panel-head"><p className="eyebrow">RESEARCH</p>
                      <span className="muted">Radar investigated these because of your mission — every card states why it looked, why it matches, and what it checked against your context.</span>
                      {runWorking && <span className="status-pill status-running">run active</span>}
                    </div>
                    <div className="control-row">
                      <input aria-label="Research query" placeholder={plan?.normalizedGoal || selectedMission.rawGoal} value={researchQuery} onChange={(event) => setResearchQuery(event.target.value)} />
                      <button type="button" className="btn" onClick={onSearch} disabled={!backendConnected || researching}>{researching ? "Researching…" : "Search"}</button>
                      <button type="button" className="btn ghost" onClick={onResolveEntities} disabled={!backendConnected || researching}>Resolve entities</button>
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

          {activeView === "outcomes" && (
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
                  <div className="pipeline-grid">
                    {PIPELINE_STAGES.map((stage) => {
                      const cards = outcomes.filter((outcome) => outcome.stage === stage);
                      if (cards.length === 0) return null;
                      return (
                        <div className="pipeline-column" key={stage}>
                          <div className="pipeline-column-head">
                            <span className={`stage-dot stage-${stage}`} />
                            <strong>{PIPELINE_LABELS[stage]}</strong>
                            <span className="nav-count">{cards.length}</span>
                          </div>
                          <div className="view-stack">
                            {cards.map((outcome) => {
                              const followUp = followUpForOutcome(outcome._id);
                              const outcomeMeetings = meetingsForOutcome(outcome._id);
                              const overdue = followUp && (followUp.status === "due" || followUp.dueAt <= Date.now());
                              return (
                                <article className="panel relationship-card" key={outcome._id}>
                                  <div className="panel-head">
                                    <strong>{outcome.counterpart}</strong>
                                    <span className="muted">updated {shortDate(outcome.updatedAt)}</span>
                                  </div>
                                  <p className="why-row"><b>Where this stands</b>{outcome.latestEvidence}</p>
                                  <p className="next-action"><b>Radar's next step</b>{outcome.nextAction}{outcome.nextStepAt ? ` · ${shortDate(outcome.nextStepAt)}` : ""}</p>
                                  {followUp && (
                                    <p className={`stage-note ${overdue ? "error" : ""}`}>
                                      {overdue ? "Follow-up due now" : `Follow-up ${shortDate(followUp.dueAt)}`} · {followUp.note}
                                    </p>
                                  )}
                                  {outcomeMeetings.length > 0 && (
                                    <p className="stage-note">Meetings on record: {outcomeMeetings.map((meeting) => shortDate(meeting.scheduledAt)).join(" · ")}</p>
                                  )}
                                  <div className="memory-timeline">
                                    <p className="stage-note">RELATIONSHIP MEMORY</p>
                                    <ol className="event-trail compact">
                                      {outcome.timeline.slice().reverse().map((event, index) => (
                                        <li key={`${outcome._id}-${index}`}>
                                          <span className="event-dot" />
                                          <div><strong>{event.summary}</strong><em>{event.type.replace(/_/g, " ")} · {shortDate(event.createdAt)}</em></div>
                                        </li>
                                      ))}
                                    </ol>
                                  </div>
                                  <div className="inline-actions">
                                    <button type="button" className="btn ghost" onClick={() => onAdvanceStage(outcome._id, "engaged", "Reply with a concrete next step and keep the conversation moving.")}>Engaged</button>
                                    <button type="button" className="btn ghost" onClick={() => onAdvanceStage(outcome._id, "proposal", "Put scope, timeline, and terms in writing for review.")}>Proposal</button>
                                    <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "positive")}>Won</button>
                                    <button type="button" className="btn ghost" onClick={() => onOutcomeStatus(outcome._id, "closed")}>Lost</button>
                                    {!followUp && <button type="button" className="btn ghost" onClick={() => onCreateFollowUp(outcome._id, outcome.matchId, outcome.counterpart)}>Schedule follow-up</button>}
                                    {meetingFor === outcome._id
                                      ? <button type="button" className="btn ghost" onClick={() => setMeetingFor(null)}>Cancel meeting</button>
                                      : <button type="button" className="btn ghost" onClick={() => { setMeetingFor(outcome._id); setMeetingAt(""); setMeetingNotes(""); }}>Record meeting</button>}
                                  </div>
                                  {meetingFor === outcome._id && (
                                    <div className="meeting-form">
                                      <label>When<input type="datetime-local" value={meetingAt} onChange={(event) => setMeetingAt(event.target.value)} /></label>
                                      <label>Notes<input value={meetingNotes} onChange={(event) => setMeetingNotes(event.target.value)} placeholder="What was agreed?" maxLength={1200} /></label>
                                      <button type="button" className="btn" disabled={!meetingAt} onClick={() => onRecordMeeting(outcome._id, outcome.matchId, outcome.counterpart)}>Save meeting</button>
                                    </div>
                                  )}
                                </article>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {pipelineNotice && <p className="stage-note">{pipelineNotice}</p>}
              </section>
            </div>
          )}

          {activeView === "forms" && (
            <div className="view-stack">
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
                                  <button type="button" className="btn ghost" onClick={() => selectView("context")}>Add a fact</button>
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

          {activeView === "sources" && (
            <div className="view-stack">
              <section className="panel" aria-label="Add a data source">
                <div className="panel-head"><p className="eyebrow">ADD A SOURCE</p>{dataProgress && <span className="muted">{dataProgress.activeCount} processing</span>}</div>
                <div className="source-tabs" role="tablist" aria-label="Source type">
                  {(["file", "website", "snippet"] as const).map((tab) => (
                    <button key={tab} type="button" role="tab" aria-selected={sourceTab === tab} className={sourceTab === tab ? "active" : ""} onClick={() => setSourceTab(tab)}>
                      {tab === "file" ? "File" : tab === "website" ? "Website" : "Snippet"}
                    </button>
                  ))}
                </div>

                {sourceTab === "file" && (
                  <div
                    className={fileDrag ? "drop-zone dragging" : "drop-zone"}
                    onDragOver={(event) => { event.preventDefault(); setFileDrag(true); }}
                    onDragLeave={() => setFileDrag(false)}
                    onDrop={(event) => { event.preventDefault(); setFileDrag(false); void onUploadFile(event.dataTransfer.files); }}
                  >
                    <input ref={fileInputRef} id="source-file" type="file" accept=".pdf,.doc,.docx,.txt,.md" onChange={(event) => void onUploadFile(event.target.files)} className="visually-hidden" />
                    <button type="button" className="drop-inner" onClick={() => fileInputRef.current?.click()} disabled={!backendConnected || uploadingFile}>
                      <strong>{uploadingFile ? "Reading your file…" : fileDrag ? "Drop to add it" : "Click to choose a file, or drop it here"}</strong>
                      <span>PDF, DOC, DOCX, TXT, MD · up to 20 MB · text must be selectable</span>
                    </button>
                  </div>
                )}

                {sourceTab === "website" && (
                  <form
                    className="source-form"
                    onSubmit={(event) => { event.preventDefault(); void onAddWebsite(); }}
                  >
                    <div className="field-pair">
                      <label>URL<input required type="url" placeholder="https://example.com" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} /></label>
                      <label>Title<input placeholder="Optional — defaults to the domain" value={websiteTitle} onChange={(event) => setWebsiteTitle(event.target.value)} /></label>
                    </div>
                    <div className="field-pair">
                      <label>How deep
                        <select value={websiteMode} onChange={(event) => setWebsiteMode(websiteMode as typeof websiteMode)}>
                          <option value="single">Just this page</option>
                          <option value="crawl">Crawl linked pages</option>
                          <option value="sitemap">Follow the sitemap</option>
                      </select>
                      </label>
                      {websiteMode === "crawl" && (
                        <label>Page limit<input type="number" min={1} max={50} value={websitePageLimit} onChange={(event) => setWebsitePageLimit(Number(event.target.value))} /></label>
                      )}
                    </div>
                    <div className="field-pair">
                      <label>Only paths starting with<input placeholder="/blog" value={websiteInclude} onChange={(event) => setWebsiteInclude(event.target.value)} /></label>
                      <label>Skip paths starting with<input placeholder="/tag" value={websiteExclude} onChange={(event) => setWebsiteExclude(event.target.value)} /></label>
                    </div>
                    <button type="submit" className="btn" disabled={!backendConnected || addingWebsite}>{addingWebsite ? "Starting…" : "Add website"}</button>
                    {websiteNotice && <p className="stage-note" role="status">{websiteNotice}</p>}
                  </form>
                )}

                {sourceTab === "snippet" && (
                  <form className="source-form" onSubmit={(event) => { event.preventDefault(); void onAddSnippet(); }}>
                    <label>Title<input required value={snippetTitle} onChange={(event) => setSnippetTitle(event.target.value)} placeholder="e.g. Services I offer" /></label>
                    <label>Text<textarea required rows={5} value={snippetText} onChange={(event) => setSnippetText(event.target.value)} placeholder="Paste anything Radar should know — an offer, a bio, a product one-pager." /></label>
                    <div className="inline-actions">
                      <button type="submit" className="btn" disabled={!backendConnected || addingSnippet}>{addingSnippet ? "Saving…" : "Add snippet"}</button>
                      <span className="muted">{snippetText.length}/20,000</span>
                    </div>
                    {snippetNotice && <p className="stage-note" role="status">{snippetNotice}</p>}
                  </form>
                )}
              </section>

              <section aria-label="Your sources">
                <div className="panel-head"><p className="eyebrow">YOUR SOURCES</p><span className="muted">{(dataSources ?? []).length} · retrieved into missions by relevance, not everything every time</span></div>
                {(dataSources ?? []).length === 0 ? (
                  <div className="panel"><p className="empty-state">No sources yet. A portfolio, a product page, a bio — Radar reads these the way it reads the web: chunked, bounded, and only when relevant to a mission.</p></div>
                ) : (
                  <div className="row-list">
                    {(dataSources ?? []).map((source) => (
                      <article className="row-item static" key={source._id}>
                        <div className="row-copy">
                          <strong><span className={`kind-pill kind-${source.kind}`}>{source.kind}</span> {source.title}</strong>
                          <em>{source.summary || source.url || ""}</em>
                          <span className="muted">{source.chunkCount} chunks · {source.pageCount} pages · added {shortDate(source.createdAt)}{source.lastSyncedAt ? ` · synced ${shortDate(source.lastSyncedAt)}` : ""}</span>
                          {source.syncError && <span className="stage-note error">{source.syncError}</span>}
                        </div>
                        <div className="inline-actions">
                          <span className={`status-pill status-${source.status}`}>{source.status}</span>
                          {source.kind === "website" && source.status !== "syncing" && (
                            <button type="button" className="btn ghost" disabled={!backendConnected || resyncingId === source._id} onClick={() => void onResync(source._id)}>
                              {resyncingId === source._id ? "Resyncing…" : "Resync"}
                            </button>
                          )}
                          {source.url && <a className="source-link" href={source.url} target="_blank" rel="noreferrer">Open</a>}
                          <button type="button" className="btn ghost" onClick={() => void onRemoveSource(source._id, source.title)}>Remove</button>
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
              <section className="panel" aria-label="Why context matters">
                <div className="panel-head"><p className="eyebrow">RADAR USES THIS WHEN IT THINKS</p><span className="muted">{contextFacts?.filter((fact) => ["user_confirmed", "user_corrected"].includes(fact.verificationStatus)).length ?? 0} confirmed · {contextFacts?.filter((fact) => fact.verificationStatus === "unreviewed").length ?? 0} awaiting your review</span></div>
                <p className="stage-note">Confirmed facts shape what Radar hunts for, how it judges matches, and what it says about you in drafts and replies. Anything you have not confirmed is never used.</p>
                <div className="control-row">
                  <input className="composer-input" style={{ flex: "0 0 220px" }} placeholder="Category (e.g. my services)" value={factCategory} onChange={(e) => setFactCategory(e.target.value)} aria-label="Fact category" maxLength={60} />
                  <input className="composer-input" placeholder="Value (e.g. React, TypeScript, product design)" value={factValue} onChange={(e) => setFactValue(e.target.value)} aria-label="Fact value" maxLength={240} />
                  <button type="button" className="btn" disabled={!backendConnected || !factCategory.trim() || !factValue.trim()} onClick={async () => { await addFact({ workspaceId, missionId: null, category: factCategory, value: factValue, sourceType: "user_input", sourceReference: null, confidence: 1, visibility: "workspace" }); setFactCategory(""); setFactValue(""); }}>Add fact</button>
                </div>
              </section>

              {(["user_confirmed", "user_corrected", "unreviewed", "user_rejected"] as const).map((group) => {
                const facts = (contextFacts ?? []).filter((fact) => fact.verificationStatus === group);
                if (group !== "unreviewed" && facts.length === 0) return null;
                const groupCopy: Record<string, { title: string; note: string }> = {
                  user_confirmed: { title: "CONFIRMED — RADAR USES THESE", note: "You entered or approved these. They are already steering plans, matches, and drafts." },
                  user_corrected: { title: "CORRECTED — RADAR USES THESE", note: "Your corrected wording replaced the original everywhere." },
                  unreviewed: { title: "AWAITING YOUR REVIEW", note: facts.length === 0 ? "Nothing inferred is waiting. When Radar proposes a fact, it lands here and stays unused until you confirm it." : "Radar inferred these but will not use them until you confirm." },
                  user_rejected: { title: "REJECTED", note: "Marked not-true by you; Radar excludes them from every prompt." },
                };
                return (
                  <section className="panel" aria-label={groupCopy[group].title} key={group}>
                    <div className="panel-head"><p className="eyebrow">{groupCopy[group].title}</p><span className="muted">{facts.length}</span></div>
                    <p className="stage-note">{groupCopy[group].note}</p>
                    {facts.length === 0 ? null : (
                      <div className="row-list">
                        {facts.map((fact) => (
                          <article className="row-item static" key={fact._id}>
                            <div className="row-copy">
                              <strong>{fact.category}</strong>
                              <em>{fact.value}</em>
                              <span className="muted">
                                {fact.sourceType === "user_input" ? "added by you" : fact.sourceType === "plan_extraction" ? "from a mission plan" : fact.sourceType === "source_extraction" ? "from a researched source" : "inferred by Radar"}
                                · added {shortDate(fact.createdAt)}
                              </span>
                            </div>
                            <div className="inline-actions">
                              {fact.verificationStatus !== "user_confirmed" && <button type="button" className="btn ghost" onClick={() => confirmFact({ workspaceId, factId: fact._id })}>Confirm</button>}
                              {editingFactId === fact._id ? (
                                <>
                                  <input className="composer-input" style={{ maxWidth: 220 }} value={factEditValue} onChange={(e) => setFactEditValue(e.target.value)} aria-label="Corrected value" maxLength={240} />
                                  <button type="button" className="btn ghost" onClick={async () => { await correctFact({ workspaceId, factId: fact._id, value: factEditValue }); setEditingFactId(null); }}>Save</button>
                                </>
                              ) : (
                                <button type="button" className="btn ghost" onClick={() => { setEditingFactId(fact._id); setFactEditValue(fact.value); }}>Correct</button>
                              )}
                              {fact.verificationStatus !== "user_rejected" && <button type="button" className="btn ghost" onClick={() => rejectFact({ workspaceId, factId: fact._id })}>Reject</button>}
                              <button type="button" className="btn ghost" onClick={() => deleteFact({ workspaceId, factId: fact._id })}>Delete</button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
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
                    {run.status === "blocked" && (
                      <div className="inline-actions"><button type="button" className="btn" onClick={onRetryStage}>↻ Retry stage</button></div>
                    )}
                    {!["cancelled", "complete", "failed"].includes(run.status) && (
                      <div className="inline-actions"><button type="button" className="btn ghost" onClick={onStopRun}>■ Stop mission</button></div>
                    )}
                    <MissionLifecycle
                      run={{ status: run.status, currentStage: run.currentStage, activeInterruption: run.activeInterruption ?? null }}
                      latestStep={runSteps && runSteps.length > 0 ? runSteps[runSteps.length - 1] : undefined}
                    />
                  </section>
                  <section className="panel" aria-label="Agent transcript">
                    <div className="panel-head"><p className="eyebrow">AGENT TRANSCRIPT</p><span className="muted">{runSteps?.length ?? 0} steps</span></div>
                    {runSteps === undefined ? <p className="empty-state">Loading…</p> : runSteps.length === 0 ? <p className="empty-state">The agent transcript appears here as Radar works: classification, planning, Firecrawl research, and sends each leave a receipt.</p> : (
                      <ol className="event-trail transcript">
                        {runSteps.slice().reverse().map((step) => (
                          <li key={step._id}>
                            <span className="event-dot" />
                            <div>
                              <strong>{step.label}{step.tool ? <em className="tool-chip">{step.tool}</em> : null}</strong>
                              <em>{step.summary}</em>
                              <small>{shortDate(step.createdAt)} · {step.stage}{step.errorCode ? ` · ${step.errorCode}` : ""}{step.reference ? ` · ref ${step.reference.slice(0, 12)}…` : ""}</small>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
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
