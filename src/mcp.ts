/**
 * reprocheck MCP server. Tools: run_repro_check.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runReproCheck, VERSION } from "./repro.js";

const server = new McpServer({ name: "reprocheck", version: VERSION });

server.tool(
  "run_repro_check",
  "Verify a fix the honest way: run the same repro command in clean git worktrees of the base ref and the head ref. VERIFIED only when it fails on the base and passes on the head. NOT-REPRODUCED when it passes on the base too, STILL-FAILING when it fails on both, BROKEN-BY-HEAD when the change introduced the failure, ERROR when a run could not complete. An uncommitted repro or regression test file can be copied into both worktrees with testFile. The working tree is never modified.",
  {
    repoPath: z.string().describe("Path to a local git repository"),
    baseRef: z.string().describe("Base ref (the code before the fix), e.g. main or a commit SHA"),
    headRef: z.string().describe("Head ref (the code with the fix), e.g. HEAD or a branch"),
    command: z.string().describe("The repro command to run in both worktrees, e.g. npm test or node repro.mjs"),
    testFile: z
      .string()
      .optional()
      .describe("Repo-relative path of an uncommitted repro/test file in the working tree to copy into both worktrees"),
    setupCommand: z
      .string()
      .optional()
      .describe("Optional setup command run in each worktree first, e.g. npm install"),
    timeoutSeconds: z.number().optional().describe("Per-command timeout in seconds, default 300"),
  },
  async (args) => {
    const report = await runReproCheck(args);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
