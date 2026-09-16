import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "../convex/_generated/api";
import schema from "../convex/schema";
import { parseFormControls, parseSubmitSelector, validateScout } from "../convex/formFlows";
import { formPayloadHash } from "../convex/formStore";

const convexModules = import.meta.glob("../convex/**/*.*s");

type TestT = ReturnType<typeof convexTest<typeof schema>>;

const WORKSPACE = "demo-workspace";

// The Firecrawl client is constructed at module load in formFlows.ts, so the
// mock must exist before the glob imports run. `scrape` dispatches on whether
// the call carries form actions: scouting has none, execution always does.
let scoutResult: () => Promise<unknown> = async () => ({ json: validScout(), markdown: "Apply to Acme" });
let executionResult: () => Promise<unknown> = async () => ({
  markdown: "Thanks! Your message was sent.",
  html: "<html>Thanks!</html>",
  screenshot: "https://firecrawl.example/shot.png",
  metadata: { statusCode: 200 },
});
let scrapeCalls = 0;
let lastActions: Array<Record<string, unknown>> = [];
const scrapeImpl = async (_url: string, options?: unknown) => {
  scrapeCalls += 1;
  const actions = typeof options === "object" && options !== null ? (options as { actions?: unknown[] }).actions : undefined;
  if (Array.isArray(actions)) {
    lastActions = actions as Array<Record<string, unknown>>;
    return await executionResult();
  }
  return await scoutResult();
};
vi.mock("@firecrawl/firecrawl-convex", () => {
  class FirecrawlClient {
    constructor(_component: unknown) {}
    async scrape(_ctx: unknown, url: string, options?: unknown) {
      return scrapeImpl(url, options);
    }
    async search() {
      return { web: [] };
    }
    async map() {
      return { links: [] };
    }
    async startCrawl() {
      return { crawlId: "crawl_test", jobId: "job_test" };
    }
  }
  return { FirecrawlClient };
});

// The fill model is stubbed through global fetch, alongside the screenshot
// download the executor performs.
type FillValue = { name: string; value: string; factIndex: number | null };
let fillValues: FillValue[] = [];
let fillNote = "";

function stubFetch() {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target.includes("chat/completions")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify({ values: fillValues, note: fillNote }) } }] }),
        { status: 200 },
      );
    }
    // Screenshot download.
    return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200 });
  }));
}

// The real httpbin.org/forms/post markup (a public form built for exactly this
// purpose). It uses a bare <button> with no type attribute and labels that wrap
// their inputs — both of which the deterministic parser must handle.
const HTTPBIN_FORM_HTML = `<!DOCTYPE html>
<html>
  <head>
  </head>
  <body>
  <form method="post" action="/post">
   <p><label>Customer name: <input name="custname"></label></p>
   <p><label>Telephone: <input type=tel name="custtel"></label></p>
   <p><label>E-mail address: <input type=email name="custemail"></label></p>
   <fieldset>
    <legend> Pizza Size </legend>
    <p><label> <input type=radio name=size value="small"> Small </label></p>
    <p><label> <input type=radio name=size value="medium"> Medium </label></p>
    <p><label> <input type=radio name=size value="large"> Large </label></p>
   </fieldset>
   <fieldset>
    <legend> Pizza Toppings </legend>
    <p><label> <input type=checkbox name="topping" value="bacon"> Bacon </label></p>
    <p><label> <input type=checkbox name="topping" value="cheese"> Extra Cheese </label></p>
    <p><label> <input type=checkbox name="topping" value="onion"> Onion </label></p>
    <p><label> <input type=checkbox name="topping" value="mushroom"> Mushroom </label></p>
   </fieldset>
   <p><label>Preferred delivery time: <input type=time min="11:00" max="21:00" step="900" name="delivery"></label></p>
   <p><label>Delivery instructions: <textarea name="comments"></textarea></label></p>
   <p><button>Submit order</button></p>
  </form>
  </body>
</html>`;

