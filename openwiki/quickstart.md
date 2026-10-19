---
type: Guide
title: "Quickstart: what AGENT DECK is and where to change it"
description: "Entry point and task-routing map for the AGENT DECK panel wiki: what the app is, the three-process topology in one paragraph, the three change surfaces (main-process cordis services, renderer and desktop components, Windows integrations), the npm commands agents actually run, and a table from \"I want to change X\" to the page to read first."
tags: [quickstart, orientation, entry-point, navigation, change-surfaces, commands]
verified:
  - by: openwiki/0.5.2
    at: 2026-09-25T07:24:20.996Z
sources:
  - id: openwiki-source-ea70eb6c045047448e446296
    resource: repo://.gitignore
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-fb5063102320e02df7c15531
    resource: repo://app/accept/battery.js
  - id: openwiki-source-bb10b670204c16db33dbab0b
    resource: repo://app/package.json
  - id: openwiki-source-5789591f12c702d2a364a593
    resource: repo://app/src/main/dataplane.ts
  - id: openwiki-source-f73210d9bf8298422fa23477
    resource: repo://app/src/main/desktop/adapter.ts
  - id: openwiki-source-0b2030a672bb8f349c1b892f
    resource: repo://app/src/main/focus/adapter.ts
  - id: openwiki-source-d6655756221a3a73808c812b
    resource: repo://app/src/main/index.ts
  - id: openwiki-source-712ee72b64efd641a0ac98a8
    resource: repo://app/src/main/kernel.ts
  - id: openwiki-source-52c2254c5b27b4bfc9a82a64
    resource: repo://app/src/main/panel-ipc.ts
  - id: openwiki-source-bcce46d244ce3a3231ed8ba3
    resource: repo://app/src/main/panel-kernel.ts
  - id: openwiki-source-35061cb36d4526b74e38cb12
    resource: repo://app/src/main/services/dataplane.ts
  - id: openwiki-source-2cbd6f15cd5e0aa5ea4f250b
    resource: repo://app/src/preload/index.ts
  - id: openwiki-source-3113b88642e26f3dd520e4ae
    resource: repo://app/src/shared/contract.ts
  - id: openwiki-source-f6d799db3c281e528a194d30
    resource: repo://archive/README.md
  - id: openwiki-source-39c3295efc089133e87a9c80
    resource: repo://CONTEXT.md
  - id: openwiki-source-91f6a39e4d544d3ef80cb6f8
    resource: repo://docs/adr/0004-electron-cordis-standalone-panel.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
generated: { by: "openwiki/0.5.2", at: "2026-09-25T07:24:20.996Z" }
---

# Quickstart: what AGENT DECK is and where to change it

