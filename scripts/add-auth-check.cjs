/**
 * Add validateWorkspace(ctx, args.workspaceId) to every public query/mutation/action
 * that takes workspaceId in its args. This ensures the workspace belongs to the
 * authenticated user without changing function signatures.
 *
 * Run: node scripts/add-auth-check.js
 */
const fs = require("fs");

const FILES = [
  "convex/missions.ts",
  "convex/plans.ts",
  "convex/orchestratorStore.ts",
  "convex/context.ts",
  "convex/dataSources.ts",
  "convex/commandCenter.ts",
  "convex/budget.ts",
  "convex/formStore.ts",
  "convex/outcomes.ts",
  "convex/relationships.ts",
  "convex/outreachStore.ts",
  "convex/inbox.ts",
  "convex/researchStore.ts",
  "convex/entityStore.ts",
  "convex/outreach.ts",
  "convex/research.ts",
  "convex/formFlows.ts",
  "convex/dataFlows.ts",
  "convex/ai.ts",
];

let totalChanges = 0;

for (const file of FILES) {
  let c;
  try { c = fs.readFileSync(file, "utf8"); } catch { console.log("SKIP:", file); continue; }
  const orig = c;

  // Skip files that already have validateWorkspace
  if (c.includes("validateWorkspace")) {
    console.log("ALREADY DONE:", file);
    continue;
  }

  // Check if file has any public functions with workspaceId
  if (!c.includes("workspaceId: v.string()")) {
    console.log("NO WS ARGS:", file);
    continue;
  }

  // 1. Add import for validateWorkspace
  const depth = file.split("/").length - 1;
  const rel = depth === 1 ? "./model/auth" : "../model/auth";
  
  // Find the last import line
  const lines = c.split("\n");
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("import ")) {
      lastImportIdx = i;
    }
  }
  
  if (lastImportIdx >= 0) {
    lines.splice(lastImportIdx + 1, 0, `import { validateWorkspace } from "${rel}";`);
  }
  c = lines.join("\n");

  // 2. For each public query/mutation/action with workspaceId in args,
  // add validateWorkspace after the handler opening
  // Pattern: handler: async (ctx, args) => {
  // We need to find public functions (not internal*)
  
  const funcRegex = /export const (\w+) = (query|mutation)\(\{/g;
  let match;
  const insertions = [];

  while ((match = funcRegex.exec(c)) !== null) {
    const funcName = match[1];
    const funcType = match[2];
    
    // Find the handler line
    const afterMatch = c.slice(match.index);
    const handlerMatch = afterMatch.match(/handler:\s*async\s*\(ctx(?:,\s*args)?\)\s*=>\s*\{/);
    if (!handlerMatch) continue;
    
    const handlerPos = match.index + handlerMatch.index + handlerMatch[0].length;
    
    // Check if this function's args contain workspaceId
    // Look between "args: {" and "handler:"
    const argsSection = afterMatch.slice(0, handlerMatch.index);
    if (!argsSection.includes("workspaceId: v.string()")) continue;
    
    // Check if already has validateWorkspace
    const handlerBody = afterMatch.slice(handlerMatch.index, handlerMatch.index + 300);
    if (handlerBody.includes("validateWorkspace")) continue;
    
    insertions.push({
      funcName,
      funcType,
      handlerPos,
    });
  }

  // Insert in reverse order
  for (let i = insertions.length - 1; i >= 0; i--) {
    const ins = insertions[i];
    const insertText = "\n    await validateWorkspace(ctx, args.workspaceId);";
    c = c.slice(0, ins.handlerPos) + insertText + c.slice(ins.handlerPos);
    console.log(`  + ${ins.funcName} (${ins.funcType})`);
    totalChanges++;
  }

  if (c !== orig) {
    fs.writeFileSync(file, c, "utf8");
    console.log(`UPDATED: ${file}`);
  } else {
    console.log(`UNCHANGED: ${file}`);
  }
}

console.log(`\nTotal functions hardened: ${totalChanges}`);