function validScout(overrides: Record<string, unknown> = {}) {
  return {
    formFound: true,
    formTitle: "Contact Acme",
    submitLabel: "Send message",
    submitSelector: 'button[type="submit"]',
    loginRequired: false,
    humanCheck: false,
    notes: "",
    confidence: 0.9,
    fields: [
      { name: "email", label: "Email", type: "email", required: true, options: [], selector: 'input[name="email"]', placeholder: "you@company.com" },
      { name: "message", label: "Message", type: "textarea", required: true, options: [], selector: 'textarea[name="message"]', placeholder: "" },
      { name: "attachment", label: "Attachment", type: "file", required: false, options: [], selector: 'input[name="attachment"]', placeholder: "" },
    ],
    ...overrides,
  };
}

async function seedSource(t: TestT, url = "https://acme.example.com/careers/apply") {
  return t.run(async (ctx) => {
    const { missionId } = await ctx.runMutation(api.missions.create, {
      workspaceId: WORKSPACE,
      title: "Find companies that need React development.",
      rawGoal: "Find companies that need React development.",
      constraints: [],
      sourceScope: "public-web",
      completionPredicate: "A user-approved next action exists.",
    });
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId)).first();
    const now = Date.now();
    const jobId = await ctx.db.insert("researchJobs", {
      missionId, runId: run!._id, requestId: `req-${now}`, operation: "search", query: "q",
      status: "complete", provider: "firecrawl", providerRequestId: null, crawlId: null, crawlStatus: null,
      errorCode: null, resultCount: 1, errorSummary: null, createdAt: now, startedAt: now, finishedAt: now, updatedAt: now,
    });
    const sourceId = await ctx.db.insert("sourceRecords", {
      missionId, jobId, url, title: "Apply to Acme", sourceType: "scraped_page",
      excerpt: "Apply through our online form.",
      content: "Send us a message and we will get back to you.",
      fetchedAt: now, freshness: "fresh", firecrawlRequestId: null, firecrawlPageId: null,
      processingStatus: "scraped", errorSummary: null, createdAt: now, updatedAt: now,
    });
    return { missionId: missionId as unknown as string, sourceId: sourceId as unknown as string };
  });
}

async function addFact(t: TestT, missionId: string, category: string, value: string) {
  return await t.run(async (ctx) => ctx.runMutation(api.context.add, {
    workspaceId: WORKSPACE,
    missionId: missionId as never,
    category,
    value,
    sourceType: "user_input",
    sourceReference: null,
    confidence: 1,
    visibility: "workspace",
  }));
}

function templatesFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => ctx.db.query("formTemplates").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
}

function proposalsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => ctx.db.query("formProposals").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
}

function submissionsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => ctx.db.query("formSubmissions").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).collect());
}

function stepsFor(t: TestT, missionId: string) {
  return t.run(async (ctx) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_missionId", (q) => q.eq("missionId", missionId as never)).first();
    return await ctx.db.query("runSteps").withIndex("by_runId", (q) => q.eq("runId", run!._id)).collect();
  });
}

/**
 * Drives scout → propose → (optionally revise) → approve, returning the ids the
 * execution tests need. Keeps each test focused on the behavior it asserts.
 */
