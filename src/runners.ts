/**
 * Native test runners for reprocheck.
 *
 * Until 0.2.0 reprocheck only knew how to run a raw shell command, which
 * in practice meant npm scripts. This module adds first class support
 * for two more ecosystems:
 *
 *   pytest   Python repos: pytest.ini, pyproject.toml, setup.cfg or
 *            tox.ini config, a conftest.py, or test_*.py / *_test.py
 *            files. Tests run as "python3 -m pytest", so a repo only
 *            needs pytest importable by python3, not a pytest shim on
 *            PATH.
 *   go       Go repos: a go.mod file or *_test.go files. Tests run as
 *            "go test" with -count=1 so the Go test cache can never
 *            turn a stale pass into evidence.
 *
 * Detection is pure filesystem inspection: it never runs the target
 * repo's code. Building a command validates the request against the
 * detection result and fails loudly on the three honest edge cases:
 * no tests found, the wrong runner for the repo, and a named test
 * that does not exist in the searched files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { DetectedRunner, RunnerId } from "./types.js";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "dist",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
]);

const MAX_DEPTH = 5;
const MAX_FILES = 4000;

const PYTEST_CONFIG_FILES = ["pytest.ini", "pyproject.toml", "setup.cfg", "tox.ini"];

function isPytestTestFile(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return (
    (base.startsWith("test_") && base.endsWith(".py")) ||
    base.endsWith("_test.py") ||
    base === "conftest.py"
  );
}

function isPytestTestTarget(rel: string): boolean {
  const base = rel.split("/").pop() ?? rel;
  return (
    (base.startsWith("test_") && base.endsWith(".py")) ||
    base.endsWith("_test.py")
  );
}

function isGoTestFile(rel: string): boolean {
  return rel.endsWith("_test.go");
}

/** List repo relative files (posix separators), bounded and pruned. */
export function listRepoFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) walk(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  walk(root, 0);
  return out.sort();
}

/**
 * Detect which native runners a repo actually supports, with the
 * filesystem evidence for each verdict, so a caller can show why.
 */
