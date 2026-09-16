import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { searchableText } from "./hash";

/**
 * Entity + signal store.
 *
 * Discovery output is resolved into entities (people, organizations,
 * products) with extracted attributes, signals, and a contact route that is
 * only kept when it has a public source. Deduplication is by canonical URL
 * first, then by normalized name within the mission, so the same company
 * discovered through two queries becomes one entity with merged evidence.
 */

const signalTypes = ["hiring", "project_request", "rfp", "complaint", "funding", "launch", "expansion", "other"] as const;
const entityKinds = ["person", "organization", "product"] as const;
const contactKinds = ["email", "form", "linkedin"] as const;

const extractedSignal = v.object({
  type: v.union(...signalTypes.map((t) => v.literal(t))),
  statement: v.string(),
});

const extractionInput = v.object({
  entityName: v.string(),
  entityType: v.union(...entityKinds.map((k) => v.literal(k))),
  expressedNeed: v.union(v.string(), v.null()),
  skillsOrOffer: v.array(v.string()),
  signals: v.array(extractedSignal),
  contactRoute: v.union(v.null(), v.object({
    kind: v.union(...contactKinds.map((k) => v.literal(k))),
    value: v.string(),
    publicSource: v.union(v.string(), v.null()),
  })),
  summary: v.string(),
  confidence: v.number(),
});

const entityView = v.object({
  _id: v.id("entities"),
  missionId: v.id("missions"),
  sourceId: v.id("sourceRecords"),
  kind: v.union(...entityKinds.map((k) => v.literal(k))),
  name: v.string(),
  canonicalUrl: v.string(),
  attributes: v.array(v.object({ key: v.string(), value: v.string() })),
  summary: v.string(),
  expressedNeed: v.union(v.string(), v.null()),
  skillsOrOffer: v.array(v.string()),
  contactRoute: v.union(v.null(), v.object({
    kind: v.union(...contactKinds.map((k) => v.literal(k))),
    value: v.string(),
    publicSource: v.string(),
  })),
  extractionStatus: v.union(v.literal("extracted"), v.literal("snippet_only")),
  confidence: v.number(),
  firstSeenAt: v.number(),
  updatedAt: v.number(),
});

function bounded(value: string, length: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, length);
}