async function prepareApprovedProposal(t: TestT, missionId: string, sourceId: string, fillMessage = true) {
  const emailFact = await addFact(t, missionId, "work_email", "tope@example.com");
  const messageFact = await addFact(t, missionId, "pitch", "I build React dashboards and would love to help.");
  const scouted = await t.action(api.formFlows.scoutForm, {
    workspaceId: WORKSPACE,
    missionId: missionId as never,
    sourceId: sourceId as never,
  });
  fillValues = [
    { name: "email", value: "tope@example.com", factIndex: 1 },
    fillMessage
      ? { name: "message", value: "I build React dashboards and would love to help.", factIndex: 2 }
      : { name: "message", value: "I build React dashboards and would love to help.", factIndex: null },
  ];
  const proposed = await t.action(api.formFlows.proposeFill, {
    workspaceId: WORKSPACE,
    missionId: missionId as never,
    templateId: scouted.templateId,
  });
  if (proposed.unmatchedRequired.length > 0) {
    await t.run(async (ctx) => ctx.runMutation(api.formStore.reviseProposalValues, {
      workspaceId: WORKSPACE,
      proposalId: proposed.proposalId,
      fieldValues: [
        { name: "email", value: "tope@example.com", factId: emailFact },
        { name: "message", value: "I build React dashboards and would love to help.", factId: messageFact },
        { name: "attachment", value: "", factId: null },
      ],
    }));
  }
  await t.run(async (ctx) => ctx.runMutation(api.formStore.approveProposal, {
    workspaceId: WORKSPACE,
    proposalId: proposed.proposalId,
  }));
  return { proposalId: proposed.proposalId, templateId: scouted.templateId, emailFact, messageFact };
}

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-key";
  scoutResult = async () => ({ json: validScout(), markdown: "Apply to Acme\nEmail\nMessage\nSend message" });
  executionResult = async () => ({
    markdown: "Thanks! Your message was sent.",
    html: "<html>Thanks!</html>",
    screenshot: "https://firecrawl.example/shot.png",
    metadata: { statusCode: 200 },
  });
  scrapeCalls = 0;
  lastActions = [];
  fillValues = [];
  fillNote = "";
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("validateScout — form structure validation", () => {
  it("accepts a well-formed scout and clamps confidence", () => {
    const result = validateScout(validScout({ confidence: 9 }));
    expect(result?.formFound).toBe(true);
    expect(result?.formTitle).toBe("Contact Acme");
    expect(result?.fields).toHaveLength(3);
    expect(result?.confidence).toBe(1);
    expect(result?.submitSelector).toBe('button[type="submit"]');
  });

  it("normalizes an unknown field type and drops entries with no name or label", () => {
    const result = validateScout(validScout({
      fields: [
        { name: "weird", label: "Weird", type: "signature", required: false, options: [], selector: "", placeholder: "" },
        { name: "", label: "", type: "text", required: false, options: [], selector: "", placeholder: "" },
      ],
    }));
    expect(result?.fields).toHaveLength(1);
    expect(result?.fields[0].type).toBe("unknown");
  });

  it("returns null for shapes it cannot trust", () => {
    expect(validateScout(null)).toBeNull();
    expect(validateScout("nope")).toBeNull();
    expect(validateScout({ fields: "no" })).toMatchObject({ fields: [] });
  });
});

describe("parseFormControls — deterministic DOM parsing", () => {
  it("reads the real httpbin form: names, types, groups, and honest required flags", () => {
    const fields = parseFormControls(HTTPBIN_FORM_HTML);
    expect(fields.map((field) => field.name)).toEqual(["custname", "custtel", "custemail", "size", "topping", "delivery", "comments"]);
    expect(fields.map((field) => field.type)).toEqual(["text", "tel", "email", "radio", "checkbox", "text", "textarea"]);
    // httpbin marks nothing required; inferring it would wrongly block approval.
    expect(fields.every((field) => field.required === false)).toBe(true);
    expect(fields.find((field) => field.name === "size")?.options).toEqual(["small", "medium", "large"]);
    expect(fields.find((field) => field.name === "topping")?.options).toEqual(["bacon", "cheese", "onion", "mushroom"]);
    // Selectors come from the markup, not from a label guess.
    expect(fields.find((field) => field.name === "custemail")?.selector).toBe('input[name="custemail"]');
    expect(fields.find((field) => field.name === "comments")?.selector).toBe('textarea[name="comments"]');
    expect(fields.find((field) => field.name === "custname")?.label).toContain("Customer name");
  });

  it("reads a select's options, checkbox groups, required flags, and id selectors", () => {
    const html = '<form><label for="plan">Plan</label><select id="plan" name="plan"><option value="free">Free</option><option value="pro">Pro</option></select>'
      + '<label><input type="checkbox" name="extras" value="support"> Support</label>'
      + '<label><input type="checkbox" name="extras" value="training" required> Training</label>'
      + '<button type="submit">Go</button></form>';
    const fields = parseFormControls(html);
    const plan = fields.find((field) => field.name === "plan");
    expect(plan?.type).toBe("select");
    expect(plan?.options).toEqual(["free", "pro"]);
    expect(plan?.selector).toBe("#plan");
    const extras = fields.find((field) => field.name === "extras");
    expect(extras?.type).toBe("checkbox");
    expect(extras?.options).toEqual(["support", "training"]);
    expect(extras?.required).toBe(true);
    expect(plan?.label).toBe("Plan");
  });

  it("skips hidden and button controls and never fills file inputs", () => {
    const fields = parseFormControls('<form><input type="hidden" name="token" value="x"><input type="submit" name="go" value="Send"><input type="file" name="cv"><input type="text" name="who"></form>');
    expect(fields.map((field) => field.name)).toEqual(["cv", "who"]);
    expect(fields[0].type).toBe("file");
  });

  it("returns nothing for markup with no usable controls", () => {
    expect(parseFormControls("")).toEqual([]);
    expect(parseFormControls("<html><body><p>An article.</p></body></html>")).toEqual([]);
  });

  it("finds a bare <button> submit control and typed submit inputs", () => {
    expect(parseSubmitSelector(HTTPBIN_FORM_HTML)).toBe("form button");
    expect(parseSubmitSelector('<form><button id="send">Send</button></form>')).toBe("#send");
    expect(parseSubmitSelector('<form><input type="submit" name="commit"></form>')).toBe('input[name="commit"]');
    expect(parseSubmitSelector("<p>nothing here</p>")).toBe("");
  });
});

