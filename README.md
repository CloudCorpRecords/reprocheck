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

# Machine readable output
npx @reneturcios/reprocheck run --repo . --base main --head HEAD --cmd "npm test" --json
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

Tool: `run_repro_check`: repoPath, baseRef, headRef, command, and optional testFile, setupCommand, and timeoutSeconds. Returns the full report as JSON, including per-phase exit codes, durations, and output tails.

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
npm test   # 12 tests: verdict classification plus full runs against a real temp git repo
```

## License

MIT
