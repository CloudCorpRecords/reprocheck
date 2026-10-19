#!/usr/bin/env node
/**
 * reprocheck CLI.
 *
 *   reprocheck run --repo <path> --base <ref> --head <ref> --cmd "<command>"
 *                  [--test-file <repo-relative path>] [--setup "<command>"]
 *                  [--timeout <seconds>] [--json]
 *   reprocheck mcp
 *
 * Exit codes: 0 VERIFIED, 1 any other completed verdict, 2 ERROR or usage.
 * The working tree is never modified; both runs use temporary worktrees.
 */
import { exitCodeFor, renderReport, runReproCheck, VERSION } from "./repro.js";

function usage(): never {
  console.error(`Usage:
  reprocheck run --repo <path> --base <ref> --head <ref> --cmd "<command>" [--test-file <path>] [--setup "<command>"] [--timeout <seconds>] [--json]
  reprocheck mcp
  reprocheck --version`);
  process.exit(2);
}

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

function has(args: string[], name: string): boolean {
  return args.includes(name);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    await import("./mcp.js");
    return;
  }
  if (cmd !== "run") usage();
  const repoPath = flag(rest, "--repo");
  const baseRef = flag(rest, "--base");
  const headRef = flag(rest, "--head");
  const command = flag(rest, "--cmd");
  if (!repoPath || !baseRef || !headRef || !command) usage();
  const timeoutRaw = flag(rest, "--timeout");
  const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutSeconds !== undefined && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    usage();
  }
  try {
    const report = await runReproCheck({
      repoPath,
      baseRef,
      headRef,
      command,
      testFile: flag(rest, "--test-file"),
      setupCommand: flag(rest, "--setup"),
      timeoutSeconds,
    });
    if (has(rest, "--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderReport(report));
    process.exit(exitCodeFor(report.verdict));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

void main();