export function detectRunners(root: string): DetectedRunner[] {
  const files = listRepoFiles(root);
  const detected: DetectedRunner[] = [];

  const pytestEvidence: string[] = [];
  const pytestTestFiles = files.filter(isPytestTestTarget);
  for (const name of PYTEST_CONFIG_FILES) {
    if (files.includes(name)) pytestEvidence.push(`config:${name}`);
  }
  if (files.some((f) => f.split("/").pop() === "conftest.py")) {
    pytestEvidence.push("conftest.py");
  }
  if (pytestTestFiles.length > 0) {
    pytestEvidence.push(`test files:${pytestTestFiles.length}`);
  }
  // A pytest config alone, or test files alone, both count as a real
  // pytest setup; a stray conftest.py with no tests and no config does
  // not, on its own, prove pytest is the runner.
  const hasPytestConfig = PYTEST_CONFIG_FILES.some((n) => files.includes(n));
  if (hasPytestConfig || pytestTestFiles.length > 0) {
    detected.push({
      id: "pytest",
      evidence: pytestEvidence,
      testFiles: pytestTestFiles,
    });
  }

  const goEvidence: string[] = [];
  const goTestFiles = files.filter(isGoTestFile);
  const hasGoMod = files.includes("go.mod");
  if (hasGoMod) goEvidence.push("go.mod");
  if (goTestFiles.length > 0) goEvidence.push(`test files:${goTestFiles.length}`);
  if (hasGoMod || goTestFiles.length > 0) {
    detected.push({ id: "go", evidence: goEvidence, testFiles: goTestFiles });
  }

  return detected;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readRepoFile(root: string, rel: string): string {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return "";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find the test file that defines a named test, or undefined. */
export function findNamedTest(
  root: string,
  runner: RunnerId,
  testName: string,
  candidates: string[],
): string | undefined {
  const pattern =
    runner === "pytest"
      ? new RegExp(`def\\s+${escapeRegExp(testName)}\\s*\\(`)
      : new RegExp(`func\\s+${escapeRegExp(testName)}\\s*\\(`);
  for (const rel of candidates) {
    if (pattern.test(readRepoFile(root, rel))) return rel;
  }
  return undefined;
}

export interface NativeCommandRequest {
  /** The runner the caller asked for, or "auto" to use detection alone. */
  runner: RunnerId | "auto";
  /** Repo relative test file to target, when one is known. */
  testFile?: string;
  /** A single named test, e.g. test_add or TestAdd. */
  testName?: string;
}

export interface NativeCommand {
  runner: RunnerId;
  command: string;
  detection: DetectedRunner;
  /** The file the built command actually targets, after any lookup. */
  targetFile?: string;
}

/**
 * Resolve a native runner request into a concrete shell command.
 *
 * Throws with a specific message when:
 *   - no tests are found for any native runner ("No tests found")
 *   - the requested runner does not match the repo ("Wrong runner")
 *   - a test file is not a test file for that runner ("Wrong runner")
 *   - a named test cannot be found ("Test name not found")
 */
export function buildNativeCommand(root: string, req: NativeCommandRequest): NativeCommand {
  const detected = detectRunners(root);
  if (detected.length === 0) {
    throw new Error(
      `No tests found: no pytest or Go test setup detected in ${root} ` +
        `(looked for pytest config or test_*.py / *_test.py files, and go.mod or *_test.go files)`,
    );
  }

  let chosen: DetectedRunner | undefined;
  if (req.runner === "auto") {
    if (req.testFile) {
      chosen = detected.find((d) =>
        req.testFile!.endsWith(".py") ? d.id === "pytest" : req.testFile!.endsWith(".go") ? d.id === "go" : false,
      );
      if (!chosen) {
        throw new Error(
          `Wrong runner: test file ${req.testFile} does not match any detected runner ` +
            `(detected: ${detected.map((d) => d.id).join(", ")})`,
        );
      }
    } else if (detected.length === 1) {
      chosen = detected[0];
    } else {
      throw new Error(
        `Ambiguous runner: detected ${detected.map((d) => d.id).join(", ")} in ${root}; ` +
          `pass runner "pytest" or "go" explicitly`,
      );
    }
  } else {
    chosen = detected.find((d) => d.id === req.runner);
    if (!chosen) {
      throw new Error(
        `Wrong runner: requested runner "${req.runner}" but no ${req.runner} test setup was detected in ${root} ` +
          `(detected: ${detected.map((d) => d.id).join(", ") || "none"})`,
      );
    }
  }

  if (req.testFile) {
    const ok =
      chosen.id === "pytest" ? isPytestTestFile(req.testFile) : isGoTestFile(req.testFile);
    if (!ok) {
      throw new Error(
        `Wrong runner: test file ${req.testFile} is not a ${chosen.id} test file`,
      );
    }
    if (!existsSync(join(root, req.testFile))) {
      throw new Error(`Test file not found in the working tree: ${req.testFile}`);
    }
  }

  if (chosen.id === "pytest") {
    let target = req.testFile;
    let nodeId: string | undefined;
    if (req.testName) {
      const candidates = target ? [target] : chosen.testFiles;
      const found = findNamedTest(root, "pytest", req.testName, candidates);
      if (!found) {
        throw new Error(
          `Test name not found: no pytest test named "${req.testName}" in ` +
            `${candidates.join(", ") || "any detected pytest test file"}`,
        );
      }
      target = found;
      nodeId = `${found}::${req.testName}`;
    }
    const command = nodeId
      ? `python3 -m pytest ${shellQuote(nodeId)} -q`
      : target
        ? `python3 -m pytest ${shellQuote(target)} -q`
        : `python3 -m pytest -q`;
    return { runner: "pytest", command, detection: chosen, targetFile: target };
  }

  // Go runner.
  let target = req.testFile;
  if (req.testName) {
    const candidates = target ? [target] : chosen.testFiles;
    const found = findNamedTest(root, "go", req.testName, candidates);
    if (!found) {
      throw new Error(
        `Test name not found: no Go test named "${req.testName}" in ` +
          `${candidates.join(", ") || "any detected Go test file"}`,
      );
    }
    target = found;
  }
  const pkgDir = target ? target.split("/").slice(0, -1).join("/") : "";
  const pkg = pkgDir ? `./${pkgDir}` : ".";
  const command = req.testName
    ? `go test ${pkg} -run ${shellQuote(`^${req.testName}$`)} -count=1 -v`
    : target
      ? `go test ${pkg} -count=1 -v`
      : `go test ./... -count=1`;
  return { runner: "go", command, detection: chosen, targetFile: target };
}
