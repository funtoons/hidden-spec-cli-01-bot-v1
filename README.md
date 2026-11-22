# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/funtoons/hidden-spec-cli-01-bot-v1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/funtoons/hidden-spec-cli-01-bot-v1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files, for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). Models write edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads all four to one written specification (`SPEC.md` in the kit), finds the lines an edit names even when the model drifted their whitespace or indentation, and changes every file or none.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory (the root of the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: the same output and exit code, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` with one line per changed path (`A`, `D`, `M`, or `R old -> new` for a move) and `ok: <n> files`; `1` with one `error: <code> <path>` line per failed edit and `failed: <k> of <n> edits`; `2` with exactly one line for a usage, no-patch, format or parse error.

## How it works

- **Three-tier matching.** Old lines are found at the first tier where they occur: exact, then ignoring trailing spaces/tabs, then ignoring leading and trailing spaces/tabs. At tier 2 the new lines are re-indented from the patch's indentation to the file's. Unified hunks take the occurrence nearest the (possibly wrong) line number; SEARCH/REPLACE blocks fail as `ambiguous` when the old lines occur more than once; V4A chunks follow a cursor with an anchor line.
- **Four formats.** Unified diffs (sections, hunks, creations, deletions, renames/moves, `\ No newline at end of file`), SEARCH/REPLACE blocks (path from the nearest non-blank, non-fence line), V4A patches (`Add`/`Delete`/`Update File`, `Move to`, anchors, end-of-file chunks), and JSON edits (`create`, `str_replace`, `insert`, in array or JSON-Lines form).
- **All or nothing.** Edits apply in order to the tree as earlier edits left it; a failed edit changes nothing and the edits after it still run, so every failure is reported; when any edit failed, no file is written. Paths are checked for safety before anything else about them. Files keep their own line break (CRLF or LF) and their final line break, except where the specification says a unified hunk decides it.
- **Deterministic.** Node 22 standard library alone, no dependencies, no time or randomness in the output or the files.

`runner.ts` is the kit's runner, kept as it is: in a trial it reads the checks from the environment, runs `node main.ts` on each one in a fresh directory, and posts the exit code, stdout and files.

## Verification

- Practice set (the kit's 100 public checks): **100/100 — score 1000** (unified 30, search_replace 20, v4a 20, json 15, cli 15), run twice with byte-identical results.
- Kit's sealed scorer (`makefun grade-local`, process driver): **scores {cli 15, json 15, passed 100, score 1000, search_replace 20, unified 30, v4a 20, working 1}**, replay matched byte for byte.
- 72 additional hand-written edge cases from the specification's sentences (CRLF, files without a final line break, blank context lines, ambiguous matches, unsafe paths, `--check`, `--strict`, usage/no-patch/format/parse errors, moves, atomicity, tier-2 re-indentation, V4A anchors and end-of-file chunks): all pass.

## License

MIT — see [LICENSE](LICENSE).
