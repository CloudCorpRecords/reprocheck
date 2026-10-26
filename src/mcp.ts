/**
 * reprocheck MCP server. Tools: run_repro_check, detect_test_runners.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runReproCheck, VERSION } from "./repro.js";
import { detectRunners } from "./runners.js";

const server = new McpServer({ name: "reprocheck", version: VERSION });

server.tool(
  "run_repro_check",
  "Verify a fix the honest way: run the same repro in clean git worktrees of the base ref and the head ref. VERIFIED only when it fails on the base and passes on the head. NOT-REPRODUCED when it passes on the base too, STILL-FAILING when it fails on both, BROKEN-BY-HEAD when the change introduced the failure, ERROR when a run could not complete. Give either a raw command, or a native runner (pytest, go, or auto) with an optional testFile and testName, and reprocheck builds the real pytest or go test command itself. An uncommitted repro or regression test file can be copied into both worktrees with testFile. The report includes a machine readable receipt with the red (base) and green (head) evidence. The working tree is never modified.",
  {
    repoPath: z.string().describe("Path to a local git repository"),
    baseRef: z.string().describe("Base ref (the code before the fix), e.g. main or a commit SHA"),
    headRef: z.string().describe("Head ref (the code with the fix), e.g. HEAD or a branch"),
    command: z
      .string()
      .optional()
      .describe("The raw repro command to run in both worktrees, e.g. npm test. Omit when runner is given"),
    runner: z
      .enum(["pytest", "go", "auto"])
      .optional()
      .describe("Native test runner to use instead of a raw command: pytest, go, or auto (detect from the repo)"),
    testName: z
      .string()
      .optional()
      .describe("A single named test for a native runner, e.g. test_add for pytest or TestAdd for go test"),
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

server.tool(
  "detect_test_runners",
  "Detect which native test runners a local repository supports (pytest and/or go test), with the filesystem evidence for each and the test files found. Runs no code from the target repository.",
  {
    repoPath: z.string().describe("Path to a local repository or directory"),
  },
  async ({ repoPath }) => {
    const runners = detectRunners(repoPath);
    return {
      content: [
        { type: "text" as const, text: JSON.stringify({ repo: repoPath, runners }, null, 2) },
      ],
    };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
