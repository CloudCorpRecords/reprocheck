/**
 * reprocheck types.
 *
 * A ReproReport records two runs of the same command: once in a clean
 * worktree of the base ref, once in a clean worktree of the head ref.
 * The verdict is a pure function of the two exit codes. Anything less
 * than fail-on-base plus pass-on-head is reported as what it is, never
 * rounded up to "verified".
 */

export type Verdict =
  | "VERIFIED"
  | "NOT-REPRODUCED"
  | "STILL-FAILING"
  | "BROKEN-BY-HEAD"
  | "ERROR";

/** Native runners reprocheck knows how to drive without a raw command. */
export type RunnerId = "pytest" | "go";

export interface DetectedRunner {
  id: RunnerId;
  /** Filesystem evidence for the detection, e.g. "go.mod", "config:pytest.ini". */
  evidence: string[];
  /** Repo relative test files found for this runner. */
  testFiles: string[];
}

export interface ReceiptPhase {
  ref: string;
  sha: string;
  exitCode: number | null;
  outcome: "pass" | "fail" | "did-not-run";
  timedOut: boolean;
  durationMs: number;
}

/**
 * Machine readable red/green receipt for one reprocheck run.
 * "red" is the base phase (the evidence a bug exists) and "green" is
 * the head phase (the evidence the fix works). The receipt is embedded
 * in every ReproReport and can also be written to a file by the CLI.
 */
export interface ReproReceipt {
  schemaVersion: 1;
  kind: "reprocheck.receipt";
  verdict: Verdict;
  checkedAt: string;
  repo: string;
  command: string;
  runner?: RunnerId;
  testFile?: string;
  testName?: string;
  red: ReceiptPhase;
  green: ReceiptPhase;
  verified: boolean;
}

export interface PhaseResult {
  ref: string;
  sha: string;
  /** Exit code of the repro command. Null when it never ran or was killed. */
  exitCode: number | null;
  /** Exit code of the setup command, when one was given. */
  setupExitCode?: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Last lines of combined output, for the report. */
  outputTail: string;
}

export interface ReproReport {
  repo: string;
  command: string;
  /** The native runner that built the command, when one was used. */
  runner?: RunnerId;
  /** Detection evidence for the runner, when a native runner was used. */
  detection?: DetectedRunner;
  testFile?: string;
  testName?: string;
  setupCommand?: string;
  base: PhaseResult;
  head: PhaseResult;
  verdict: Verdict;
  detail: string;
  checkedAt: string;
  /** Machine readable red/green evidence for this run. */
  receipt: ReproReceipt;
}

export interface ReproOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  /**
   * Raw repro command. Required unless runner is given, in which case
   * the command is built by the native runner and this must be omitted.
   */
  command?: string;
  /** Native runner to use instead of a raw command: "pytest", "go", or "auto". */
  runner?: RunnerId | "auto";
  /** A single named test for a native runner, e.g. test_add or TestAdd. */
  testName?: string;
  /** Repo-relative path of an uncommitted repro file to copy into both worktrees. */
  testFile?: string;
  /** Optional command run in each worktree before the repro command (e.g. npm install). */
  setupCommand?: string;
  /** Per-command timeout in seconds. Default 300. */
  timeoutSeconds?: number;
}

export interface ExecResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export type ExecFn = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => Promise<ExecResult>;
