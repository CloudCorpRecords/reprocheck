import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildNativeCommand, detectRunners } from "../src/runners.js";
import { runReproCheck } from "../src/repro.js";

const execFileP = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE = join(here, "fixtures", "pytest-sample");
const GO_FIXTURE = join(here, "fixtures", "go-sample");

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

async function canRun(command: string, args: string[]): Promise<boolean> {
  try {
    await execFileP(command, args, { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

let pytestAvailable = false;
let goAvailable = false;

before(async () => {
  pytestAvailable = await canRun("python3", ["-m", "pytest", "--version"]);
  goAvailable = await canRun("go", ["version"]);
});

describe("detectRunners", () => {
  it("detects pytest in the Python fixture, with evidence", () => {
    const found = detectRunners(PY_FIXTURE);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "pytest");
    assert.ok(found[0].evidence.some((e) => e.includes("pytest.ini")));
    assert.deepEqual(found[0].testFiles, ["test_calc.py"]);
  });

  it("detects go in the Go fixture, with evidence", () => {
    const found = detectRunners(GO_FIXTURE);
    assert.equal(found.length, 1);
    assert.equal(found[0].id, "go");
    assert.ok(found[0].evidence.includes("go.mod"));
    assert.deepEqual(found[0].testFiles, ["calc_test.go"]);
  });

  it("no tests found: an empty directory detects nothing and building throws", async () => {
    const empty = await mkdtemp(join(tmpdir(), "reprocheck-empty-"));
    try {
      assert.deepEqual(detectRunners(empty), []);
      assert.throws(
        () => buildNativeCommand(empty, { runner: "auto" }),
        /No tests found/,
      );
      assert.throws(
        () => buildNativeCommand(empty, { runner: "pytest" }),
        /No tests found/,
      );
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe("buildNativeCommand", () => {
  it("builds a real pytest node id command for a named test", () => {
    const built = buildNativeCommand(PY_FIXTURE, {
      runner: "pytest",
      testFile: "test_calc.py",
      testName: "test_add",
    });
    assert.equal(built.runner, "pytest");
    assert.equal(built.command, "python3 -m pytest 'test_calc.py::test_add' -q");
    assert.equal(built.targetFile, "test_calc.py");
  });

  it("finds a named pytest test by name alone", () => {
    const built = buildNativeCommand(PY_FIXTURE, {
      runner: "pytest",
      testName: "test_add_zero",
    });
    assert.equal(built.command, "python3 -m pytest 'test_calc.py::test_add_zero' -q");
  });

  it("builds a real go test command for a named test", () => {
    const built = buildNativeCommand(GO_FIXTURE, {
      runner: "go",
      testFile: "calc_test.go",
      testName: "TestAdd",
    });
    assert.equal(built.runner, "go");
    assert.equal(built.command, "go test . -run '^TestAdd$' -count=1 -v");
  });

  it("wrong runner: pytest requested on a Go repo throws", () => {
    assert.throws(
      () => buildNativeCommand(GO_FIXTURE, { runner: "pytest" }),
      /Wrong runner: requested runner "pytest"/,
    );
  });

  it("wrong runner: go requested on a Python repo throws", () => {
    assert.throws(
      () => buildNativeCommand(PY_FIXTURE, { runner: "go" }),
      /Wrong runner: requested runner "go"/,
    );
  });

  it("wrong runner: a Go test file handed to the pytest runner throws", () => {
    assert.throws(
      () =>
        buildNativeCommand(PY_FIXTURE, {
          runner: "pytest",
          testFile: "calc_test.go",
        }),
      /Wrong runner/,
    );
  });

  it("test name not found: pytest", () => {
    assert.throws(
      () =>
        buildNativeCommand(PY_FIXTURE, {
          runner: "pytest",
          testFile: "test_calc.py",
          testName: "test_does_not_exist",
        }),
      /Test name not found/,
    );
  });

  it("test name not found: go", () => {
    assert.throws(
      () =>
        buildNativeCommand(GO_FIXTURE, {
          runner: "go",
          testFile: "calc_test.go",
          testName: "TestDoesNotExist",
        }),
      /Test name not found/,
    );
  });
});

/** Copy a fixture into a temp git repo: broken base commit, fixed head commit. */
async function makeFixtureRepo(
  fixture: string,
  fixRelPath: string,
  fixedContent: string,
): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "reprocheck-native-"));
  await cp(fixture, repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "base: broken fixture"]);
  await writeFile(join(repo, fixRelPath), fixedContent);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "head: fix the fixture"]);
  return repo;
}

const FIXED_PY =
  '"""Fixed calculator."""\n\n\ndef add(a, b):\n    return a + b\n';
const FIXED_GO =
  "package calc\n\n// Add returns the sum of a and b.\nfunc Add(a int, b int) int {\n\treturn a + b\n}\n";

describe("native runners end to end (real pytest and go binaries)", () => {
  const repos: string[] = [];
  after(async () => {
    for (const r of repos) await rm(r, { recursive: true, force: true });
  });

  it("pytest runner: VERIFIED, red on base and green on head, with a receipt", async (t) => {
    if (!pytestAvailable) {
      t.skip("python3 -m pytest is not available on this machine");
      return;
    }
    const repo = await makeFixtureRepo(PY_FIXTURE, "calc.py", FIXED_PY);
    repos.push(repo);
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      runner: "pytest",
      testFile: "test_calc.py",
      testName: "test_add",
      timeoutSeconds: 60,
    });
    assert.equal(report.verdict, "VERIFIED");
    assert.equal(report.runner, "pytest");
    assert.match(report.command, /python3 -m pytest/);
    assert.notEqual(report.base.exitCode, 0);
    assert.equal(report.head.exitCode, 0);
    // Receipt: red is the base failure, green is the head pass.
    assert.equal(report.receipt.kind, "reprocheck.receipt");
    assert.equal(report.receipt.schemaVersion, 1);
    assert.equal(report.receipt.runner, "pytest");
    assert.equal(report.receipt.testName, "test_add");
    assert.equal(report.receipt.red.outcome, "fail");
    assert.equal(report.receipt.red.sha, report.base.sha);
    assert.equal(report.receipt.green.outcome, "pass");
    assert.equal(report.receipt.green.sha, report.head.sha);
    assert.equal(report.receipt.verified, true);
  });

  it("go runner: VERIFIED, red on base and green on head, with a receipt", async (t) => {
    if (!goAvailable) {
      t.skip("go is not available on this machine");
      return;
    }
    const repo = await makeFixtureRepo(GO_FIXTURE, "calc.go", FIXED_GO);
    repos.push(repo);
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      runner: "go",
      testFile: "calc_test.go",
      testName: "TestAdd",
      timeoutSeconds: 120,
    });
    assert.equal(report.verdict, "VERIFIED");
    assert.equal(report.runner, "go");
    assert.match(report.command, /go test \./);
    assert.notEqual(report.base.exitCode, 0);
    assert.equal(report.head.exitCode, 0);
    assert.match(report.head.outputTail, /PASS/);
    assert.equal(report.receipt.runner, "go");
    assert.equal(report.receipt.red.outcome, "fail");
    assert.equal(report.receipt.green.outcome, "pass");
    assert.equal(report.receipt.verified, true);
  });

  it("auto runner picks pytest for the Python fixture", async (t) => {
    if (!pytestAvailable) {
      t.skip("python3 -m pytest is not available on this machine");
      return;
    }
    const repo = await makeFixtureRepo(PY_FIXTURE, "calc.py", FIXED_PY);
    repos.push(repo);
    const report = await runReproCheck({
      repoPath: repo,
      baseRef: "HEAD~1",
      headRef: "HEAD",
      runner: "auto",
      testFile: "test_calc.py",
      timeoutSeconds: 60,
    });
    assert.equal(report.verdict, "VERIFIED");
    assert.equal(report.runner, "pytest");
  });

  it("runReproCheck rejects a wrong runner and a missing test name before running", async () => {
    const repo = await makeFixtureRepo(GO_FIXTURE, "calc.go", FIXED_GO);
    repos.push(repo);
    await assert.rejects(
      runReproCheck({
        repoPath: repo,
        baseRef: "HEAD~1",
        headRef: "HEAD",
        runner: "pytest",
        timeoutSeconds: 30,
      }),
      /Wrong runner/,
    );
    await assert.rejects(
      runReproCheck({
        repoPath: repo,
        baseRef: "HEAD~1",
        headRef: "HEAD",
        runner: "go",
        testName: "TestDoesNotExist",
        timeoutSeconds: 30,
      }),
      /Test name not found/,
    );
    await assert.rejects(
      runReproCheck({
        repoPath: repo,
        baseRef: "HEAD~1",
        headRef: "HEAD",
        command: "go test ./...",
        runner: "go",
        timeoutSeconds: 30,
      }),
      /either command or runner, not both/,
    );
  });
});