describe("scoutForm — Firecrawl structured extraction", () => {
  it("prefers the DOM structure over the model's invented field names", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    // The model hallucinated names and marked everything required; the DOM wins.
    scoutResult = async () => ({
      json: validScout({
        fields: [
          { name: "customer_name", label: "Customer name", type: "text", required: true, options: [], selector: 'input[name="customer_name"]', placeholder: "" },
        ],
        submitSelector: 'button[type="submit"]',
      }),
      html: HTTPBIN_FORM_HTML,
      markdown: "Customer name:",
    });
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    expect(result.blockedReason).toBeNull();
    const template = (await templatesFor(t, missionId))[0];
    expect(template.fields.map((field) => field.name)).toEqual(["custname", "custtel", "custemail", "size", "topping", "delivery", "comments"]);
    expect(template.fields.every((field) => field.required === false)).toBe(true);
    expect(template.submitSelector).toBe("form button");
    expect(template.confidence).toBeGreaterThan(0.9);
    const steps = await stepsFor(t, missionId);
    expect(steps.find((step) => step.label === "form.scouted")?.summary).toContain("parsed from the DOM");
  });

  it("falls back to the model's field list when the markup cannot be parsed", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    scoutResult = async () => ({ json: validScout(), html: "<html><body><div>no form</div></body></html>", markdown: "Contact" });
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    expect(result.fieldCount).toBe(3);
    const steps = await stepsFor(t, missionId);
    expect(steps.find((step) => step.label === "form.scouted")?.summary).toContain("model-extracted");
  });

  it("persists the scouted fields and records a firecrawl.scout receipt", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });

    expect(result.fieldCount).toBe(3);
    expect(result.blockedReason).toBeNull();
    const templates = await templatesFor(t, missionId);
    expect(templates).toHaveLength(1);
    expect(templates[0].formTitle).toBe("Contact Acme");
    expect(templates[0].fields.map((field) => field.name)).toEqual(["email", "message", "attachment"]);
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "form.scouted" && step.tool === "firecrawl.scout")).toBe(true);
  });

  it("flags a login wall as login_required and never proposes to fill it", async () => {
    scoutResult = async () => ({ json: validScout({ loginRequired: true }), markdown: "Sign in to continue" });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    expect(result.blockedReason).toBe("login_required");

    await expect(t.action(api.formFlows.proposeFill, {
      workspaceId: WORKSPACE,
      missionId: missionId as never,
      templateId: result.templateId,
    })).rejects.toThrow("FORM_BLOCKED");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "form.blocked")).toBe(true);
  });

  it("detects a human check from the page text even when the model misses it", async () => {
    scoutResult = async () => ({ json: validScout({ humanCheck: false }), markdown: "Please complete the security check to continue" });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    expect(result.blockedReason).toBe("human_check_required");
    expect(result.blockedDetail).toContain("never bypasses");
  });

  it("reports no_form when the page has no usable form", async () => {
    scoutResult = async () => ({ json: validScout({ formFound: false, fields: [] }), markdown: "Just an article." });
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const result = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    expect(result.blockedReason).toBe("no_form");
  });

  it("refuses a source outside the calling workspace", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await expect(t.action(api.formFlows.scoutForm, { workspaceId: "attacker", missionId: missionId as never, sourceId: sourceId as never }))
      .rejects.toThrow("FORBIDDEN_SCOPE");
  });
});

