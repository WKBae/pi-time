# Maintainer guide

`pi-time` is a Pi package with one extension. When Pi settles after a task, the extension appends a `pi-time` custom session entry with the elapsed time, token usage, cost, and completion time, and renders it as dim text. User documentation lives in `README.md` and covers installing, using, and reading the summary.

## Layout

```text
extensions/time/index.ts  # Entry point listed in package.json "pi.extensions"
src/index.ts              # Task lifecycle, usage collection, and the session entry
src/timing.ts             # Usage totals and output formatting
tests/                    # Node built-in tests, including Pi loader and AgentSession integration checks
```

Pi loads the TypeScript sources directly, so the package has no build step. The `files` field in `package.json` publishes only `extensions` and `src`.

## Development

Requires Node.js 22.19.0 or later.

```sh
npm ci --ignore-scripts
npm run check          # typecheck and tests
npm pack --dry-run     # list the files that would be published
```

To run the extension from a checkout without installing it:

```sh
pi -e ./extensions/time/index.ts
```

You can also install the checkout as a package with `pi install /absolute/path/to/pi-time`. After you change the sources, run `/reload` in Pi to load them.

## Dependencies

The Pi SDK packages, including `@earendil-works/pi-tui` for the session entry renderer, are peer dependencies with the range `*` because Pi supplies them at runtime. `devDependencies` pins the versions used for typechecking and tests, currently Pi 1.3.0. When you raise the tested Pi version, update `devDependencies` and the Pi version in the README's "Requirements" section together.

## Behavior and invariants

`tests/index.test.ts`, `tests/session.test.ts`, and `tests/timing.test.ts` cover these rules. When you change one, update the README's "Read the summary" section to match.

- **Task window**: a run starts on `before_agent_start` and ends on `agent_settled`. `agent_start` starts a run only when none is active, as a fallback for loops that begin without `before_agent_start`: retries, boundary continuations, and an extension that loads after `before_agent_start` has fired. Intermediate `agent_end` events never append an entry; settlement appends exactly one.
- **Tool time** is the wall-clock time during which at least one tool is executing, measured from `tool_execution_start` and `tool_execution_end`. Parallel and nested intervals count once. An interval still open at settlement, including after an abort, counts up to settlement. Tool state resets with each task.
- **Elapsed time** uses a monotonic clock (`performance.now()`) and truncates to whole seconds. Tests replace the clock through the `Clock` parameter of `registerTimeExtension`.
- **Usage sources**:
  - `message_end` for `assistant` and `toolResult` messages, deduplicated by message object.
  - `session_compact` events.
  - Compaction entries appended to the session during the run. Settlement scans for them because boundary handlers can persist a compaction without emitting `session_compact`.

  Compaction entries that existed before the run are ignored, and each compaction ID counts once.
- **Token math**: Pi reports `input`, `cacheRead`, and `cacheWrite` as separate buckets that do not overlap. `in` is their sum, `cached` is `cacheRead`, and `out` is `output`, which already includes reasoning tokens. Missing, negative, and non-finite values count as 0.
- **Cost** is the sum of `usage.cost.total`, shown in US dollars with four decimal places.
- **Exclusions**: automatic compaction before the prompt runs ahead of `before_agent_start`, so it falls outside the task window. Background cache warming does not emit these events.
- **Aborted tasks** append an entry with partial totals, in the same style as completed tasks.
- **State reset**: `session_start`, `session_shutdown`, and `session_tree` discard any run in progress. Settlement always clears the run, even when it appends no entry.
- **UI modes**: the extension appends the `pi-time` session entry only when `ctx.hasUI` is true, which covers the TUI and RPC. Print and JSON modes clear state without writing an entry.
- **Format**: `<elapsed> · tools <time> · in <n> (<n> cached), out <n> · $<cost> · <hh:mm:ss AM/PM>`. Numbers use en-US thousands separators, and the time is local 12-hour time.

## Publishing

`.github/workflows/check.yml` runs `npm run check` on Node.js 22.19.0 and Node.js 24.15.0 or later for every branch push and pull request.

`.github/workflows/publish.yml` runs on tags such as `v0.1.0`. It first runs the same checks on both Node.js versions. It then confirms that the tag matches the `package.json` version and stages the package on npm with `npm stage publish`. Versions with a prerelease suffix use the `next` dist-tag; all others use `latest`.

`prepublishOnly` also runs `npm run check`. The package is unscoped and public, and users install it with `pi install npm:pi-time`.
