# Changelog

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
