import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classify, exitCodeFor, runReproCheck } from "../src/repro.js";

const execFileP = promisify(execFile);

describe("classify", () => {
  it("VERIFIED: fails on base, passes on head", () => {
    assert.equal(classify(1, 0).verdict, "VERIFIED");
  });
  it("NOT-REPRODUCED: passes on both", () => {
    assert.equal(classify(0, 0).verdict, "NOT-REPRODUCED");
  });
  it("STILL-FAILING: fails on both", () => {
    assert.equal(classify(1, 1).verdict, "STILL-FAILING");
  });
  it("BROKEN-BY-HEAD: passes on base, fails on head", () => {
    assert.equal(classify(0, 2).verdict, "BROKEN-BY-HEAD");
  });
  it("ERROR: a run did not complete", () => {
    assert.equal(classify(null, 0).verdict, "ERROR");
    assert.equal(classify(1, null).verdict, "ERROR");
  });
  it("exit codes: only VERIFIED is 0, ERROR is 2", () => {
    assert.equal(exitCodeFor("VERIFIED"), 0);
    assert.equal(exitCodeFor("NOT-REPRODUCED"), 1);
    assert.equal(exitCodeFor("STILL-FAILING"), 1);
    assert.equal(exitCodeFor("BROKEN-BY-HEAD"), 1);
    assert.equal(exitCodeFor("ERROR"), 2);
  });
});

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "reprocheck-test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "reprocheck-test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileP("git", args, { cwd, env: GIT_ENV });
}

describe("runReproCheck (real temp git repo)", () => {
  let repo: string;

  before(async () => {
    repo = await mkdtemp(join(tmpdir(), "reprocheck-test-"));
    await git(repo, ["init", "-b", "main"]);
    // Base commit: the bug is present.
    await writeFile(join(repo, "state.txt"), "broken\n");
    await git(repo, ["add", "state.txt"]);
    await git(repo, ["commit", "-m", "base: broken state"]);
    // Head commit: the fix.
    await writeFile(join(repo, "state.txt"), "fixed\n");
    await git(repo, ["add", "state.txt"]);
    await git(repo, ["commit", "-m", "head: fixed state"]);
    // The repro script is deliberately UNCOMMITTED: it is supplied to
    // both worktrees through testFile, like a reporter's repro would be.
    await writeFile(
      join(repo, "check.mjs"),
      'import { readFileSync } from "node:fs";\nconst s = readFileSync("state.txt", "utf8");\nif (s.includes("broken")) { console.error("repro: state is broken"); process.exit(1); }\nconsole.log("repro: state ok");\n',
    );
  });

  after(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("VERIFIED: uncommitted repro fails on HEAD~1 and passes on HEAD", async () => {
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      command: "node check.mjs",
      testFile: "check.mjs",
      timeoutSeconds: 30,
    });
    assert.equal(report.verdict, "VERIFIED");
    assert.equal(report.base.exitCode, 1);
    assert.equal(report.head.exitCode, 0);
    assert.notEqual(report.base.sha, report.head.sha);
  });

  it("NOT-REPRODUCED: same ref on both sides passes on base too", async () => {
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD",
      headRef: "HEAD",
      command: "node check.mjs",
      testFile: "check.mjs",
      timeoutSeconds: 30,
    });
    assert.equal(report.verdict, "NOT-REPRODUCED");
  });

  it("STILL-FAILING: broken ref on both sides", async () => {
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD~1",
      command: "node check.mjs",
      testFile: "check.mjs",
      timeoutSeconds: 30,
    });
    assert.equal(report.verdict, "STILL-FAILING");
  });

  it("BROKEN-BY-HEAD: refs swapped turns the fix into the break", async () => {
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD",
      headRef: "HEAD~1",
      command: "node check.mjs",
      testFile: "check.mjs",
      timeoutSeconds: 30,
    });
    assert.equal(report.verdict, "BROKEN-BY-HEAD");
  });

  it("ERROR with the stage named when the setup command fails", async () => {
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      command: "node check.mjs",
      testFile: "check.mjs",
      setupCommand: "node -e \"process.exit(3)\"",
      timeoutSeconds: 30,
    });
    assert.equal(report.verdict, "ERROR");
    assert.equal(report.base.setupExitCode, 3);
    assert.equal(report.base.exitCode, null);
  });

  it("rejects a bad ref and a missing test file before running anything", async () => {
    await assert.rejects(
      runReproCheck({
        repoPath: repo,
        baseRef: "no-such-ref",
        headRef: "HEAD",
        command: "node check.mjs",
        timeoutSeconds: 30,
      }),
      /Could not resolve base ref/,
    );
    await assert.rejects(
      runReproCheck({
        repoPath: repo,
        baseRef: "HEAD~1",
        headRef: "HEAD",
        command: "node check.mjs",
        testFile: "missing.mjs",
        timeoutSeconds: 30,
      }),
      /Test file not found/,
    );
  });
});
