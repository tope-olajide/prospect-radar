/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      cancelSend: FunctionReference<
        "mutation",
        "internal",
        { outboundId: string },
        any,
        Name
      >;
      cleanupFinalizedOutbound: FunctionReference<
        "mutation",
        "internal",
        { olderThan?: number },
        any,
        Name
      >;
      createInbox: FunctionReference<
        "action",
        "internal",
        {
          request: {
            client_id?: string;
            display_name?: string;
            domain?: string;
            username?: string;
          };
        },
        any,
        Name
      >;
      deleteInbox: FunctionReference<
        "action",
        "internal",
        { inboxId: string },
        any,
        Name
      >;
      enqueueSend: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            initialBackoffMs: number;
            onEvent?: { fnHandle: string };
            onMessageReceived?: { fnHandle: string };
            retryAttempts: number;
          };
          inboxId: string;
          kind: "send" | "reply" | "reply_all" | "forward";
          parentMessageId?: string;
          payload: {
            attachments?: Array<{
              content: string;
              content_type?: string;
              filename: string;
            }>;
            bcc?: string | Array<string>;
            cc?: string | Array<string>;
            headers?: Record<string, string>;
            html?: string;
            labels?: Array<string>;
            reply_all?: boolean;
            reply_to?: string | Array<string>;
            subject?: string;
            text?: string;
            to?: string | Array<string>;
          };
        },
        any,
        Name
      >;
      getCachedInbox: FunctionReference<
        "query",
        "internal",
        { inboxId: string },
        any,
        Name
      >;
      getInboxRemote: FunctionReference<
        "action",
        "internal",
        { inboxId: string },
        any,
        Name
      >;
      getMessage: FunctionReference<
        "action",
        "internal",
        { inboxId: string; messageId: string },
        any,
        Name
      >;
      getOutboundStatus: FunctionReference<
        "query",
        "internal",
        { outboundId: string },
        any,
        Name
      >;
      getThread: FunctionReference<
        "action",
        "internal",
        { inboxId: string; threadId: string },
        any,
        Name
      >;
      handleEvent: FunctionReference<
        "mutation",
        "internal",
        {
          config: {
            initialBackoffMs: number;
            onEvent?: { fnHandle: string };
            onMessageReceived?: { fnHandle: string };
            retryAttempts: number;
          };
          event: any;
        },
        any,
        Name
      >;
      listCachedInboxes: FunctionReference<"query", "internal", {}, any, Name>;
      listInboundMessages: FunctionReference<
        "query",
        "internal",
        { inboxId?: string; threadId?: string },
        any,
        Name
      >;
      listInboxes: FunctionReference<
        "action",
        "internal",
        { ascending?: boolean; limit?: number; page_token?: string },
        any,
        Name
      >;
      listThreads: FunctionReference<
        "action",
        "internal",
        {
          after?: string;
          before?: string;
          inboxId: string;
          labels?: Array<string>;
          limit?: number;
          page_token?: string;
        },
        any,
        Name
      >;
    };
  };
