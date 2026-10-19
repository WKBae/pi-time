# pi-time

A [Pi](https://github.com/earendil-works/pi) extension that shows how long each task took, how many tokens it used, what it cost, and when it finished. After Pi finishes all work for your prompt, it shows a notification like this:

```text
1m 23s · tools 12s · in 1,200 (800 cached), out 90 · $0.0123 · 01:05:09 PM
```

## Requirements

- Node.js 22.19.0 or later
- Pi 1.3.0 or later (tested with 1.3.0)

## Install

```sh
pi install npm:pi-time
```

This adds the package to `~/.pi/agent/settings.json` for all your projects. To enable it for the current project only, add `--local`:

```sh
pi install --local npm:pi-time
```

If Pi is already running, type `/reload` to load the extension.

To try the extension for a single session without changing your settings:

```sh
pi -e npm:pi-time
```

## Use

The extension needs no configuration. Send a prompt as usual, and the notification appears when Pi finishes.

If you cancel a task, you still get a notification, shown as a warning, with the time and usage up to that point.

Notifications appear in the interactive terminal UI and are sent to RPC clients. Print mode (`pi -p`) and JSON mode show no notification.

## Read the notification

| Field | Example | Meaning |
| --- | --- | --- |
| Elapsed time | `1m 23s` | Time from the start of the task until Pi finished all automatic work, rounded down to the second. Includes tool runs, automatic retries, follow-up turns, and compaction that happens during the task. |
| `tools` | `tools 12s` | Time with at least one tool executing, rounded down to the second. Overlapping parallel or nested calls count once. Included in elapsed time. |
| `in` | `in 1,200` | All input tokens: uncached input, cache reads, and cache writes. |
| `cached` | `(800 cached)` | The part of `in` that was read from the provider's cache. |
| `out` | `out 90` | Output tokens. Reasoning tokens are already included in this number. |
| Cost | `$0.0123` | Sum of the costs Pi reports, in US dollars. |
| Completion time | `01:05:09 PM` | When the task finished, in your local time zone. |

The totals include every model response, every tool result that reports usage, and every compaction during the task. They exclude:

- Anything that happened before the task started, including automatic compaction that Pi runs before sending your prompt.
- Background cache warming.
- Calls that do not report usage.

The cost is an estimate from Pi's model pricing. It does not reflect your actual bill or remaining subscription quota. When Pi has no price for the model, the cost shows `$0.0000`.

## Uninstall

```sh
pi remove npm:pi-time
```

Add `--local` if you installed it for the current project only. Run `pi list` to see installed packages.

## Report a problem

Open an issue at <https://github.com/WKBae/pi-time/issues>.

## License

[MIT](LICENSE)
