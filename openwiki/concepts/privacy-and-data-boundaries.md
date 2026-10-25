---
type: Concept
title: "Privacy and data boundaries"
description: "The cross-cutting rules this project must not break: window titles are never obtained, usage records contain exactly {ts, exe}, search query text is never written to disk, upstream AI-tool stores are opened read-only, the data service exposes no HTTP write endpoint, and machine-written state stays out of the code tree - each rule stated with the enforcement that holds it."
tags: [privacy, data-boundaries, usage-log, read-only, get-only, adr-0002, adr-0001, runtime-data]
---

# Privacy and data boundaries

This page is the normative list of things an agent or contributor must not break while changing this repository. Each rule is stated together with the enforcement that keeps it, because in this codebase a boundary without an enforcement is only a preference: window titles, log fields, read-only access and the absence of a write channel are all held either by a standing test, by a real-machine acceptance assertion, or by a structural fact in the code that a change would visibly have to undo. Mechanisms live in the architecture pages, linked below rather than repeated here.

## The rules and what holds them

| Rule | Enforcement |
|---|---|
| Window titles are never obtained anywhere | The collection path never calls `GetWindowText`; a standing unit test scans every top-level `*.py` for `GetWindowText`, `window_title` and `WindowTitle` |
| A usage log record is exactly `{ts, exe}` | Unit tests at both the `append` and `Collector` level, plus an assertion in the real-machine acceptance battery over the live log directory |
| Search query text is never written | The trace writer receives only event tags and `qlen=<length>`; action tags carry no path; the feature's acceptance step greps the log and trace for the probe word |
| Upstream AI-tool stores are read strictly read-only | SQLite is opened with a `?mode=ro` URI, and each scanner selects metadata columns only |
| The service has no HTTP write endpoint | Only `do_GET` is defined; adding a mutating route would contradict [ADR-0001](/repo://docs/adr/0001-win32-icon-manipulation.md#L11-L14) and requires a new ADR |
| Machine-written state stays outside the code tree | `data_dir()` / `log_dir()` / `lock_path()` resolve under `%LOCALAPPDATA%\qoder-deck\`; only user-edited configuration lives in the repo |
| Collection is bounded in time | Usage log files older than 90 days are pruned hourly, so the record set cannot accumulate indefinitely |

## Window titles: never read, not "read and filtered"

The need for a frequency signal cannot be met from the machine's existing sources (`C:\Windows\Prefetch` is an empty directory because prefetching is disabled, and `UserAssist` holds only about four entries), so the service accumulates its own usage log. The richest signal a desktop application can observe is the foreground window title - and that is exactly what is forbidden, because the user's daily work is legal case research and titles routinely carry case numbers, party names and project names ([ADR-0002](/repo://docs/adr/0002-no-window-titles-in-usage-log.md#L3)).

The rule is deliberately enforced *at the collection path* rather than at the write: the foreground probe resolves the window's owning process and asks only for its image path (`GetForegroundWindow` → `GetWindowThreadProcessId` → `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` → `QueryFullProcessImageNameW`), and never calls `GetWindowText` ([usage_log.py](/repo://usage_log.py#L80-L100), [usage_log.py](/repo://usage_log.py#L1-L9)). Title text therefore never exists in the process at all.

Two alternatives were examined and rejected in ADR-0002; **do not re-propose either**:

- *Store titles locally only, never transmit* - rejected because a plaintext log file is itself the boundary, and once written to disk the data cannot be recalled.
- *Store titles with sanitization* - rejected because no rule set can enumerate the shapes of case numbers and party names, so one miss is one leak, and the information bought by titles contributes nothing to the actual question, "which application is used most" ([ADR-0002](/repo://docs/adr/0002-no-window-titles-in-usage-log.md#L5-L8)).

The permanent guard is a unit test, not a review convention: `PrivacyGuardTest` walks every top-level `*.py` module in the repository root and fails if any of them contains the strings `GetWindowText`, `window_title` or `WindowTitle` ([tests/test_usage_log.py](/repo://tests/test_usage_log.py#L105-L112)). The scan is one directory deep, so a module added under `scripts/` or `tests/` would not be caught by it - the boundary there holds by review.

Three consequences follow from the missing title, and they are design decisions rather than gaps ([ADR-0002](/repo://docs/adr/0002-no-window-titles-in-usage-log.md#L10-L14)): frequency is defined as *real start count under time decay*, not foreground dwell time (dwell time would only be meaningful with title-level granularity); the document zone can only be ordered by file modification time, never by a reuse of the frequency score; and a process whose path cannot be mapped to a desktop icon through its `.lnk` target is still logged, but never ranked.

The same "never read" posture extends to the agent session list. The upstream `hermes` and `zcode` databases both contain a `title` column, yet neither scanner selects it - the hermes query takes `id, cwd, last_activity_at, started_at, end_reason, archived` and the zcode query takes `id, directory, time_updated, time_archived` ([agent_sessions.py](/repo://agent_sessions.py#L181-L186), [agent_sessions.py](/repo://agent_sessions.py#L207-L218)). kimi work goes further: its rows are title-less by design because the conversation body is locked in an upstream private store, so a row carries only a tool label, a state and an age ([agent_sessions.py](/repo://agent_sessions.py#L276-L292), [README.md](/repo://README.md#L46)). See [agent session collection](/openwiki/architecture/agent-session-collection.md) for the scanner mechanics.

## The usage record shape and its retention

Every event is appended as one JSON line with exactly two fields, `ts` (second-precision ISO timestamp) and `exe` ([usage_log.py](/repo://usage_log.py#L54-L61)):

```json
{"ts": "2026-09-23T12:00:00+00:00", "exe": "C:\\Program Files\\app\\app.exe"}
```

This is asserted three times over, so adding a field cannot pass silently: once on a record produced by `append`, once on the files a real `Collector` writes with its process and foreground sources monkeypatched, and once on the actual log directory by the acceptance battery, which requires the key set of every parsed line to equal `{"ts", "exe"}` ([tests/test_usage_log.py](/repo://tests/test_usage_log.py#L44-L50), [tests/test_usage_log.py](/repo://tests/test_usage_log.py#L90-L102), [scripts/accept_zones.py](/repo://scripts/accept_zones.py#L92-L98)).

Retention is part of the same boundary: `prune` deletes `*-*.jsonl` files older than 90 days on an hourly schedule, skipping names whose date tail does not parse and never deleting the current day ([usage_log.py](/repo://usage_log.py#L21-L22), [usage_log.py](/repo://usage_log.py#L64-L77)). Frequency scoring, decay and the cold-start prior built on top of these files are covered by [usage telemetry and frequency scoring](/openwiki/architecture/usage-telemetry-and-recommendation.md).

## Query text is never logged

The search panel is the one place where the user types content, and the rule is that this content is never persisted by this project. The `QD_PANEL_TRACE=<path>` diagnostic channel writes one line per event containing the timestamp, the event tag, the panel state, `qlen=<length of the query>` and the window handle - never the text ([search_panel.py](/repo://search_panel.py#L104-L112), [search_panel.py](/repo://search_panel.py#L1-L15)). The result actions are equally mute: `_act` traces `open` or `reveal`, not the path acted on, even though the path is what the action operates on ([search_panel.py](/repo://search_panel.py#L318-L332)). The panel writes nothing at all to the usage log, and the trace channel is opt-in via an environment variable. This is checked during the feature's acceptance run by grepping both the usage log and the trace file for the probe query word and requiring zero hits, rather than by a standing unit test ([.scratch/listary-search/issues/02-listary-engine-results.md](/repo://.scratch/listary-search/issues/02-listary-engine-results.md#L39)).

Query words leave the process only as a POST to Listary on the loopback interface (`127.0.0.1:38431`, `POST /api/v1/search`, one connection per request), so no query ever traverses the network beyond the machine ([listary_engine.py](/repo://listary_engine.py#L20-L23), [listary_engine.py](/repo://listary_engine.py#L198-L217), [.scratch/listary-search/spec.md](/repo://.scratch/listary-search/spec.md#L33)). Panel behaviour is documented in [search panel](/openwiki/architecture/search-panel.md).

**Accepted exception:** Listary keeps recording queries in its own `SearchHistory`. That is its native behaviour and this project neither suppresses nor scrubs it; the boundary being enforced is this project's own persistence, not the engine's ([ADR-0003-search-panel-service-window](/repo://docs/adr/0003-search-panel-service-window.md#L17-L18), [.scratch/listary-search/spec.md](/repo://.scratch/listary-search/spec.md#L55)).

## Upstream AI-tool stores: read-only by URI, metadata-only by query

The five agent tools' local stores belong to those tools. This project reads them and must never write to them. The structural guarantee is the SQLite open mode: `_open_ro` connects with `f"file:{db_path}?mode=ro"` and `uri=True`, plus a deliberately short `timeout=0.5` so that a database held by a writer fails fast instead of stalling the `/deck` poll ([agent_sessions.py](/repo://agent_sessions.py#L147-L149)). JSON-based stores (qoder's `*.jsonl` and task files, kimi code's `state.json`, kimi work's status maps) are read with `read_text`/reads only.

A read failure never escalates into anything worse than a skipped tool: `collect_sessions` wraps each scanner in `except Exception`, prints one line naming the tool, and continues with the remaining tools, so a corrupt or missing store degrades one row set instead of the HTTP contract ([agent_sessions.py](/repo://agent_sessions.py#L16-L27)). Combined with the metadata-only `SELECT` lists above, the read side of this project cannot leak titles, and cannot damage a store it reads.

## No HTTP write endpoint

The data service is a GET-only API on a loopback-only host, and that is a privacy boundary rather than an accident of implementation. Only `do_GET` is defined, with exactly two routes; there is no authentication anywhere, and the wildcard `Access-Control-Allow-Origin: *` header exists because the wallpaper's embedded browser makes cross-origin calls to the loopback port ([server.py](/repo://server.py#L200-L217), [server.py](/repo://server.py#L24-L26)). ADR-0001 records why that combination is acceptable: because arranging icons is done with Win32 messages to explorer instead of a clickable wallpaper UI, no write endpoint is needed, and "no unauthenticated write channel is introduced on this machine" is named as that decision's single biggest side benefit ([ADR-0001](/repo://docs/adr/0001-win32-icon-manipulation.md#L11-L14)). Every capability that would otherwise have wanted a mutating route is instead routed around HTTP: the arrangement CLI, the in-process desktop-directory watcher thread, and the search panel window thread all live inside the service process ([server.py](/repo://server.py#L249-L254), [ADR-0003-search-panel-service-window](/repo://docs/adr/0003-search-panel-service-window.md#L17)).

Adding `do_POST` (or any mutating route) therefore removes the property ADR-0001 is protecting and requires an ADR, not a patch. The [data service](/openwiki/architecture/data-service.md) page documents the contract itself.

## What may be written, and where

Two directories carry different ownership, and the split is the operational expression of "the repository is source, the machine owns the state":

| Kind | Location | Examples |
|---|---|---|
| Source and user-edited configuration | Repository tree | `pinned.json` - the ordered pin list, read by `load_pinned()` from the repository root and taking effect at the next arrangement ([zones_orchestrate.py](/repo://zones_orchestrate.py#L17-L23)) |
| Machine-written runtime state | `%LOCALAPPDATA%\qoder-deck\` (with an `AppData\Local` fallback) | `layout\` snapshots, `usage\` log, `watcher.log`, the `arrange.lock` directory and its holder file ([desktop_layout.py](/repo://desktop_layout.py#L24-L26), [usage_log.py](/repo://usage_log.py#L30-L32), [zones_watcher.py](/repo://zones_watcher.py#L31-L44), [zones_lock.py](/repo://zones_lock.py#L26-L32)) |
| Process-level toggles | Environment variables, never files | `QD_PORT`, `QD_LISTARY_PORT`, `QD_PANEL_TRACE`, `QD_PANEL_CRASH`, `QD_PANEL_AUTOACTIVATE` |

`README.md` states the same split for operators: runtime data is explicitly "not in the repository" and enumerated by name ([README.md](/repo://README.md#L74-L76)). [Runtime data and configuration](/openwiki/operations/runtime-data-and-configuration.md) covers the file formats and lifecycles.

Two invariants protect the user's desktop within that state:

- **Icon coordinates are the only thing written to the desktop.** Snapshots and restores read and write `(x, y)` pairs keyed by display name; they never move, rename or delete a file on disk ([desktop_layout.py](/repo://desktop_layout.py#L1-L7)). The rejected alternative in ADR-0001 was exactly this: archiving documents into a subfolder under the desktop would have broken hard-coded absolute paths, cloud synchronisation and muscle memory, and would be irreversible ([ADR-0001](/repo://docs/adr/0001-win32-icon-manipulation.md#L9)).
- **The factory snapshot is write-once.** `ensure_factory` writes `factory.json` only when it does not yet exist, so the pre-arrangement state is always recoverable; the acceptance battery re-checks the invariant by requiring `mtime == ctime` on that file ([desktop_layout.py](/repo://desktop_layout.py#L70-L76), [scripts/accept_zones.py](/repo://scripts/accept_zones.py#L62-L69)).

## Accepted limits and exceptions

These are known, deliberate, and should not be "fixed" without reopening the ADR that accepted them:

- **Listary's own search history still records query words** (above).
- **Arrangement reaches the public desktop.** `desktop_dirs()` returns both the user desktop (`CSIDL_DESKTOP`) and the public desktop (`CSIDL_COMMON_DESKTOP`), and positions are stored by display name without recording which folder an item came from - so .lnk arrangements on `C:\Users\Public\Desktop` take effect machine-wide, for every user ([desktop_icons.py](/repo://desktop_icons.py#L161-L162), [ADR-0001](/repo://docs/adr/0001-win32-icon-manipulation.md#L15)).
- **The title guard is one directory deep** and only scans top-level Python modules ([tests/test_usage_log.py](/repo://tests/test_usage_log.py#L105-L112)).
- **The API is loopback-only but unauthenticated**, with a wildcard CORS header. This is accepted solely because no route mutates state ([server.py](/repo://server.py#L24-L26), [ADR-0001](/repo://docs/adr/0001-win32-icon-manipulation.md#L11-L14)).
- **kimi work rows carry no title or project** because the conversation body lives in an upstream private store; the degradation is visible in the session list by design ([agent_sessions.py](/repo://agent_sessions.py#L276-L292), [README.md](/repo://README.md#L46)).
- **No document-level usage ranking is possible.** The document zone sorts by file modification time only, and processes that cannot be mapped to a desktop icon are logged but excluded from ranking ([ADR-0002](/repo://docs/adr/0002-no-window-titles-in-usage-log.md#L10-L14)).

## Related pages

- [Data service](/openwiki/architecture/data-service.md) - the endpoints, host binding and thread model behind the GET-only rule.
- [Usage telemetry and frequency scoring](/openwiki/architecture/usage-telemetry-and-recommendation.md) - what the two-field log feeds, and why dwell time is impossible.
- [Agent session collection](/openwiki/architecture/agent-session-collection.md) - the five read-only scanners and their per-tool degradation.
- [Search panel](/openwiki/architecture/search-panel.md) - the trace channel that records length instead of text.
- [Desktop zones: execution](/openwiki/architecture/desktop-zones-execution.md) - snapshots, restore and the coordinate-only write surface.
- [Runtime data and configuration](/openwiki/operations/runtime-data-and-configuration.md) - file formats, locations and lifecycles of the application-data subtree.
- [Test suite](/openwiki/testing/test-suite.md) - where the standing guards live and how the acceptance battery runs them on a real machine.
