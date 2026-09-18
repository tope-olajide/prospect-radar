# Phase 0 — environment safety and data reset map

Status: **audit only. Nothing was changed, deployed, rotated, or deleted.**
Produced from the repository and the two Convex deployments. Contains no secret
values — variable *names* and value *hashes* only.

---

## 1. Critical finding: plaintext credentials in `.env.local`

`.env.local` is **untracked and gitignored** (`.gitignore:70 → .env.*`) and no
tracked file contains a secret value (verified: a repo-wide search for
`fc-…`, `am_us_…`, `sk-ws-…`, `whsec_…` patterns returns nothing outside
documentation prose and a regex literal in `scripts/signedWebhookProbe.mjs`).

The problem is the file's contents: it stores **live credentials in plaintext**,
both as comments and as copy-paste `npx convex env set …` command lines —
including a **production** Firecrawl key. It therefore mixes development and
production credentials in one file, which is the same isolation defect described
in §3.

Exposed by name (values not reproduced here): `OPENAI_API_KEY` (DashScope),
`FIRECRAWL_API_KEY` (dev **and** prod), `AGENTMAIL_API_KEY`,
`AGENTMAIL_WEBHOOK_SECRET`.

These values also passed through the agent session transcript while this audit
was being run. **Treat every one of them as compromised** and follow §6.

## 2. `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` — where they really come from

| Question | Finding |
|---|---|
| Source | The **agent session's process environment**, not the project. A non-shell child (`node -e`) sees them too. |
| Why they override `.env.local` | Vite loads `.env*` files *after* real environment variables and never overwrites an existing `process.env` key, so the injected values win for every Vite command. |
| Which commands inherit them | `npm run build`, `npm run dev`, `npm run deploy` — anything Vite touches. `vitest` is unaffected (convex-test is in-memory). |
| Deployment dependency | **Yes, in practice.** `npm run deploy` builds the static bundle from whatever `VITE_CONVEX_URL` resolves to. The runtime injection is the only reason a localhost bundle was never shipped; that is luck, not design. |
| On-disk sources ruled out | `.env.local` (says `127.0.0.1:3210` — the opposite), `.env.example`, Windows user/system env, `~/.bashrc`, `/etc/profile.d/*`, direnv/mise, Freebuff `settings.json`, Freebuff per-project state. |
| Second trap | `.env.local` also sets `CONVEX_DEPLOYMENT=local:local-tope_olajide-prospect_radar`, which points CLI commands at the **local** backend. |

**In your own terminal the same commands target the opposite backend**, because
the injection is specific to this agent session. Two environments, two different
targets, same command — which is exactly the ambiguity to remove.

Recommended shape (not executed): keep `.env.local` authoritative for dev, and
make every production build/deploy pass its target explicitly, e.g.

```bash
CONVEX_DEPLOYMENT=prod:<deployment> \
VITE_CONVEX_URL=https://<deployment>.convex.cloud \
npx @convex-dev/static-hosting deploy --skip-convex
```

Verified safe to keep the variables *set*; the defect is that nothing states
which deployment a command is aimed at, so the target should be named on the
command line rather than inherited.

## 3. Credential separation between deployments

Value hashes compared across the two deployments (dev = local, prod =
`wry-walrus-528`):

| Variable | dev | prod | Verdict |
|---|---|---|---|
| `AGENTMAIL_API_KEY` | `769c07c33c` | `769c07c33c` | **SHARED** |
| `FIRECRAWL_API_KEY` | `9af04ed941` | `9af04ed941` | **SHARED** |
| `OPENAI_API_KEY` | `b0016973e8` | `b0016973e8` | **SHARED** |
| `OPENAI_BASE_URL` | `e7ce1b2fec` | `e7ce1b2fec` | **SHARED** (DashScope) |
| `OPENAI_MODEL` | `4d43a29ac4` | `4d43a29ac4` | **SHARED** (`qwen-max`) |
| `SITE_URL` | `4e90ec8f9d` | `23c7a46538` | distinct ✅ |
| `JWT_PRIVATE_KEY` | `8225f2795e` | `15bce202f4` | distinct ✅ |
| `AGENTMAIL_WEBHOOK_SECRET` | *absent* | present | prod-only ✅ |

Consequences of the shared row:

- A **local** run can call production-account AgentMail and **send real email**,
  spend production Firecrawl credits, and bill the production model key.
- A "live test" against dev can create AgentMail threads that are
  indistinguishable from production outreach.
- Only one AgentMail inbox allowance exists across both, which is the same
  account-level limit that blocked the outreach proof earlier.

Isolation needs either separate provider accounts/projects/keys per environment,
or a deliberate, documented decision to run dev against the same providers with
the understanding that dev can send.

## 4. Which deployment is which

| | Deployment | Points at | Holds |
|---|---|---|---|
| Development | `local:local-tope_olajide-prospect_radar` (team `tope-olajide`, project `prospect-radar`) | `http://127.0.0.1:3210` / `:3211` | Local dev data, whatever this session created |
| Production | prod / `wry-walrus-528` | `https://wry-walrus-528.convex.site` | The live site judges would open |

Row counts per table have **not** been captured yet, and cannot be read from
production without deploying or running against it. Before any wipe, capture
counts from both deployments with a read-only query so the reset is a
deliberate act on known contents.

