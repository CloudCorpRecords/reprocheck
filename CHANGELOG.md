# Changelog

## 0.2.0 (2026-10-25)

- Native pytest and Go test runners. `reprocheck run --runner pytest|go|auto`
  (or the MCP `runner` field) builds the real test command itself:
  `python3 -m pytest '<file>::<test name>' -q` for Python repos, and
  `go test <package> -run '^<TestName>$' -count=1 -v` for Go repos.
  `--test-name` (MCP `testName`) targets a single named test; detection
  finds it by scanning the repo's test files.
- Detection with evidence: `reprocheck detect --repo <path>` and the MCP
  `detect_test_runners` tool report which runners a repo supports and
  why (pytest config or test files, go.mod or Go test files), without
  running any target code.
- Honest edge cases fail before anything runs, with named errors:
  no tests found, wrong runner for the repo or for a test file, and
  a test name that does not exist in the searched files.
- Machine readable red/green receipt: every report now embeds a
  `receipt` (schemaVersion 1, kind `reprocheck.receipt`) recording the
  base (red) and head (green) refs, SHAs, exit codes, outcomes, and
  durations. The CLI writes it on its own with `--receipt <path>`.
- Tests: 12 to 27. New fixtures under `test/fixtures/` (a broken
  Python calculator and a broken Go calculator) are exercised end to
  end through the real pytest and go binaries, plus detection and
  command building edge cases. The native integration tests skip
  cleanly on machines without pytest or go.
- Dogfood: both fixtures verified through the CLI, red exit 1 on the
  broken base and green exit 0 on the fix, receipts written to files.

## 0.1.0 (2026-10-19)

First release. Wave 1, package 3 of the 100-packages plan.

- `reprocheck run --repo <path> --base <ref> --head <ref> --cmd "<command>"`:
  runs the command in clean detached worktrees of both refs and classifies
  the pair of exit codes. VERIFIED (exit 0) only when the base fails and
  the head passes. NOT-REPRODUCED, STILL-FAILING, and BROKEN-BY-HEAD each
  exit 1 with their own explanation. ERROR exits 2 and names the stage.
- `--test-file <path>`: copies an uncommitted repro or regression test from
  the working tree into both worktrees, the standard red-first setup.
- `--setup "<command>"`: per-worktree setup (for example npm install),
  with per-command timeouts (`--timeout`, default 300s).
- MCP server with the `run_repro_check` tool.
- The working tree is never modified; worktrees are temporary and removed
  on every exit path.
- Dogfood before ship: verified a real shipped fix, Greenlight v0.15.1's
  radar precision fix (commit 9492844b). Its regression tests exit 1 on
  the v0.15.0 base (a33c55e3) and exit 0 on the fix: VERIFIED.