<!-- openwiki: broken internal link [/repo://README.md#L11-L19] file "/repo://README.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/package.json#L6-L14] file "/repo://app/package.json" does not exist. Fix the href or restore the target, then delete this comment. -->
**AGENT DECK** is a resident operations panel for one Windows machine. A single transparent, frameless Electron window floats over whatever wallpaper the user has chosen, shows the active sessions of five AI tools (Qoder, kimi code, kimi work, zcode, hermes — the session rows carry the two-letter tool tags QD, KC, KW, ZC, HM) plus hardware gauges as a card grid with a bottom dock, hosts the user's desktop items itself while explorer's native icon view is hidden, and is extended through hot-pluggable desktop components. It runs from a checkout: there is no installer and no packaging step, and `dist/` is the only build product ([README](/repo://README.md#L11-L19), [package.json](/repo://app/package.json#L6-L14)).

## Read this first if a name looks wrong

<!-- openwiki: broken internal link [/repo://README.md#L9] file "/repo://README.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://archive/README.md#L1-L27] file "/repo://archive/README.md" does not exist. Fix the href or restore the target, then delete this comment. -->
**The Python data service and the Wallpaper Engine era are retired, not merely renamed.** The Python HTTP data service (`server.py`), its Startup watchdog, the Tk search overlay window, the Win32 "move the real desktop icons" chain and the three Wallpaper Engine deploy/apply/restore scripts were all retired on 2026-09-29 (工单11); their capabilities live on as cordis services in `app/src/main/`. The wallpaper assets are frozen read-only under `archive/wallpaper-assets/` — kept so that "the wallpaper used to live here" stays verifiable, referenced by no build, test or runtime path, and taking no fixes. New functionality must never depend on them ([README](/repo://README.md#L9), [archive/README](/repo://archive/README.md#L1-L27)).

<!-- openwiki: broken internal link [/repo://CONTEXT.md#L119-L159] file "/repo://CONTEXT.md" does not exist. Fix the href or restore the target, then delete this comment. -->
So when an old ticket, comment, commit message or log line says **数据服务**, **看门狗**, **搜索浮层窗**, **漂移纠正** or **布局快照**, read it as history rather than as something to patch. `CONTEXT.md` keeps a dedicated "已退役词汇" section for exactly this reason, and the [domain model](/openwiki/concepts/domain-model.md) page bridges it to the code that exists now ([CONTEXT.md](/repo://CONTEXT.md#L119-L159)).

Repository docs, code comments and commit messages are Chinese; this wiki is English. Identifiers, config keys and log event names stay verbatim on both sides — `config.autostart.appDir`, `config.search.port`, `AGENT DECK.lnk`, `ENGINE OFFLINE`, `dataplane-exit`, `single-instance-refused`, `DECK_EVENT_LOG` are search keys, not prose.

## The system in one paragraph

<!-- openwiki: broken internal link [/repo://docs/adr/0004-electron-cordis-standalone-panel.md#L6-L24] file "/repo://docs/adr/0004-electron-cordis-standalone-panel.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md#L5-L7] file "/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L183-L234] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/panel-kernel.ts#L34-L52] file "/repo://app/src/main/panel-kernel.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/hotzone.ts#L4-L29] file "/repo://app/src/main/hotzone.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/dataplane.ts#L1-L59] file "/repo://app/src/main/dataplane.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/services/dataplane.ts#L24-L64] file "/repo://app/src/main/services/dataplane.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/panel-window.ts#L16-L43] file "/repo://app/src/main/panel-window.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/preload/index.ts#L1-L31] file "/repo://app/src/preload/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
Three processes on one machine, split by [ADR-0004](/repo://docs/adr/0004-electron-cordis-standalone-panel.md#L6-L24) (Electron as window host plus cordis as the panel's plugin kernel) and [ADR-0005](/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md#L5-L7) (a measured machine-wide mouse stall, caused by collection blocking the thread that carries Electron's input path). The **outer supervisor** — `electron .`, the default entry — takes the machine's single-instance lock, hides explorer's native desktop icons, spawns a detached restore watcher, spawns the panel as a child on `--panel`, and restores the icons when that child exits; it opens no window and runs no data collection ([index.ts](/repo://app/src/main/index.ts#L183-L234)). The **panel main process** is the window host and the cordis kernel: panel window with 25 ms cursor-polled hotzones and bottom pinning, tray, bridge IPC to the renderer, search, settings, session-row focus and the desktop-component plugin host with its `deck-plugin://` asset protocol; it registers no collection timer at all ([panel-kernel.ts](/repo://app/src/main/panel-kernel.ts#L34-L52), [hotzone.ts](/repo://app/src/main/hotzone.ts#L4-L29)). The **data-plane subprocess** — an Electron `utilityProcess` child running `dist/main/dataplane.js` — owns all four periodic collectors (sessions, hardware, usage log, desktop carry) with their timers, the placement store `layout.json` and the usage JSONL, and pushes one snapshot per second back to the panel, which caches it and forwards it ([dataplane.ts](/repo://app/src/main/dataplane.ts#L1-L59), [services/dataplane.ts](/repo://app/src/main/services/dataplane.ts#L24-L64)). The renderer is a sandboxed page served as native ESM over `deck-plugin://app/index.html` and reaches the kernel only through `window.deck.bridge` ([panel-window.ts](/repo://app/src/main/panel-window.ts#L16-L43), [preload/index.ts](/repo://app/src/preload/index.ts#L1-L31)).

<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L34-L114] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/services/dataplane.ts#L11-L12] file "/repo://app/src/main/services/dataplane.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
Boot order is load-bearing: `app/config.json` is loaded or generated → the autostart decision is applied → the legacy Python-era usage log is migrated → the kernel is created and started → the **first paint waits for the data plane's first snapshot** (15 s cap, then the panel starts empty and the next snapshot fills it) → the protocol handler is installed → the window is created, the bridge and host IPC are wired, the tray is created, and `panelUrl()` is loaded ([index.ts](/repo://app/src/main/index.ts#L34-L114), [services/dataplane.ts](/repo://app/src/main/services/dataplane.ts#L11-L12)). The full topology, including who owns which state and which OS surfaces are written, is [system overview](/openwiki/architecture/overview.md).

## The three change surfaces

Almost every change lands on exactly one of three surfaces. The two seams that tie them together — the cordis kernel and the bridge contract — are documented once and not repeated here.

| Surface | What you add or change | Where it plugs in |
|---|---|---|
<!-- openwiki: broken internal link [/repo://app/src/main/kernel.ts#L62-L165] file "/repo://app/src/main/kernel.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
| **Main-process capabilities** (cordis services) | One `Service` class per capability. Collectors live in `app/src/main/services/` with their helpers (`sessions.ts`, `hardware.ts`, `usage.ts`, `desktop.ts` plus `app/src/main/{scanners,hardware,usage,desktop}/`); host-side services are `bridge.ts`, `clock.ts`, `search.ts`, `settings.ts`, `focus.ts`, `panel-data.ts`, `dataplane.ts`; the plugin host is `app/src/main/plugins/` | `app/src/main/kernel.ts` — `createKernel` (all services in-process, what the offline suite loads) and `createDataplaneKernel` (the four collectors, used by the child entry); `app/src/main/panel-kernel.ts` — `createPanelKernel`, the Electron production assembly. A collector belongs to the data-plane kernel; the production panel kernel registers none ([kernel.ts](/repo://app/src/main/kernel.ts#L62-L165)) |
<!-- openwiki: broken internal link [/repo://app/src/shared/contract.ts#L1-L7] file "/repo://app/src/shared/contract.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L19-L26] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
| **Renderer and desktop components** | `app/src/renderer/`: the page (`index.html`), the render loop and in-page interaction (`main.ts`), the plugin mount runtime (`plugins.ts`), plus built-in components as `app/src/renderer/cards/<id>/` with a `plugin.json` manifest. User components install into `userData/plugins`, or wherever `config.plugins.dir` points | `app/src/shared/contract.ts` is the only API shape across the seam — `PanelSnapshot`'s sections, the `BridgeMethods` request/response map and the `BridgeEvents` push map. New methods and events extend those maps; no second channel is opened, and the skill of adding a card is the same contract a user plugin follows ([contract.ts](/repo://app/src/shared/contract.ts#L1-L7), [index.ts](/repo://app/src/main/index.ts#L19-L26)) |
<!-- openwiki: broken internal link [/repo://app/src/main/desktop/adapter.ts#L1-L5] file "/repo://app/src/main/desktop/adapter.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/focus/adapter.ts#L1-L5] file "/repo://app/src/main/focus/adapter.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
| **Windows integrations** | koffi FFI bindings and window messages (`win32.ts`, `focus/adapter.ts`, `usage/native.ts`, `desktop/adapter.ts`), the PowerShell COM helper `autostart.ps1`, the detached `icon-restore-watch.cjs`, `icon-carry.ts`, nvidia-smi probing | Nothing registers these: they are invoked by the services above, and each has a non-Electron fallback so that importing it under plain Node stays harmless — which is what keeps `npm test` loadable ([desktop/adapter.ts](/repo://app/src/main/desktop/adapter.ts#L1-L5), [focus/adapter.ts](/repo://app/src/main/focus/adapter.ts#L1-L5)) |

<!-- openwiki: broken internal link [/repo://app/src/main/kernel.ts#L61-L62] file "/repo://app/src/main/kernel.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/panel-kernel.ts#L1-L3] file "/repo://app/src/main/panel-kernel.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
One rule pre-empts most design mistakes: **no module the offline suite loads may import `electron` at module scope.** `kernel.ts` is pure Node, `panel-kernel.ts` and `services/dataplane.ts` deliberately are not, and a service added to `createKernel` must be constructible from injected dependencies rather than reaching for a real source at construction time ([kernel.ts](/repo://app/src/main/kernel.ts#L61-L62), [panel-kernel.ts](/repo://app/src/main/panel-kernel.ts#L1-L3)).

## Commands you actually run

All of them run from `app/`, and every launching script builds first — there is no watch mode, so a source edit costs a full rebuild plus a relaunch.

| Command | What it does |
|---|---|
| `npm run build` | `tsc -p tsconfig.json && tsc -p tsconfig.renderer.json && node scripts/copy-assets.mjs` — main (CommonJS), renderer (native ESM) and the asset copy into one `dist/` |
| `npm run dev` | build, then `electron .` — the default entry: outer supervisor → native icons hidden → panel |
| `npm run dev:panel` | build, then `electron . --panel` — panel only, skipping the supervisor, for debugging |
| `npm test` | `vitest run` — the offline suite; specs import `src` directly, so it needs no build and no Electron |
| `npm run typecheck` | `tsc -p tsconfig.typecheck.json` — no output; the only program that also sees `tests/` |
| `npm run accept` | build, then `electron . --accept` — the real-machine acceptance battery, writing screenshots and an event log under `app/accept/evidence/` |

<!-- openwiki: broken internal link [/repo://app/package.json#L7-L14] file "/repo://app/package.json" does not exist. Fix the href or restore the target, then delete this comment. -->
They are declared in [package.json](/repo://app/package.json#L7-L14); the build layout, the dist interface and the worktree rules are in [build, run and develop locally](/openwiki/operations/build-and-run.md).

<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L27-L32] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L176-L247] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
Runtime flags are chosen purely from `process.argv`, and these matter day to day ([index.ts](/repo://app/src/main/index.ts#L27-L32), [index.ts](/repo://app/src/main/index.ts#L176-L247)):

- `--panel` runs the panel process directly; `npm run dev:panel` is the script form.
- `--accept` runs the battery in the same Electron context with the single-instance lock bypassed, which is why acceptance can run next to a resident panel.
- `npx electron . --icon-restore` is the one-shot self-rescue path: it forces the native desktop icons visible and exits without taking the lock, so it is safe while a panel is running.
<!-- openwiki: broken internal link [/repo://app/src/main/panel-ipc.ts#L9-L24] file "/repo://app/src/main/panel-ipc.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- `DECK_EVENT_LOG=<file>` turns the main process into a JSONL evidence recorder — the battery sets it, and it is the first thing to switch on when something behaves oddly on the real machine ([panel-ipc.ts](/repo://app/src/main/panel-ipc.ts#L9-L24)).

<!-- openwiki: broken internal link [/repo://.gitignore#L18-L22] file "/repo://.gitignore" does not exist. Fix the href or restore the target, then delete this comment. -->
`app/node_modules/` and `app/dist/` are untracked, so a fresh checkout — including every new worktree — needs its own `npm install` ([.gitignore](/repo://.gitignore#L18-L22)).

## Routing table

### What the panel observes and draws

| I want to change… | Read first | Code |
|---|---|---|
| Which sessions appear, what `RUN`/`CONFIRM`/`DONE`/`IDLE` mean, the 90 s and 10 min windows, merging and sort order | [Multi-tool session collection](/openwiki/architecture/agent-session-collection.md) | `app/src/main/scanners/*.ts`, `app/src/main/services/sessions.ts` |
| How one specific tool stores its sessions on disk (jsonl, state leases, SQLite, mtime-driven files) | [The five AI tool stores](/openwiki/integrations/agent-tool-stores.md) | `app/src/main/scanners/qoder.ts`, `…/kimiwork.ts`, `…/zcode.ts`, `…/sqlite.ts` |
| What clicking a session row does — focus an existing window vs launch the tool, and the tool→exe map | [Clicking a session row](/openwiki/workflows/session-row-to-tool-window.md) | `app/src/main/services/focus.ts`, `app/src/main/focus/{plan,adapter}.ts`, `config.tools` |
| A hardware gauge or its sparkline history | [Hardware telemetry](/openwiki/architecture/hardware-telemetry.md) | `app/src/main/services/hardware.ts`, `app/src/main/hardware/*.ts` |
| Dock order, classification into app vs document zone, document groups and column folding | [Desktop zones planning](/openwiki/architecture/desktop-zones-planning.md) | `app/src/main/desktop/{plan,scan,layout-store}.ts` |
| Desktop refresh policy, placement writes, icon extraction, launch validation | [Desktop carry runtime](/openwiki/architecture/desktop-zones-execution.md) | `app/src/main/services/desktop.ts`, `app/src/main/desktop/{adapter,icons,watch}.ts` |
| The drag gesture in the page and how a drop persists | [Dragging a desktop item](/openwiki/workflows/desktop-item-drag-to-layout.md) | `app/src/renderer/main.ts`, then the bridge and data-plane path |
| The usage log, frequency scoring, the cold-start prior | [Usage telemetry and recommendation](/openwiki/architecture/usage-telemetry-and-recommendation.md) | `app/src/main/services/usage.ts`, `app/src/main/usage/*.ts` |
| Search activation, debounce, retry/backoff and the `ENGINE OFFLINE` state | [Search panel](/openwiki/architecture/search-panel.md), [search query lifecycle](/openwiki/workflows/search-query-lifecycle.md) | `app/src/main/services/search.ts`, `app/src/main/search/{engine,client}.ts` |
| The Listary request itself — host, path, body, error codes | [Listary local search API](/openwiki/integrations/listary-engine.md) | `app/src/main/search/client.ts`, `config.search.port` |
<!-- openwiki: broken internal link [/openwiki/workflows/snapshot-pipeline.md] file "/openwiki/workflows/snapshot-pipeline.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Sampling cadence, the 1 Hz snapshot, write RPCs, data-plane crash and restart | [Data plane subprocess](/openwiki/architecture/data-service.md), [one snapshot end to end](/openwiki/workflows/snapshot-pipeline.md) | `app/src/main/dataplane.ts`, `app/src/main/dataplane-protocol.ts`, `app/src/main/services/dataplane.ts` |
| Boot modes, window options, mouse pass-through, z-order pinning, tray recall, Win+D recovery | [Process lifecycle and windowing](/openwiki/architecture/process-lifecycle-and-windowing.md) | `app/src/main/{index,panel-window,hotzone,win32,tray,wind-restore}.ts` |
| Hiding/restoring explorer's desktop icons, or the Startup `AGENT DECK.lnk` | [Desktop icon carry and Startup autostart](/openwiki/architecture/desktop-icon-carry-and-autostart.md) | `app/src/main/{icon-carry,icon-restore-watch.cjs,autostart.ts,autostart.ps1}` |
| The card grid, dock, document columns, settings overlay, hotzone declarations | [Renderer panel](/openwiki/architecture/renderer-panel.md) | `app/src/renderer/{index.html,main.ts,format.ts}` |
| A new desktop component, its manifest, mounting, reload or hot-plug behaviour | [Desktop component plugin host](/openwiki/architecture/plugin-host.md), [installing a component](/openwiki/workflows/plugin-hot-plug.md) | `app/src/main/plugins/*.ts`, `app/src/renderer/plugins.ts`, `app/src/renderer/cards/<id>/`, `app/samples/hello-plugin/` |
| A specific Windows call — shell view command, registry read, FFI enumeration, nvidia-smi, PowerShell, file launch | [Windows shell, registry and native APIs](/openwiki/integrations/windows-shell-and-system-apis.md) | `app/src/main/{win32.ts,icon-carry.ts,focus/adapter.ts,usage/native.ts,hardware/nvidia.ts}` |
| The background layer, or anything from the retired wallpaper toolchain | [Background layer and the retired Wallpaper Engine toolchain](/openwiki/integrations/wallpaper-engine.md) | `archive/` (read-only, referenced by nothing) |

### The seams, and the words

| I want to change… | Read first | Code |
|---|---|---|
| A bridge method, a pushed event, or a snapshot section that both sides read | [Bridge contract and IPC transport](/openwiki/architecture/bridge-contract-and-ipc.md) | `app/src/shared/contract.ts`, `app/src/main/services/bridge.ts`, `app/src/main/panel-ipc.ts`, `app/src/preload/index.ts` |
| Which services exist, in what order they are registered, who injects whom, which timers the kernel owns | [cordis kernel: service assembly, seams and timers](/openwiki/architecture/cordis-kernel-and-services.md) | `app/src/main/kernel.ts`, `app/src/main/panel-kernel.ts`, `app/src/main/services/panel-data.ts` |
| My mental model of the whole system | [System overview](/openwiki/architecture/overview.md) | — |
| The meaning of a term (会话行, 桌面项, 栏位, 手钉, 编排, 待机态 …) | [Domain model and vocabulary](/openwiki/concepts/domain-model.md) | `CONTEXT.md`, `app/src/shared/contract.ts` |
| What may be recorded, sent or opened on the user's behalf | [Privacy and data boundaries](/openwiki/concepts/privacy-and-data-boundaries.md) | `app/src/main/usage/native.ts`, `app/src/main/search/engine.ts`, `app/src/main/plugins/service.ts` |

### Operating and verifying

| I want to do… | Read first | Notes |
|---|---|---|
<!-- openwiki: broken internal link [/repo://AGENTS.md#L5-L13] file "/repo://AGENTS.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Build, launch, or work in a parallel worktree | [Build, run and develop locally](/openwiki/operations/build-and-run.md) | The panel is single-instance: worktrees must not each keep a resident panel, and real-machine verification goes through `npm run accept` ([AGENTS.md](/repo://AGENTS.md#L5-L13)) |
<!-- openwiki: broken internal link [/openwiki/operations/configuration-reference.md] file "/openwiki/operations/configuration-reference.md" does not exist. Fix the href or restore the target, then delete this comment. -->
| Change `app/config.json` or find where runtime state lives | [Configuration reference](/openwiki/operations/configuration-reference.md) | Production values live in `app/config.json`; runtime state lives in Electron's `userData` (`layout.json`, `usage/`), never in the code directory |
| Diagnose a real-machine failure | [Recovery and diagnostics playbook](/openwiki/operations/recovery-and-diagnostics.md) | Start from `DECK_EVENT_LOG=<file>` and the event names listed there |
| Add or fix an offline test | [Testing strategy](/openwiki/testing/testing-strategy.md) | Vitest specs import `src` directly and inject fake dependency bundles; no module they load may import `electron` at module scope |
| Know what the acceptance battery proves and what stays manual | [Real-machine acceptance battery](/openwiki/testing/acceptance-battery.md) | Visual alignment and a true reboot for autostart remain manual checks |

## Ground rules that shape a change

<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L184-L199] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L173] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- **One panel per machine.** The supervisor refuses a second launch in milliseconds and the running instance receives `second-instance`, which re-shows the panel — so starting the app again behaves like the tray item, and no parallel worktree should keep its own resident panel ([index.ts](/repo://app/src/main/index.ts#L184-L199), [index.ts](/repo://app/src/main/index.ts#L173)).
<!-- openwiki: broken internal link [/repo://README.md#L73-L81] file "/repo://README.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://app/src/main/index.ts#L51-L65] file "/repo://app/src/main/index.ts" does not exist. Fix the href or restore the target, then delete this comment. -->
- **The autostart link belongs to the machine, not to a checkout.** Only a run whose app directory equals the declared `config.autostart.appDir` may create or take over `AGENT DECK.lnk`; a live link pointing elsewhere is never retargeted, and the retired watchdog link is deleted unconditionally ([README](/repo://README.md#L73-L81), [index.ts](/repo://app/src/main/index.ts#L51-L65)).
- **`archive/` is provenance, not a library.** Do not reference its fonts or assets from new code.
<!-- openwiki: broken internal link [/repo://AGENTS.md#L11-L13] file "/repo://AGENTS.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- **Remote branch discipline.** Deleting a remote branch requires explicit user confirmation; local `git branch -d` does not ([AGENTS.md](/repo://AGENTS.md#L11-L13)).
<!-- openwiki: broken internal link [/repo://docs/adr/0004-electron-cordis-standalone-panel.md] file "/repo://docs/adr/0004-electron-cordis-standalone-panel.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md] file "/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://docs/adr/0002-no-window-titles-in-usage-log.md] file "/repo://docs/adr/0002-no-window-titles-in-usage-log.md" does not exist. Fix the href or restore the target, then delete this comment. -->
<!-- openwiki: broken internal link [/repo://docs/adr/0003-multi-tool-unified-session-model.md] file "/repo://docs/adr/0003-multi-tool-unified-session-model.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- **Architecture decisions are recorded, not inferred.** [ADR-0004](/repo://docs/adr/0004-electron-cordis-standalone-panel.md) (host, kernel, stacking order), [ADR-0005](/repo://docs/adr/0005-no-input-hooks-dataplane-utility-process.md) (the process split), [ADR-0002](/repo://docs/adr/0002-no-window-titles-in-usage-log.md) (no window titles in the usage log) and [ADR-0003](/repo://docs/adr/0003-multi-tool-unified-session-model.md) (the unified session model) are the live ones; ADR-0001 and the service-window ADR are superseded.

## Where to go next

The hierarchy behind this map, in the order it is usually read:

- Orientation: [system overview](/openwiki/architecture/overview.md), [domain model](/openwiki/concepts/domain-model.md).
- Topology and plumbing: [process lifecycle and windowing](/openwiki/architecture/process-lifecycle-and-windowing.md), [cordis kernel and services](/openwiki/architecture/cordis-kernel-and-services.md), [bridge contract and IPC](/openwiki/architecture/bridge-contract-and-ipc.md), [data plane subprocess](/openwiki/architecture/data-service.md).
- Producers: [agent session collection](/openwiki/architecture/agent-session-collection.md), [hardware telemetry](/openwiki/architecture/hardware-telemetry.md), [usage telemetry and recommendation](/openwiki/architecture/usage-telemetry-and-recommendation.md).
- The desktop the panel draws: [zones planning](/openwiki/architecture/desktop-zones-planning.md), [carry runtime](/openwiki/architecture/desktop-zones-execution.md), [renderer panel](/openwiki/architecture/renderer-panel.md), [plugin host](/openwiki/architecture/plugin-host.md).
- The machine around it: [icon carry and autostart](/openwiki/architecture/desktop-icon-carry-and-autostart.md), [Windows APIs](/openwiki/integrations/windows-shell-and-system-apis.md), [privacy and data boundaries](/openwiki/concepts/privacy-and-data-boundaries.md).
<!-- openwiki: broken internal link [/openwiki/operations/configuration-reference.md] file "/openwiki/operations/configuration-reference.md" does not exist. Fix the href or restore the target, then delete this comment. -->
- Operating and verifying: [build and run](/openwiki/operations/build-and-run.md), [configuration](/openwiki/operations/configuration-reference.md), [recovery](/openwiki/operations/recovery-and-diagnostics.md), [testing strategy](/openwiki/testing/testing-strategy.md), [acceptance battery](/openwiki/testing/acceptance-battery.md).
