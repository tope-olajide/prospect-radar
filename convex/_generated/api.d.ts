/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ai from "../ai.js";
import type * as budget from "../budget.js";
import type * as commandCenter from "../commandCenter.js";
import type * as context from "../context.js";
import type * as crons from "../crons.js";
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
import type * as runState from "../runState.js";
import type * as runs from "../runs.js";
import type * as sequenceRunner from "../sequenceRunner.js";
import type * as system from "../system.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ai: typeof ai;
  budget: typeof budget;
  commandCenter: typeof commandCenter;
  context: typeof context;
  crons: typeof crons;
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
  runState: typeof runState;
  runs: typeof runs;
  sequenceRunner: typeof sequenceRunner;
  system: typeof system;
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
  agentmail: import("@agentmail/convex/_generated/component.js").ComponentApi<"agentmail">;
  staticHosting: import("@convex-dev/static-hosting/_generated/component.js").ComponentApi<"staticHosting">;
};
