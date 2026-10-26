# reprocheck

**"Fixed" is a claim. reprocheck makes you prove it, red first.**

Every bug fix makes the same claim: this change fixes that bug. The honest proof has a specific shape, and it is the shape good reviewers ask for: a repro that **fails on the code before the fix** and **passes on the code after it**. A test that passes on both proves nothing. A fix whose repro still fails fixes nothing. And a change that turns a passing repro red broke something.

reprocheck runs that proof for you. Give it a repo, a base ref, a head ref, and a command. It creates clean detached worktrees of both refs, runs the command in each, and classifies the pair of exit codes:

| verdict | base | head | what it means |
| --- | --- | --- | --- |
| `VERIFIED` | fails | passes | The change fixes what the repro demonstrates, and the repro demonstrably covers the bug |
| `NOT-REPRODUCED` | passes | passes | The repro does not demonstrate a bug on the base (already fixed there, or it misses the bug), so the head pass proves nothing |
| `STILL-FAILING` | fails | fails | The change does not fix what the repro demonstrates |
| `BROKEN-BY-HEAD` | passes | fails | The change introduced this failure |
| `ERROR` | n/a | n/a | Setup, git, or the run itself failed or timed out; the report names the stage |

Exit codes are CI-friendly: 0 for VERIFIED, 1 for the other completed verdicts, 2 for ERROR.

## The feature that makes it practical: `--test-file`

The standard red-first setup has an awkward step: the regression test is new, so it does not exist on the base. Copying it into a base checkout by hand is exactly the kind of manual step people skip. reprocheck does it for you: pass `--test-file <path>` and the file, read from your working tree (committed or not), is copied into both worktrees at the same relative path before the command runs.

Your working tree is never modified. Both runs happen in temporary worktrees under the OS temp dir, and they are removed on every exit path.

## Native runners: pytest and Go

You do not have to hand write the test command for Python or Go repos. Pass `--runner pytest`, `--runner go`, or `--runner auto` and reprocheck detects the repo's test setup, builds the real command, and runs it in both worktrees:

- pytest detection: a pytest config (`pytest.ini`, `pyproject.toml`, `setup.cfg`, `tox.ini`) or `test_*.py` / `*_test.py` files. The command is `python3 -m pytest '<file>::<test name>' -q` (file or whole suite when no name is given).
- Go detection: a `go.mod` file or `*_test.go` files. The command is `go test <package> -run '^<TestName>$' -count=1 -v`, with `-count=1` so the Go test cache can never turn a stale pass into evidence.
- `--test-name <name>` targets one named test (`test_add` for pytest, `TestAdd` for Go). Detection finds which test file defines it.
- Asking for the wrong runner, a test file that belongs to another runner, a test name that does not exist, or any runner in a repo with no tests at all fails before anything runs, with that specific error. Nothing is rounded up to a verdict it did not earn.
- `reprocheck detect --repo <path>` (or the MCP `detect_test_runners` tool) reports the detected runners and the filesystem evidence for each, without running any target code.

```bash
# Python: one named pytest test, red on main and green on HEAD
npx @reneturcios/reprocheck run --repo . --base main --head HEAD \
  --runner pytest --test-file test_calc.py --test-name test_add

# Go: one named test, package inferred from the test file
npx @reneturcios/reprocheck run --repo . --base main --head HEAD \
  --runner go --test-file calc_test.go --test-name TestAdd

# See what a repo supports before choosing
npx @reneturcios/reprocheck detect --repo . --json
```

## The receipt

Every report carries a machine readable red/green receipt: `receipt` in the `--json` output, with `schemaVersion: 1`, `kind: "reprocheck.receipt"`, the verdict, the runner, and a `red` (base) and `green` (head) block holding ref, SHA, exit code, outcome (`pass`, `fail`, or `did-not-run`), timeout flag, and duration. Write just the receipt to a file with `--receipt <path>`, for example to attach it to a PR description or a CI artifact. A receipt is evidence, not a summary: it records exactly the two runs the verdict rests on.

## Usage

### CLI

```bash
# Verify a fix on the current branch against main, using the new regression test
npx @reneturcios/reprocheck run \
  --repo . --base main --head HEAD \
  --test-file test/radar.test.ts \
  --setup "npm install" \
  --cmd "npx tsx --test test/radar.test.ts"

# Simpler: a committed repro script, no setup
npx @reneturcios/reprocheck run --repo . --base HEAD~1 --head HEAD --cmd "node repro.mjs"

# Machine readable output, with the receipt written to a file
npx @reneturcios/reprocheck run --repo . --base main --head HEAD --cmd "npm test" --json --receipt receipt.json
```

Example output (real dogfood, verifying Greenlight v0.15.1's radar precision fix, where the regression tests in `test/radar.test.ts` were written against the fixed behavior):

```
reprocheck: VERIFIED
  command: npx tsx --test test/radar.test.ts
  test file copied into both worktrees: test/radar.test.ts
  setup: npm install --no-audit --no-fund
  base (a33c55e3 @ a33c55e39010): exit 1 in 18512ms
  head (9492844b @ 9492844bf6b6): exit 0 in 12015ms
The repro fails on the base and passes on the head. The change fixes what the repro demonstrates, and the repro demonstrably covers the bug
```

### MCP server

Add to your MCP client config:

```json
{
  "mcpServers": {
    "reprocheck": {
      "command": "npx",
      "args": ["-y", "@reneturcios/reprocheck", "mcp"]
    }
  }
}
```

Tools: `run_repro_check` (repoPath, baseRef, headRef, and either a raw command or a native `runner` of pytest, go, or auto, with optional testFile, testName, setupCommand, and timeoutSeconds; returns the full report as JSON, including the receipt, per-phase exit codes, durations, and output tails) and `detect_test_runners` (repoPath; returns the detected native runners with their evidence and test files).

### Docker

The CLI works on local git repositories, so mount the repo you want to check:

```bash
docker run -i ghcr.io/cloudcorprecords/reprocheck mcp
docker run --rm -v "$PWD:/repo" ghcr.io/cloudcorprecords/reprocheck \
  run --repo /repo --base main --head HEAD --cmd "npm test"
```

## Where reprocheck fits

reprocheck is the verification third of a small triad from the same author:

- [cidiff](https://github.com/CloudCorpRecords/cidiff) tells you which failing checks on a PR are actually the PR's fault.
- reprocheck proves a specific fix fixes a specific bug, red first.
- [shipcheck](https://github.com/CloudCorpRecords/shipcheck) verifies the finished release actually shipped on every surface.

All three come from the same discipline that runs [Greenlight](https://github.com/CloudCorpRecords/greenlight): evidence first, honest verdicts, no invented answers. A verdict reprocheck cannot support, it does not print.

## Development

```bash
npm install
npm run build
npm test   # 27 tests: verdict classification, full runs against a real temp git repo, and native pytest / go runner detection, command building, and end to end fixture runs through the real binaries (skipped when a binary is unavailable)
```

## License

MIT
