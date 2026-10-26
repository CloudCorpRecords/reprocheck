/**
 * reprocheck core: red-first verification in disposable git worktrees.
 *
 * The claim "this change fixes the bug" is only verified when the same
 * repro fails on the base and passes on the head. Every other outcome
 * has its own name and is reported as itself:
 *   VERIFIED        base fails, head passes
 *   NOT-REPRODUCED  base passes too (already fixed, or the repro misses the bug)
 *   STILL-FAILING   both fail (the fix does not fix it, at least not this repro)
 *   BROKEN-BY-HEAD  base passes, head fails (the change introduced this failure)
 *   ERROR           setup, git, spawn, or timeout failure, with the stage named
 *
 * The user's working tree is never touched: both runs happen in temporary
 * detached worktrees that are removed afterwards.
 */
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type {
  DetectedRunner,
  ExecFn,
  ExecResult,
  PhaseResult,
  ReceiptPhase,
  ReproOptions,
  ReproReceipt,
  ReproReport,
  RunnerId,
  Verdict,
} from "./types.js";
import { buildNativeCommand, detectRunners } from "./runners.js";

export type { NativeCommand, NativeCommandRequest } from "./runners.js";

export const VERSION = "0.2.0";

const execFileP = promisify(execFile);

export function classify(
  baseExit: number | null,
  headExit: number | null,
): { verdict: Verdict; detail: string } {
  if (baseExit === null || headExit === null) {
    return {
      verdict: "ERROR",
      detail:
        "One of the runs did not complete (setup failure, spawn failure, or timeout). See the phase results for the stage that failed",
    };
  }
  if (baseExit !== 0 && headExit === 0) {
    return {
      verdict: "VERIFIED",
      detail:
        "The repro fails on the base and passes on the head. The change fixes what the repro demonstrates, and the repro demonstrably covers the bug",
    };
  }
  if (baseExit === 0 && headExit === 0) {
    return {
      verdict: "NOT-REPRODUCED",
      detail:
        "The repro passes on the base too. It does not demonstrate a bug on the base, so a pass on the head proves nothing (already fixed there, or the repro misses the bug)",
    };
  }
  if (baseExit !== 0 && headExit !== 0) {
    return {
      verdict: "STILL-FAILING",
      detail:
        "The repro fails on both base and head. The change does not fix what the repro demonstrates",
    };
  }
  return {
    verdict: "BROKEN-BY-HEAD",
    detail:
      "The repro passes on the base and fails on the head. The change introduced this failure",
  };
}

function receiptPhase(phase: PhaseResult): ReceiptPhase {
  return {
    ref: phase.ref,
    sha: phase.sha,
    exitCode: phase.exitCode,
    outcome:
      phase.exitCode === null ? "did-not-run" : phase.exitCode === 0 ? "pass" : "fail",
    timedOut: phase.timedOut,
    durationMs: phase.durationMs,
  };
}

/** Build the machine readable red/green receipt for a completed report. */
export function buildReceipt(
  report: Omit<ReproReport, "receipt">,
): ReproReceipt {
  return {
    schemaVersion: 1,
    kind: "reprocheck.receipt",
    verdict: report.verdict,
    checkedAt: report.checkedAt,
    repo: report.repo,
    command: report.command,
    runner: report.runner,
    testFile: report.testFile,
    testName: report.testName,
    red: receiptPhase(report.base),
    green: receiptPhase(report.head),
    verified: report.verdict === "VERIFIED",
  };
}

export const defaultExec: ExecFn = (command, cwd, timeoutMs) =>
  new Promise<ExecResult>((resolvePromise) => {
    const child = spawn(command, { shell: true, cwd, env: process.env });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: null, output, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: timedOut ? null : code, output, timedOut });
    });
  });

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", ["-C", repo, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

function tail(output: string, lines = 25): string {
  const all = output.split("\n");
  return all.slice(-lines).join("\n").trim();
}

async function runPhase(
  label: "base" | "head",
  ref: string,
  sha: string,
  worktree: string,
  opts: ReproOptions & { command: string },
  execFn: ExecFn,
  timeoutMs: number,
): Promise<PhaseResult> {
  const started = Date.now();
  let setupExitCode: number | null | undefined;
  if (opts.setupCommand) {
    const setup = await execFn(opts.setupCommand, worktree, timeoutMs);
    setupExitCode = setup.code;
    if (setup.code !== 0) {
      return {
        ref,
        sha,
        exitCode: null,
        setupExitCode,
        timedOut: setup.timedOut,
        durationMs: Date.now() - started,
        outputTail: tail(`[setup:${label}] ${opts.setupCommand}\n${setup.output}`),
      };
    }
  }
  const result = await execFn(opts.command, worktree, timeoutMs);
  return {
    ref,
    sha,
    exitCode: result.code,
    setupExitCode,
    timedOut: result.timedOut,
    durationMs: Date.now() - started,
    outputTail: tail(result.output),
  };
}