describe("proposeFill — confirmed facts only", () => {
  it("maps confirmed facts onto fields and flags unmatched required fields", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await addFact(t, missionId, "work_email", "tope@example.com");
    const scouted = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    fillValues = [
      { name: "email", value: "tope@example.com", factIndex: 1 },
      { name: "message", value: "I can help with this.", factIndex: null },
      { name: "attachment", value: "résumé.pdf", factIndex: 1 },
    ];
    const result = await t.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId: missionId as never, templateId: scouted.templateId });

    expect(result.filled).toBe(1);
    expect(result.unmatchedRequired).toContain("Message");
    const proposals = await proposalsFor(t, missionId);
    const email = proposals[0].fieldValues.find((field) => field.name === "email");
    expect(email?.value).toBe("tope@example.com");
    expect(email?.factCategory).toBe("work_email");
    // A value citing no confirmed fact is dropped, never trusted.
    expect(proposals[0].fieldValues.find((field) => field.name === "message")?.value).toBe("");
    // File inputs can never be filled from text facts.
    expect(proposals[0].fieldValues.find((field) => field.name === "attachment")?.value).toBe("");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "form.proposed" && step.tool === "llm.form_fill")).toBe(true);
  });

  it("refuses to propose a fill with no confirmed context", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const scouted = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    await expect(t.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId: missionId as never, templateId: scouted.templateId }))
      .rejects.toThrow("FORM_NO_CONTEXT");
  });
});

describe("approval binding — one exact payload", () => {
  it("refuses approval while a required field is unmatched", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await addFact(t, missionId, "work_email", "tope@example.com");
    const scouted = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    fillValues = [{ name: "email", value: "tope@example.com", factIndex: 1 }];
    const proposed = await t.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId: missionId as never, templateId: scouted.templateId });
    await expect(t.run(async (ctx) => ctx.runMutation(api.formStore.approveProposal, {
      workspaceId: WORKSPACE,
      proposalId: proposed.proposalId,
    }))).rejects.toThrow("FORM_INCOMPLETE");
  });

  it("binds the approval to the payload hash and refuses a mutated payload", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const proposal = await t.run(async (ctx) => ctx.db.get(proposalId as never));
    const expected = await formPayloadHash(
      proposal!.url,
      proposal!.fieldValues.filter((field) => field.value).map((field) => ({ name: field.name, value: field.value })),
    );
    expect(proposal!.payloadHash).toBe(expected);

    // Mutating a stored value without a fresh proposal invalidates the approval.
    await t.run(async (ctx) => ctx.db.patch(proposalId as never, {
      fieldValues: proposal!.fieldValues.map((field) => field.name === "email" ? { ...field, value: "attacker@evil.example" } : field),
    }));
    await expect(t.run(async (ctx) => ctx.runMutation(api.formStore.approveProposal, {
      workspaceId: WORKSPACE,
      proposalId: proposalId as never,
    }))).rejects.toThrow("APPROVAL_STALE");
  });

  it("revokes the approval when the payload is revised", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const fact = await addFact(t, missionId, "portfolio", "https://portfolio.example.com");
    await t.run(async (ctx) => ctx.runMutation(api.formStore.reviseProposalValues, {
      workspaceId: WORKSPACE,
      proposalId: proposalId as never,
      fieldValues: [
        { name: "message", value: "I build React dashboards and would love to help.", factId: fact },
        { name: "email", value: "tope@example.com", factId: null },
      ],
    }));
    const approval = await t.run(async (ctx) => ctx.db.query("approvals").withIndex("by_proposalId", (q) => q.eq("proposalId", proposalId as never)).first());
    // `email` no longer cites a fact, so it drops out — the payload changed and
    // the earlier approval can no longer authorize it.
    expect(approval?.status).toBe("revoked");
  });
});

