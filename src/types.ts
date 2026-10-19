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
  testFile?: string;
  setupCommand?: string;
  base: PhaseResult;
  head: PhaseResult;
  verdict: Verdict;
  detail: string;
  checkedAt: string;
}

export interface ReproOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  command: string;
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
