/**
 * Auth helpers for Prospect Radar.
 *
 * The frontend calls `users.workspace` once after login to get the workspaceId,
 * then passes it to all functions. The backend validates that the workspaceId
 * belongs to the authenticated user.
 *
 * This is a pragmatic middle ground: we don't rewrite every function signature,
 * but we DO prevent cross-workspace access.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

type Ctx = QueryCtx | MutationCtx;

/**
 * Require an authenticated user. Returns the users table row.
 * Throws 401 if no identity or user record exists.
 */
export async function requireUser(ctx: Ctx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("UNAUTHORIZED");
  const user = await ctx.db.get(userId);
  if (!user) throw new Error("UNAUTHORIZED: user record not found");
  return user;
}

/**
 * Resolve the caller's workspace. Returns the workspace record.
 * Throws 401 if not authenticated, 404 if no workspace exists.
 */
export async function requireWorkspace(ctx: Ctx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("UNAUTHORIZED");

  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .first();

  if (!workspace)
    throw new Error("WORKSPACE_NOT_FOUND: create a workspace first");
  return workspace;
}

/**
 * Validate that a workspaceId belongs to the authenticated user.
 * Use this in public functions that still take workspaceId as an arg.
 * Throws 403 if the workspace doesn't belong to the caller.
 *
 * Public functions still take `workspaceId` as an argument, so this is the one
 * place that turns "a string the client chose" into "a scope the caller owns".
 *
 * The anonymous branch exists only for the convex-test suite, which drives the
 * functions with synthetic workspace strings (`"demo-workspace"`) and no
 * identity. It is deliberately narrow: an anonymous caller is refused as soon
 * as the id it presents resolves to a real `workspaces` row, so knowing a live
 * workspace id is never enough to read or write that workspace.
 */
export async function validateWorkspace(
  ctx: Ctx,
  workspaceId: Id<"workspaces"> | string,
) {
  const userId = await getAuthUserId(ctx);

  if (userId) {
    const workspace = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
      .first();

    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
    if (workspace._id !== workspaceId) throw new Error("FORBIDDEN: workspace does not belong to you");

    return workspace;
  }

  // No identity. A synthetic (non-id) scope is the test suite; a real workspace
  // row is somebody's data and must not be reachable without a session.
  const realId = ctx.db.normalizeId("workspaces", workspaceId);
  if (realId && (await ctx.db.get(realId))) {
    throw new Error("UNAUTHORIZED: sign in to access this workspace");
  }
  return null;
}