Reset-time hazard: four crons run continuously and can write during or after a
wipe — `follow-up sweep` (15 min), `stale run reaper` (10 min), `crawl watchdog`
(10 min), `data source resync` (24 h). A reset should be performed knowing those
sweeps will observe the new state.

## 5. Data ownership and reset map

Ownership path in the schema is `workspaceId` → `missions` → child rows. Tables
without their own `workspaceId` are reachable only through `missionId`.

### User data — belongs to an authenticated workspace

| Table | Ownership | Reset verdict |
|---|---|---|
| `workspaces` | `ownerId → users` | **Keep.** Deleting breaks the user↔workspace binding. |
| `missions` | `workspaceId` | Deletable (dev data) |
| `missionPlans`, `agentRuns`, `runEvents`, `runSteps`, `missionQueries` | via `missionId` | Deletable with their mission |
| `contextFacts` | `workspaceId` (+ optional `missionId`) | Deletable; **workspace-scoped facts are the user's profile** — deleting them loses confirmed context |
| `researchJobs`, `sourceRecords`, `discoveries`, `matches` | via `missionId` | Deletable |
| `entities`, `entitySignals` | `workspaceId` | Deletable |
| `agentInboxes` | `workspaceId` | Deletable row **but the AgentMail inbox behind it persists at the provider** — delete the row only with a decision about the inbox |
| `actionDrafts` | `workspaceId` + `missionId` | Deletable |
| `approvals` | **only `actionId`** — no workspace, no mission | Must be deleted *with* its draft; it is the one table that cannot be scoped independently ⚠ |
| `inboxThreads`, `inboxMessages` | `workspaceId`, optional `missionId` | Deletable; represents real provider threads |
| `replyClassifications` | via `messageId` | Deletable |
| `outcomes`, `followUps`, `meetings`, `outreachSequences` | `workspaceId` + `missionId` | Deletable |
| `formTemplates`, `formProposals`, `formSubmissions` | `workspaceId` + `missionId` | Deletable |
| `creditCharges` | `workspaceId` + `missionId` | Deletable, but it is spend history |
| `workspaceBudgets` | `workspaceId` | **Keep** — configuration, not content |
| `dataSources`, `dataSourceChunks` | `workspaceId` | Deletable, but these are the user's uploaded profile material |
| Auth tables (`users`, `authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes`, `authVerifiers`, `authRateLimits`) | `users` | **Keep.** Deleting users destroys sign-in and orphans `workspaces.ownerId`. |

### System / must survive

| Table | Why |
|---|---|
| `providerEvents` | Webhook dedup. Deleting it makes the provider replay events already processed. |
| `workspaceBudgets` | Spend configuration |
| Component state (`agentmail/`, `firecrawl/`, `static-hosting` component tables) | Provider sync state and deployments; not a substitute for provider-side cleanup |

### Ownership gaps worth fixing regardless of the reset

1. `approvals` carries no `workspaceId`/`missionId`; authority is derived from the
   draft. Auditable, but it cannot be scoped by workspace in one query.
2. `entities`, `entitySignals` are `workspaceId`-scoped but also `missionId`-scoped,
   so a partial reset can leave an entity whose mission is gone.
3. Rows created before authentication existed do not carry an owner. This is the
   set the reset is actually meant to remove.

## 6. Rotation checklist (user actions — not performed)

Treat each as compromised: revoke/invalidate at the provider, issue a new one,
install it only in its intended environment, then verify.

| Credential | Where to act | Then |
|---|---|---|
| `VERCEL_TOKEN` | Vercel account → revoke token (it was stored in plaintext in `~/.bashrc`) | Remove the line from `~/.bashrc` |
| `JWT_PRIVATE_KEY` + `JWKS` (prod) | `npx convex env set JWT_PRIVATE_KEY "<new PEM>" --prod` (± matching `JWKS`) | Verify sign-in on the live site; all sessions invalidate |
| `OPENAI_API_KEY` (DashScope) | Provider console | Set separately for dev and prod |
| `FIRECRAWL_API_KEY` | Firecrawl dashboard — **two** keys are exposed (dev and the prod one in `.env.local`) | One key per environment |
| `AGENTMAIL_API_KEY` | AgentMail dashboard | One key/account per environment |
| `AGENTMAIL_WEBHOOK_SECRET` (prod) | AgentMail webhook settings | Update prod env; re-verify the signed webhook path |
| `.env.local` itself | Local file | Keep it authoritative for **dev only**; remove prod values from it |

## 7. What is blocked, and what I need

Blocked until you approve, per the PM gate:

1. Rotation of the credentials above (needs your provider accounts).
2. Provider-side credential separation (needs keys that don't exist yet).
3. A read-only row count of both deployments before any wipe.
4. The wipe itself — no purge mutation exists in the repo today; the previous one
   was a one-off and has been removed, so a reset needs a deliberate, reviewed
   path rather than a leftover command.
5. Deployment of the Phase 1 loop and the live autonomous trace.

Not blocked, and not done yet: the live trace cannot be meaningful until the
environment it runs in is isolated, because a "live test" today would call
production AgentMail and could send real mail from the shared account.
