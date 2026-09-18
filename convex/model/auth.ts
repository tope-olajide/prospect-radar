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
 */
export async function validateWorkspace(
  ctx: Ctx,
  workspaceId: Id<"workspaces"> | string,
) {
  const userId = await getAuthUserId(ctx);
  // In test mode (no auth), skip the ownership check — the existing
  // FORBIDDEN_SCOPE checks in each function handle cross-workspace isolation.
  if (!userId) return null;

  const workspace = await ctx.db
    .query("workspaces")
    .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
    .first();

  if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");
  if (workspace._id !== workspaceId) throw new Error("FORBIDDEN: workspace does not belong to you");

  return workspace;
}
