/**
 * User and workspace management.
 *
 * - current: returns the authenticated user (or null)
 * - workspace: returns the user's workspace (or null)
 * - provisionWorkspace: creates workspace on first sign-in
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { query, mutation } from "./_generated/server";

/** Return the currently authenticated user, or null. */
export const current = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return ctx.db.get(userId);
  },
});

/** Return the authenticated user's workspace, or null. */
export const workspace = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    return ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
      .first();
  },
});

/**
 * Provision a workspace for the authenticated user.
 * Called once after first sign-in. Idempotent — returns existing workspace
 * if one already exists.
 */
export const provisionWorkspace = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("UNAUTHORIZED");

    // Check for existing workspace
    const existingWorkspace = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerId", (q) => q.eq("ownerId", userId))
      .first();

    if (existingWorkspace) return { workspaceId: existingWorkspace._id };

    // Get user name for workspace name
    const user = await ctx.db.get(userId);
    const workspaceId = await ctx.db.insert("workspaces", {
      ownerId: userId,
      name: `${user?.name ?? "My"} workspace`,
      createdAt: Date.now(),
    });

    return { workspaceId };
  },
});