export async function runReproCheck(
  opts: ReproOptions,
  execFn: ExecFn = defaultExec,
): Promise<ReproReport> {
  const repo = resolve(opts.repoPath);
  const timeoutMs = (opts.timeoutSeconds ?? 300) * 1000;

  // Resolve a native runner request into a concrete command before any
  // git work. Detection, wrong runner, no tests, and test name errors
  // all fail here, with their specific messages, and nothing runs.
  let runner: RunnerId | undefined;
  let detection: DetectedRunner | undefined;
  let command = opts.command;
  let effectiveTestFile = opts.testFile;
  if (opts.runner) {
    if (opts.command) {
      throw new Error("Pass either command or runner, not both");
    }
    const native = buildNativeCommand(repo, {
      runner: opts.runner,
      testFile: opts.testFile,
      testName: opts.testName,
    });
    runner = native.runner;
    detection = native.detection;
    command = native.command;
    effectiveTestFile = native.targetFile ?? opts.testFile;
  } else if (opts.testName) {
    throw new Error("testName requires a native runner (runner: pytest, go, or auto)");
  }
  if (!command) {
    throw new Error("A repro command or a native runner is required");
  }
  const effectiveOpts: ReproOptions & { command: string } = {
    ...opts,
    command,
    testFile: effectiveTestFile,
  };

  // Validate the repo and resolve both refs before creating anything.
  await git(repo, ["rev-parse", "--git-dir"]).catch(() => {
    throw new Error(`${repo} is not a git repository`);
  });
  const baseSha = await git(repo, ["rev-parse", `${opts.baseRef}^{commit}`]).catch(() => {
    throw new Error(`Could not resolve base ref: ${opts.baseRef}`);
  });
  const headSha = await git(repo, ["rev-parse", `${opts.headRef}^{commit}`]).catch(() => {
    throw new Error(`Could not resolve head ref: ${opts.headRef}`);
  });

  if (effectiveTestFile) {
    const source = join(repo, effectiveTestFile);
    if (!existsSync(source)) {
      throw new Error(`Test file not found in the working tree: ${effectiveTestFile}`);
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), "reprocheck-"));
  const baseWt = join(scratch, "base");
  const headWt = join(scratch, "head");
  try {
    await git(repo, ["worktree", "add", "--detach", baseWt, baseSha]);
    await git(repo, ["worktree", "add", "--detach", headWt, headSha]);

    if (effectiveTestFile) {
      for (const wt of [baseWt, headWt]) {
        const dest = join(wt, effectiveTestFile);
        await mkdir(dirname(dest), { recursive: true });
        await copyFile(join(repo, effectiveTestFile), dest);
      }
    }

    const base = await runPhase("base", opts.baseRef, baseSha, baseWt, effectiveOpts, execFn, timeoutMs);
    const head = await runPhase("head", opts.headRef, headSha, headWt, effectiveOpts, execFn, timeoutMs);
    const { verdict, detail } = classify(base.exitCode, head.exitCode);
    const partial = {
      repo,
      command,
      runner,
      detection,
      testFile: effectiveTestFile,
      testName: opts.testName,
      setupCommand: opts.setupCommand,
      base,
      head,
      verdict,
      detail,
      checkedAt: new Date().toISOString(),
    };
    return { ...partial, receipt: buildReceipt(partial) };
  } finally {
    await git(repo, ["worktree", "remove", "--force", baseWt]).catch(() => undefined);
    await git(repo, ["worktree", "remove", "--force", headWt]).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function exitCodeFor(verdict: Verdict): number {
  if (verdict === "VERIFIED") return 0;
  if (verdict === "ERROR") return 2;
  return 1;
}

export function renderReport(report: ReproReport): string {
  const lines: string[] = [];
  lines.push(`reprocheck: ${report.verdict}`);
  lines.push(`  command: ${report.command}`);
  if (report.runner) {
    lines.push(
      `  runner: ${report.runner}${report.detection ? ` (evidence: ${report.detection.evidence.join(", ")})` : ""}`,
    );
  }
  if (report.testName) lines.push(`  test name: ${report.testName}`);
  lines.push(
    `  receipt: red (base) exit ${report.receipt.red.exitCode ?? "n/a"}, green (head) exit ${report.receipt.green.exitCode ?? "n/a"}, verified ${report.receipt.verified}`,
  );
  if (report.testFile) lines.push(`  test file copied into both worktrees: ${report.testFile}`);
  if (report.setupCommand) lines.push(`  setup: ${report.setupCommand}`);
  for (const [label, phase] of [
    ["base", report.base],
    ["head", report.head],
  ] as const) {
    const status =
      phase.exitCode === null
        ? phase.timedOut
          ? "TIMED OUT"
          : "DID NOT RUN"
        : `exit ${phase.exitCode}`;
    lines.push(
      `  ${label} (${phase.ref} @ ${phase.sha.slice(0, 12)}): ${status} in ${phase.durationMs}ms`,
    );
  }
  lines.push(report.detail);
  if (report.verdict !== "VERIFIED") {
    const failing =
      report.verdict === "ERROR"
        ? report.base.exitCode === null
          ? report.base
          : report.head
        : report.head;
    if (failing.outputTail) {
      lines.push("  output tail:");
      for (const line of failing.outputTail.split("\n").slice(-10)) {
        lines.push(`    ${line}`);
      }
    }
  }
  return lines.join("\n");
}
