# AgentMail component (vendored)

These files are the AgentMail Convex component from `@agentmail/convex@0.1.0`
(`src/component/`), mounted as a **local component**. Two defects in the
published package make it unusable from application code on Convex 1.46, so it
is copied here and corrected. `@agentmail/convex` itself is still installed — its
`AgentMail` client class and webhook verifier are used unchanged.

## Defect 1 — the app cannot reference the component at all

Calling `components.agentmail.lib.createInbox` failed with:

```
Child component ... does not export [PathComponent("lib"), PathComponent("createInbox")]
```

**Root cause:** the parent app can only reference a component's **public**
functions. `@agentmail/convex` declares its entire app-facing surface with the
`internal*` helpers (`export const createInbox = internalAction({...})`), so
nothing is exposed to the parent.

Verified three ways:

1. Convex's own codegen for this component emitted a `ComponentApi` containing
   exactly the 8 functions declared with `mutation`/`query` — and none of the 12
   declared with `internalAction`/`internalMutation`/`internalQuery`.
2. Every `components.agentmail.lib.*` call failed at runtime on three separate
   mounts (the default mount, a freshly named mount, and a mount with no env
   forwarding), while the same functions run fine through
   `npx convex run --component agentmail lib:...` — the CLI reaches component
   internals that an app cannot.
3. The two components that do work here both declare their parent-facing
   surface as public: Firecrawl's `lib.{search,scrape,map}` are `action(...)`,
   and workpool's four `lib` mutations and two queries are `mutation`/`query`.

The package's hand-authored `component.d.ts` hides this: it types all of `lib`
as callable, so the failure is invisible to TypeScript and only appears at
runtime.

**Fix:** the 7 functions the app calls are declared `action(...)` rather than
`internalAction(...)` — `createInbox`, `listInboxes`, `getInboxRemote`,
`deleteInbox`, `listThreads`, `getThread`, `getMessage`. Everything else
(`upsertInbox`, `removeInbox`, `markSendFailed`, `getOutboundForSend`,
`performSend`, `onSendComplete`) stays internal, because it is plumbing reached
through the component's own `internal.*` references and the workpool callback.

`convex/outreach.ts` casts the component reference when constructing the client:
Convex's generated type labels parent-callable functions `"internal"` (component
functions are never exposed to clients) while the package's hand-authored type
labels them by source visibility (`"public"`). Same runtime surface, different
label — see the comment at the cast.

## Defect 2 — the component cannot see its own credentials

The published definition is `defineComponent("agentmail")` with no `env`, but
`utils.ts` reads `process.env.AGENTMAIL_API_KEY`. Convex only exposes environment
variables to a component that declares them, so the key was invisible and every
provider call failed with "AGENTMAIL_API_KEY is not set on this Convex
deployment". The parent cannot compensate — `app.use(agentmail, { env })` has
nothing to bind to.

**Fix:** `convex.config.ts` declares the three variables, and
`convex/convex.config.ts` forwards the deployment values into the mount, exactly
as the Firecrawl mount does.

## Verified after the fix

- `components.agentmail.lib.*` resolves from the app: `outreach:provisionInbox`
  now reaches the AgentMail API and returns a real provider response instead of
  "does not export".
- Read paths work end to end: `lib.listInboxes` returns the account's real
  inboxes from inside the component.
- 158 tests pass, `tsc` clean, deployment typechecks.

The remaining blocker is on the AgentMail account, not in this code: the plan
allows 3 inboxes and all 3 are occupied, so `createInbox` returns
`403 LimitExceededError: Inbox limit exceeded`. Delete a leftover inbox (or
upgrade the plan) to free a slot.

## Updating

Re-copy `src/component/*.ts` from a new `@agentmail/convex` release, then keep:

1. Any function the app calls declared `action`/`query`/`mutation`, not
   `internal*`.
2. The `env` block in `convex.config.ts`.
3. The env forwarding in `convex/convex.config.ts`.

If a future release exposes a public surface and declares its own env, delete
this directory and mount the package directly again.
