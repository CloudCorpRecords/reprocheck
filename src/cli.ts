#!/usr/bin/env node
/**
 * reprocheck CLI.
 *
 *   reprocheck run --repo <path> --base <ref> --head <ref> --cmd "<command>"
 *                  [--test-file <repo-relative path>] [--setup "<command>"]
 *                  [--timeout <seconds>] [--json] [--receipt <path>]
 *   reprocheck run --repo <path> --base <ref> --head <ref>
 *                  --runner pytest|go|auto [--test-file <path>]
 *                  [--test-name <name>] [--timeout <seconds>]
 *                  [--json] [--receipt <path>]
 *   reprocheck detect --repo <path> [--json]
 *   reprocheck mcp
 *
 * Exit codes: 0 VERIFIED, 1 any other completed verdict, 2 ERROR or usage.
 * The working tree is never modified; both runs use temporary worktrees.
 */
import { writeFile } from "node:fs/promises";
import { exitCodeFor, renderReport, runReproCheck, VERSION } from "./repro.js";
import { detectRunners } from "./runners.js";
import type { RunnerId } from "./types.js";

function usage(): never {
  console.error(`Usage:
  reprocheck run --repo <path> --base <ref> --head <ref> --cmd "<command>" [--test-file <path>] [--setup "<command>"] [--timeout <seconds>] [--json] [--receipt <path>]
  reprocheck run --repo <path> --base <ref> --head <ref> --runner pytest|go|auto [--test-file <path>] [--test-name <name>] [--timeout <seconds>] [--json] [--receipt <path>]
  reprocheck detect --repo <path> [--json]
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
  if (cmd === "detect") {
    const repoPath = flag(rest, "--repo");
    if (!repoPath) usage();
    const detected = detectRunners(repoPath);
    if (has(rest, "--json")) {
      console.log(JSON.stringify({ repo: repoPath, runners: detected }, null, 2));
    } else if (detected.length === 0) {
      console.log("No native test runners detected (no pytest or Go test setup found)");
    } else {
      for (const d of detected) {
        console.log(`${d.id}: evidence ${d.evidence.join(", ")}; test files ${d.testFiles.join(", ") || "none"}`);
      }
    }
    return;
  }
  if (cmd !== "run") usage();
  const repoPath = flag(rest, "--repo");
  const baseRef = flag(rest, "--base");
  const headRef = flag(rest, "--head");
  const command = flag(rest, "--cmd");
  const runnerRaw = flag(rest, "--runner");
  if (runnerRaw && runnerRaw !== "pytest" && runnerRaw !== "go" && runnerRaw !== "auto") {
    usage();
  }
  const runner = runnerRaw as RunnerId | "auto" | undefined;
  if (!repoPath || !baseRef || !headRef || (!command && !runner) || (command && runner)) {
    usage();
  }
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
      runner,
      testName: flag(rest, "--test-name"),
      testFile: flag(rest, "--test-file"),
      setupCommand: flag(rest, "--setup"),
      timeoutSeconds,
    });
    const receiptPath = flag(rest, "--receipt");
    if (receiptPath) {
      await writeFile(receiptPath, `${JSON.stringify(report.receipt, null, 2)}\n`, "utf8");
    }
    if (has(rest, "--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderReport(report));
    process.exit(exitCodeFor(report.verdict));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

void main();
