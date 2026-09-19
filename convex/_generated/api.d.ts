/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actionDecision from "../actionDecision.js";
import type * as actionStore from "../actionStore.js";
import type * as actions from "../actions.js";
import type * as ai from "../ai.js";
import type * as auth from "../auth.js";
import type * as budget from "../budget.js";
import type * as claimGuard from "../claimGuard.js";
import type * as commandCenter from "../commandCenter.js";
import type * as context from "../context.js";
import type * as contextCheck from "../contextCheck.js";
import type * as contextCheckQuery from "../contextCheckQuery.js";
import type * as contextRequirements from "../contextRequirements.js";
import type * as crawlWatchdog from "../crawlWatchdog.js";
import type * as crons from "../crons.js";
import type * as dataFlows from "../dataFlows.js";
import type * as dataSourceText from "../dataSourceText.js";
import type * as dataSources from "../dataSources.js";
import type * as entityStore from "../entityStore.js";
import type * as formFlows from "../formFlows.js";
import type * as formStore from "../formStore.js";
import type * as hash from "../hash.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as intentStrategy from "../intentStrategy.js";
import type * as missionOrchestrator from "../missionOrchestrator.js";
import type * as missions from "../missions.js";
import type * as missionsInternal from "../missionsInternal.js";
import type * as model_auth from "../model/auth.js";
import type * as orchestratorStore from "../orchestratorStore.js";
import type * as outcomes from "../outcomes.js";
import type * as outreach from "../outreach.js";
import type * as outreachStore from "../outreachStore.js";
import type * as plans from "../plans.js";
import type * as providerErrors from "../providerErrors.js";
import type * as relationships from "../relationships.js";
import type * as research from "../research.js";
import type * as researchStore from "../researchStore.js";
import type * as retryPolicy from "../retryPolicy.js";
import type * as runReaper from "../runReaper.js";
import type * as runState from "../runState.js";
import type * as runs from "../runs.js";
import type * as sequenceRunner from "../sequenceRunner.js";
import type * as system from "../system.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actionDecision: typeof actionDecision;
  actionStore: typeof actionStore;
  actions: typeof actions;
  ai: typeof ai;
  auth: typeof auth;
  budget: typeof budget;
  claimGuard: typeof claimGuard;
  commandCenter: typeof commandCenter;
  context: typeof context;
  contextCheck: typeof contextCheck;
  contextCheckQuery: typeof contextCheckQuery;
  contextRequirements: typeof contextRequirements;
  crawlWatchdog: typeof crawlWatchdog;
  crons: typeof crons;
  dataFlows: typeof dataFlows;
  dataSourceText: typeof dataSourceText;
  dataSources: typeof dataSources;
  entityStore: typeof entityStore;
  formFlows: typeof formFlows;
  formStore: typeof formStore;
  hash: typeof hash;
  http: typeof http;
  inbox: typeof inbox;
  intentStrategy: typeof intentStrategy;
  missionOrchestrator: typeof missionOrchestrator;
  missions: typeof missions;
  missionsInternal: typeof missionsInternal;
  "model/auth": typeof model_auth;
  orchestratorStore: typeof orchestratorStore;
  outcomes: typeof outcomes;
  outreach: typeof outreach;
  outreachStore: typeof outreachStore;
  plans: typeof plans;
  providerErrors: typeof providerErrors;
  relationships: typeof relationships;
  research: typeof research;
  researchStore: typeof researchStore;
  retryPolicy: typeof retryPolicy;
  runReaper: typeof runReaper;
  runState: typeof runState;
  runs: typeof runs;
  sequenceRunner: typeof sequenceRunner;
  system: typeof system;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  firecrawl: import("@firecrawl/firecrawl-convex/_generated/component.js").ComponentApi<"firecrawl">;
  agentmail: import("../agentmail/_generated/component.js").ComponentApi<"agentmail">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