describe("executeFormSubmission — one approval, one submission", () => {
  it("submits once, stores screenshot evidence, and records the outcome", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    executionResult = async () => ({
      markdown: "Thanks! Your message was sent.",
      html: "<html><body>Thanks! Your message was sent.</body></html>",
      screenshot: "https://firecrawl.example/shot.png",
      metadata: { statusCode: 200 },
    });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const result = await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(result.status).toBe("submitted");
    expect(result.evidenceCaptured).toBe(true);

    const submissions = await submissionsFor(t, missionId);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].status).toBe("submitted");
    expect(submissions[0].evidenceFileId).not.toBeNull();
    expect(submissions[0].postSubmitExcerpt).toContain("Thanks");

    const listed = await t.run(async (ctx) => ctx.runQuery(api.formStore.listSubmissions, { workspaceId: WORKSPACE, missionId: missionId as never }));
    expect(listed[0].evidenceUrl).toBeTruthy();
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "form.executed" && step.tool === "firecrawl.form")).toBe(true);
  });

  it("clicks the scouted submit control, including a bare <button> with no type", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    // Real forms commonly omit type="submit", which a generic selector misses.
    scoutResult = async () => ({ json: validScout({ submitLabel: "Submit order", submitSelector: "form button" }), markdown: "Submit order" });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(lastActions.filter((action) => action.type === "click" && action.selector === "form button")).toHaveLength(1);
    expect(lastActions.some((action) => action.type === "screenshot")).toBe(true);
  });

  it("clicks the matching option for a radio group by attribute, not by label", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    scoutResult = async () => ({
      json: validScout({
        fields: [
          { name: "custname", label: "Customer name", type: "text", required: false, options: [], selector: 'input[name="custname"]', placeholder: "" },
          { name: "size", label: "Pizza Size", type: "radio", required: false, options: ["small", "medium", "large"], selector: 'input[name="size"]', placeholder: "" },
        ],
        submitSelector: "form button",
      }),
      markdown: "Pizza Size",
    });
    await addFact(t, missionId, "full_name", "Proof Run");
    await addFact(t, missionId, "pizza_size", "medium");
    const scouted = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    fillValues = [
      { name: "custname", value: "Proof Run", factIndex: 1 },
      { name: "size", value: "medium", factIndex: 2 },
    ];
    const proposed = await t.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId: missionId as never, templateId: scouted.templateId });
    await t.run(async (ctx) => ctx.runMutation(api.formStore.approveProposal, { workspaceId: WORKSPACE, proposalId: proposed.proposalId }));
    await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposed.proposalId });
    expect(lastActions.some((action) => action.type === "click" && action.selector === 'input[name="size"][value="medium"]')).toBe(true);
    expect(lastActions.some((action) => action.type === "click" && action.selector === 'input[name="custname"]')).toBe(true);
  });

  it("falls back to a generic submit selector when scouting found none", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    scoutResult = async () => ({ json: validScout({ submitSelector: "" }), markdown: "Send message" });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    const submit = lastActions.find((action) => action.type === "click" && String(action.selector).includes("form button"));
    expect(submit).toBeTruthy();
  });

  it("is idempotent: a second call does not submit again", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    executionResult = async () => ({ markdown: "Thanks!", html: "<html>Thanks!</html>", screenshot: "https://firecrawl.example/shot.png", metadata: { statusCode: 200 } });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const before = scrapeCalls;
    await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    const second = await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(second.status).toBe("already_submitted");
    // Exactly one Firecrawl call across both invocations.
    expect(scrapeCalls - before).toBe(1);
    expect(await submissionsFor(t, missionId)).toHaveLength(1);
  });

  it("refuses to run without an approval", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    await addFact(t, missionId, "work_email", "tope@example.com");
    const scouted = await t.action(api.formFlows.scoutForm, { workspaceId: WORKSPACE, missionId: missionId as never, sourceId: sourceId as never });
    fillValues = [
      { name: "email", value: "tope@example.com", factIndex: 1 },
      { name: "message", value: "Hello", factIndex: null },
    ];
    const proposed = await t.action(api.formFlows.proposeFill, { workspaceId: WORKSPACE, missionId: missionId as never, templateId: scouted.templateId });
    // The unmatched required field blocks execution before approval is even considered.
    await expect(t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposed.proposalId }))
      .rejects.toThrow("FORM_INCOMPLETE");
  });

  it("records a detected human check as blocked, never as failed or submitted", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    executionResult = async () => ({
      markdown: "Please complete the security check before continuing.",
      html: "<html>checking your browser</html>",
      screenshot: "https://firecrawl.example/shot.png",
      metadata: { statusCode: 200 },
    });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const result = await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(result.status).toBe("blocked_human_check");
    const submissions = await submissionsFor(t, missionId);
    expect(submissions[0].status).toBe("blocked_human_check");
    expect(submissions[0].errorCode).toBe("HUMAN_CHECK_REQUIRED");
    const steps = await stepsFor(t, missionId);
    expect(steps.some((step) => step.label === "form.blocked")).toBe(true);
  });

  it("records an authentication wall as blocked_login", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    executionResult = async () => ({ markdown: "", html: "", screenshot: null, metadata: { statusCode: 401 } });
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const result = await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(result.status).toBe("blocked_login");
    expect((await submissionsFor(t, missionId))[0].errorCode).toBe("LOGIN_REQUIRED");
  });

  it("marks a hard provider failure as failed", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    executionResult = async () => { throw new Error("Insufficient credits to perform this request (402)."); };
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    const result = await t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never });
    expect(result.status).toBe("failed");
    const submissions = await submissionsFor(t, missionId);
    expect(submissions[0].status).toBe("failed");
    expect(submissions[0].errorCode).toBe("FIRECRAWL_CREDITS_EXHAUSTED");
  });

  it("enforces the per-workspace daily submission cap", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const { proposalId, templateId } = await prepareApprovedProposal(t, missionId, sourceId);
    // Five submissions already happened today for this workspace.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (let index = 0; index < 5; index += 1) {
        const otherProposal = await ctx.db.insert("formProposals", {
          workspaceId: WORKSPACE, missionId: missionId as never, templateId: templateId as never,
          sourceId: sourceId as never, url: "https://acme.example.com/careers/apply", formTitle: "Contact Acme",
          fieldValues: [], unmatchedRequired: [], payloadHash: `hash-${index}`, status: "submitted",
          errorSummary: null, createdAt: now, updatedAt: now,
        });
        await ctx.db.insert("formSubmissions", {
          workspaceId: WORKSPACE, missionId: missionId as never, proposalId: otherProposal, templateId: templateId as never,
          url: "https://acme.example.com/careers/apply", formTitle: "Contact Acme", fieldCount: 1,
          status: "submitted", errorCode: null, errorSummary: null, evidenceFileId: null,
          postSubmitExcerpt: "ok", submittedAt: now, createdAt: now, updatedAt: now,
        });
      }
    });
    await expect(t.action(api.formFlows.executeFormSubmission, { workspaceId: WORKSPACE, proposalId: proposalId as never }))
      .rejects.toThrow("FORM_CAP_REACHED");
    const cap = await t.run(async (ctx) => ctx.runQuery(api.formStore.capStatus, { workspaceId: WORKSPACE }));
    expect(cap.used).toBe(5);
    expect(cap.cap).toBe(5);
  });
});

describe("claimExecution — cross-workspace safety", () => {
  it("refuses a proposal from another workspace", async () => {
    const t = convexTest(schema, convexModules);
    const { missionId, sourceId } = await seedSource(t);
    const { proposalId } = await prepareApprovedProposal(t, missionId, sourceId);
    await expect(t.run(async (ctx) => ctx.runMutation(internal.formStore.claimExecution, {
      workspaceId: "attacker",
      proposalId: proposalId as never,
    }))).rejects.toThrow("FORBIDDEN_SCOPE");
  });
});
