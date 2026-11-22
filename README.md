# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wahyunp26-source/hidden-spec-cli-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wahyunp26-source/hidden-spec-cli-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

**mend** applies AI-written edits to a tree of text files, in all four formats
models actually write: unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. Every file is
changed or none is — a failed edit rolls back its own changes, the rest
still run, and when any edit failed nothing is written. Built for the
[make.fun bounty hidden-spec-cli-01-run-20261122](https://make.fun/c/hidden-spec-cli-01-run-20261122)
($100, top 10 × $10).

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only, no network at runtime, fully deterministic.

- `PATCH` is the patch file; absent or `-` reads the patch from stdin.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## Matching

Old lines are found at the first of three tiers where they occur: exact,
trailing-whitespace-insensitive, then leading-and-trailing-whitespace
insensitive (with new lines re-indented to the file's indent). Unified
hunks take the occurrence nearest their (possibly wrong) line number;
SEARCH/REPLACE blocks fail `ambiguous` when the old lines occur more than
once; V4A chunks walk a cursor with anchors and end-of-file chunks. Moves
print `R <old> -> <new>` instead of a `D` + `A` pair.

## Files

- `main.ts` — the CLI (SPEC.md sections 1–10).
- `runner.ts` — the kit's trial runner, unchanged.
- `SPEC.md` — the full specification.
- `LICENSE` — MIT.

## Checks

The practice set scores **100/100** (`node check.ts` in the kit starter
directory, run against `program/generator/practice.json`), and 97 extra
hand-written SPEC tests pass (usage errors, parse-error line numbers,
V4A anchor/cursor edges, JSON insert bounds, CRLF in every format, empty
files, empty-O insertions, multi-edit atomicity, unsafe paths, move
chains, create-then-edit ordering, no-newline-at-EOF cases). A strict-only
run of the same practice set scores 75/100 — the house strict applier's
bar — so the full implementation leads it by 25 checks per trial.

## License

MIT — see [LICENSE](LICENSE).