/** Normalized key used for name-based dedupe (legal suffixes stripped). */
export function normalizeEntityName(name: string) {
  return bounded(name.toLowerCase(), 160)
    .replace(/\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|company|plc|sa|bv|oy|pte)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A contact route is only stored when it names a real public source —
 * without provenance it is an unverified guess and is dropped entirely.
 */
function safeContactRoute(
  route: { kind: "email" | "form" | "linkedin"; value: string; publicSource: string | null } | null,
  pageUrl: string,
) {
  if (!route) return undefined;
  const value = bounded(route.value, 240);
  if (!value) return undefined;
  const resolved = normalizedUrl(route.publicSource) ?? normalizedUrl(new URL(value, pageUrl).toString());
  const source = resolved ?? normalizedUrl(new URL("/", pageUrl).toString());
  if (!source) return undefined;
  if (route.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return undefined;
  return { kind: route.kind, value, publicSource: source };
}

/**
 * Persist one extraction result for a mission source. Dedupes by canonical
 * URL, then by normalized name, merges sources, and records signals without
 * duplicating (entityId, evidenceUrl) pairs.
 */
export const upsertFromExtraction = internalMutation({
  args: {
    missionId: v.id("missions"),
    workspaceId: v.string(),
    sourceId: v.id("sourceRecords"),
    pageUrl: v.string(),
    extractionStatus: v.union(v.literal("extracted"), v.literal("snippet_only")),
    extraction: extractionInput,
  },
  returns: v.object({ entityId: v.id("entities"), created: v.boolean(), signalsRecorded: v.number() }),
  handler: async (ctx, args) => {
    const canonicalUrl = normalizedUrl(args.pageUrl) ?? args.pageUrl;
    const name = bounded(args.extraction.entityName, 160) || new URL(canonicalUrl).hostname;
    const nameLower = normalizeEntityName(name) || name.toLowerCase();
    const now = Date.now();

    const byUrl = await ctx.db.query("entities")
      .withIndex("by_missionId_and_canonicalUrl", (q) => q.eq("missionId", args.missionId).eq("canonicalUrl", canonicalUrl))
      .first();
    const byName = byUrl ?? await ctx.db.query("entities")
      .withIndex("by_missionId_and_nameLower", (q) => q.eq("missionId", args.missionId).eq("nameLower", nameLower))
      .first();

    const attributes = [
      ...(args.extraction.expressedNeed ? [{ key: "expressed_need", value: bounded(args.extraction.expressedNeed, 300) }] : []),
      ...args.extraction.skillsOrOffer.slice(0, 8).map((item) => ({ key: "offer", value: bounded(item, 120) })),
    ];
    const contactRouteValue = safeContactRoute(args.extraction.contactRoute, canonicalUrl);
    const confidence = Math.max(0, Math.min(1, args.extraction.confidence));

    let entityId: Id<"entities">;
    let created = false;
    if (byName) {
      // Merge: keep the strongest contact route, refresh summary, never
      // duplicate. A snippet-only entity can be upgraded by a real extraction.
      const upgrade = byName.extractionStatus === "snippet_only" && args.extractionStatus === "extracted";
      const mergedOffer = args.extraction.skillsOrOffer.slice(0, 8).map((item) => bounded(item, 120));
      const mergedSummary = bounded(args.extraction.summary, 600) || byName.summary;
      const mergedNeed = args.extraction.expressedNeed ? bounded(args.extraction.expressedNeed, 300) : byName.expressedNeed;
      await ctx.db.patch(byName._id, {
        name,
        nameLower,
        kind: args.extraction.entityType,
        attributes,
        summary: mergedSummary,
        expressedNeed: mergedNeed,
        skillsOrOffer: mergedOffer,
        searchText: searchableText([name, mergedSummary, mergedNeed, mergedOffer.join(" ")]),
        contactRoute: contactRouteValue ?? byName.contactRoute,
        extractionStatus: upgrade ? "extracted" : byName.extractionStatus,
        confidence: upgrade ? confidence : Math.max(byName.confidence, confidence),
        updatedAt: now,
      });
      entityId = byName._id;
    } else {
      const newSummary = bounded(args.extraction.summary, 600);
      const newNeed = args.extraction.expressedNeed ? bounded(args.extraction.expressedNeed, 300) : undefined;
      const newOffer = args.extraction.skillsOrOffer.slice(0, 8).map((item) => bounded(item, 120));
      entityId = await ctx.db.insert("entities", {
        workspaceId: args.workspaceId,
        missionId: args.missionId,
        sourceId: args.sourceId,
        kind: args.extraction.entityType,
        name,
        nameLower,
        canonicalUrl,
        attributes,
        summary: newSummary,
        expressedNeed: newNeed,
        skillsOrOffer: newOffer,
        searchText: searchableText([name, newSummary, newNeed, newOffer.join(" ")]),
        contactRoute: contactRouteValue,
        extractionStatus: args.extractionStatus,
        confidence,
        firstSeenAt: now,
        updatedAt: now,
      });
      created = true;
    }

    let signalsRecorded = 0;
    for (const signal of args.extraction.signals.slice(0, 5)) {
      const statement = bounded(signal.statement, 300);
      if (!statement) continue;
      const existing = await ctx.db.query("entitySignals")
        .withIndex("by_entityId_and_evidenceUrl", (q) => q.eq("entityId", entityId).eq("evidenceUrl", canonicalUrl))
        .collect();
      if (existing.some((row) => row.type === signal.type && row.statement === statement)) continue;
      await ctx.db.insert("entitySignals", {
        workspaceId: args.workspaceId,
        missionId: args.missionId,
        entityId,
        type: signal.type,
        statement,
        evidenceUrl: canonicalUrl,
        observedAt: now,
        confidence,
        createdAt: now,
      });
      signalsRecorded += 1;
    }

    return { entityId, created, signalsRecorded };
  },
});

/** Existing entity for a source, if any (extraction idempotency). */
export const entityForSource = internalQuery({
  args: { sourceId: v.id("sourceRecords") },
  returns: v.union(v.object({ _id: v.id("entities"), name: v.string() }), v.null()),
  handler: async (ctx, args) => {
    const entity = await ctx.db.query("entities")
      .withIndex("by_sourceId", (q) => q.eq("sourceId", args.sourceId))
      .first();
    return entity ? { _id: entity._id, name: entity.name } : null;
  },
});

/** Signal count for one entity (used by the idempotent extraction path). */
export const signalsForEntity = internalQuery({
  args: { entityId: v.id("entities") },
  returns: v.number(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("entitySignals")
      .withIndex("by_entityId", (q) => q.eq("entityId", args.entityId))
      .collect();
    return rows.length;
  },
});

/** Scraped sources in this mission that have no entity yet (extraction worklist). */
export const unextractedSources = internalQuery({
  args: { missionId: v.id("missions"), limit: v.number() },
  returns: v.array(v.object({ _id: v.id("sourceRecords"), url: v.string(), title: v.string() })),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(20, Math.floor(args.limit)));
    const sources = await ctx.db.query("sourceRecords")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .take(80);
    const result = [];
    for (const source of sources) {
      if (result.length >= limit) break;
      if (source.processingStatus !== "scraped") continue;
      const entity = await ctx.db.query("entities")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", source._id))
        .first();
      if (entity) continue;
      result.push({ _id: source._id, url: source.url, title: source.title });
    }
    return result;
  },
});

/** Reactive entity list for a mission (UI cards). */
export const listForMission = query({
  args: { missionId: v.id("missions") },
  returns: v.array(entityView),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("entities")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(60);
    return rows.map((row) => ({
      _id: row._id,
      missionId: row.missionId,
      sourceId: row.sourceId,
      kind: row.kind,
      name: row.name,
      canonicalUrl: row.canonicalUrl,
      attributes: row.attributes,
      summary: row.summary,
      expressedNeed: row.expressedNeed ?? null,
      skillsOrOffer: row.skillsOrOffer,
      contactRoute: row.contactRoute ?? null,
      extractionStatus: row.extractionStatus,
      confidence: row.confidence,
      firstSeenAt: row.firstSeenAt,
      updatedAt: row.updatedAt,
    }));
  },
});

/** Reactive signal timeline for a mission. */
export const listSignalsForMission = query({
  args: { missionId: v.id("missions") },
  returns: v.array(v.object({
    _id: v.id("entitySignals"),
    entityId: v.id("entities"),
    entityName: v.string(),
    type: v.string(),
    statement: v.string(),
    evidenceUrl: v.string(),
    observedAt: v.union(v.number(), v.null()),
    confidence: v.number(),
  })),
  handler: async (ctx, args) => {
    const signals = await ctx.db.query("entitySignals")
      .withIndex("by_missionId", (q) => q.eq("missionId", args.missionId))
      .order("desc")
      .take(80);
    const result = [];
    for (const signal of signals) {
      const entity = await ctx.db.get(signal.entityId);
      result.push({
        _id: signal._id,
        entityId: signal.entityId,
        entityName: entity?.name ?? "Unknown entity",
        type: signal.type,
        statement: signal.statement,
        evidenceUrl: signal.evidenceUrl,
        observedAt: signal.observedAt ?? null,
        confidence: signal.confidence,
      });
    }
    return result;
  },
});
