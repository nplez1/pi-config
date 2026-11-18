# Plugin fork ↔ upstream audit (2026-11-18)

> **Status:** `pi-todo` and `pi-codex-goal` were synced on 2026-11-18 and
> reviewed (`pi-todo` → 2.15.0, `pi-codex-goal` → 0.7.10). `pi-subagents`, the
> tiered port below, is **not started**; `pi-advisor`, `pi-vcc` and
> `pi-smart-compaction` need nothing.

Scope: every plugin this repo ships as a fork, compared against its upstream as
of today. Host pi is `1.5.2`; all upstream floors below are satisfied.

| plugin | fork point | upstream now | drift | verdict |
|---|---|---|---|---|
| `pi-subagents` | 0.19.0 (2026-09-14) | 0.26.1 + Unreleased (2026-11-18) | **381 commits**, ~7.5k src lines | highest value, highest cost — tiered port |
| `pi-todo` | `@juicesharp/rpiv-todo` 2.12.0 | 2.15.0 + Unreleased | 3 minors | **do it**: real bug fixes, our patch still applies |
| `pi-codex-goal` | upstream history preserved | 0.7.10 + Unreleased | 8 commits, 1 substantive | small, take the one commit |
| `pi-advisor-subagent` | `@juicesharp/rpiv-advisor` ~2.12.0 | 2.15.0 | 3 minors | mostly **not applicable** to our architecture |
| `pi-vcc` | `sting8k/pi-vcc` 0.11.2 | 0.11.2 (2026-10-29) | 0 (only FORK.md) | nothing to merge |
| `pi-smart-compaction` | — ours, no upstream | — | — | n/a |

Re-check commands are in each `plugins/*/FORK.md`.

---

## 1. pi-todo — done (2.15.0)

Our fork is upstream 2.12.0 + one 10-line patch (`todo-overlay.ts`, counts over
the whole list). Upstream 2.12.0 → 2.15.0 changed `todo-overlay.ts` **only in its
import lines** (`.js` → `.ts`), so the patch reapplies verbatim; the whole
re-sync is "take the upstream tree, replay the counts hunk, bump the pin".

What we gain (all verified present upstream, absent here):

- **2.13.5 — `todo` calls made through codemode survive resume/reload/compaction.**
  A `ctx.executeTool()` call never becomes a standalone tool result, so replay
  could not see it. Upstream now also persists an `rpiv-todo-state` custom entry.
  We run `+codemode` in `defaultTools`, so this is a live bug for us.
  (`grep rpiv-todo-state plugins/pi-todo` → nothing today.)
- **2.15.0 — replay validates every task**, not just `Array.isArray(v.tasks)`.
  Ours has exactly the vulnerable guard (`state/replay.ts:12`), which upstream
  found crashing the overlay on a snapshot another extension had truncated.
- **2.14.0 — batch create** (`create` with `tasks[]`, all-or-nothing), ninth
  prompt guideline teaching it.
- **2.14.2 — a rejected `todo` call renders `✗`** instead of echoing the
  requested status as success.
- **2.13.9 — `.ts` relative imports** (faster jiti startup, no fallback probing).
- Unreleased: `maxWidgetLines: 0` turns the panel off; click the heading to
  collapse; a *subagent's* start no longer hides the last finished rows; the
  `action` parameter finally has a schema description.

Only local files to keep: `FORK.md`, `tsconfig.json`, `types/rpiv-i18n.d.ts`,
`package-lock.json`.

## 2. pi-subagents — the big one

We forked at 0.19.0 with a manually squashed history (`git merge-base` with
upstream is empty), so "merge upstream" is not available: every upstream change
has to be ported. Our own delta is ~13.6k lines, heavily concentrated in
`src/index.ts` (1.1k), `src/ui/*` (fleet list, conversation viewer, workflow
dialog/menu/card), `src/workflow/{progress,task,worker-source}.ts`,
`src/{settings,model-scope,model-resolver}.ts`, plus an entirely ours
`src/claude-code/` backend (upstream has nothing like it).

Upstream 0.19.0 → 0.26.1 changed `src/index.ts` by 2.2k lines and touched our
rewritten files in every release, so a wholesale merge is not on the table;
surgical ports are. Only 9 of 381 commits touch *no* heavily-rewritten file.

### Tier 1 — correctness, security and live bugs (small, isolated patches)

These are fixes for behaviour our fork has right now:

- **Model-mode `@handle` mentions are broken on pi ≥ 0.86.** Our
  `src/mention-clone.ts:178` still does `session.agent.state.systemPrompt = …`,
  and `state.systemPrompt` is a getter with no setter in pi 1.4/1.5 (verified in
  the installed `pi-coding-agent` bundle), so every mention falls back to a
  direct start with a warning. Upstream 0.20.0 (#384) rebuilt the clone on
  `SessionManager.inMemory(cwd, undefined, entries)` + a `resourceLoader`
  `systemPromptOverride`; `d4aef4a` also stops the `<cwd>` section repeating.
- **Stale pi floor / peer shape.** Our `peerDependencies` still say
  `@earendil-works/pi-* >=0.84.0` and declare `@sinclair/typebox`; upstream 0.20.0
  moved to `>=1.1.0`, `typebox: "*"`, and dropped `@sinclair/typebox` (pi 1.x
  warns about the old shape). devDeps also still pin 0.84.2.
- **A leftover schedule lock freezes pi for 5 s** (#266). Our
  `src/schedule-store.ts` still busy-waits `LOCK_RETRY_MS` then fails; upstream
  reclaims a lock holding our own PID and fails fast otherwise. Self-contained
  file, clean port.
- **`session_shutdown` leaks timers.** Ours disposes the manager but never
  `fleet.dispose()` / group-join timeouts (upstream 0.22.0, #256/#316), so on
  reload the old render interval can fire into the next session.
- **Subagents ignore the parent's thinking level** (#305). Ours resolves
  `explicit > agent file > undefined`, and `undefined` means pi's
  `defaultThinkingLevel`, not the parent session's — so a `max`-thinking session
  spawns agents at whatever the global default is.
- **A resumed agent has no `max_turns` and its counter never moves** (#368).
- **`get_subagent_result` says "not found" ~10 min after an agent finished**
  (#397, #429) — upstream falls back to the session's saved record and stamps a
  `Finished:` line. We do `appendEntry("subagents:record")` but never read it back.
- **Project trust is not inherited** (0.21.0, security): we build subagent
  settings trusted-by-default, so in a project the user declined to trust a
  subagent still loads that project's `.pi` extensions — and MCP servers.
- **Bare `mcp__<server>__<tool>` entries in `tools:` are dropped** as unknown
  built-ins, leaving every MCP tool reachable (#370); Claude Code tool names
  (`Read`, `Glob`, `disallowedTools`) are also silently unusable (#396).
- **Built-in MCP / codemode / tool_search never load in subagents** (0.21.0):
  pi hands them only to its own loader, so `builtin:mcp` in `extensions:`
  matches nothing.

### Tier 2 — features we would actually use

- **`subagents:workflow_started` / `workflow_settled` + `rpc:workflow_get/list`**
  (0.25.0–Unreleased). Upstream now emits workflow runs on the bus and carries
  `result` (untruncated), `args` and `logs`. **This directly unblocks our
  codex-goal fork**: `plugins/pi-codex-goal/src/background-work-events.ts` says
  in its own comment that a workflow "emits nothing at all", so it probes
  `Symbol.for("pi-subagents:manager")` to guess whether work is live. With these
  events that probe can go away.
- **Lifecycle events for nested and workflow agents** (#442) — the same comment
  notes nested children emit nothing. Accepting this needs a filter in
  codex-goal (`parentAgentId`/`workflowId` set = child) so nested agents are not
  double counted. Also carries `structuredJson`, `sessionFile`, `ownUsage`.
- **`notificationPending` + the completion outbox** (#103, #388): a finished
  agent whose message has not been delivered yet reports `hasRunning() === false`,
  which is exactly the window an auto-continue extension (ours) can double-fire in.
- **`agentError(label)` and `<failures>` in workflow notifications** (#439) —
  today a structured `agent()` call that fails just returns `null` with no reason.
- **Strict draft-07 Ajv schema validation** for `agent({ schema })`, so a bad
  schema fails before the agent starts instead of mis-validating.
- **`workflowToolExposure: "skill"`** moves the ~4k-token workflow reference out
  of the tool description into a `/skill:workflow-authoring` file.
- **`maxConcurrentNested` (default 10)** — nested fan-out is currently unbounded,
  but note upstream *refuses* rather than queues.
- **Agents and workflow scripts shipped by a pi package** (`pi.subagents`).
- **Nested agents in FleetView / Running agents**, `ownUsage`, and the
  `/agents → Settings` rewrite (global-file writes, filters, per-row reset).

### Tier 3 — skip, or treat as a rewrite

`src/index.ts` restructuring, the fullscreen conversation observer (#357 — ours
has its own main-UI viewer), the workflow progress/inspector rework (ours has
rounds and a tree inspector), `/agents` settings menus (ours is
`/subagents`-centric and also stores advisor/compressor model roles).

### Behaviour changes to decide on, not just merge

- 0.26.0: "use 10 agents" no longer starts a `SubagentWorkflow` (guideline removed).
- 0.22.0: `smart` join no longer batches a turn's completions; Esc no longer drops a pending one.
- 0.23.0: built-in `Explore` runs on the session model — already settled here
  by `b5c127f`, which drops the pin outright, so upstream's version adds nothing.
- 0.25.0: `general-purpose` may spawn children (depth `maxSubagentDepth`, default 2).

## 3. pi-codex-goal — done (0.7.10)

8 commits behind, 7 ahead; history is preserved so `git merge upstream/main`
works.

- **`9e95295` "Raise the Pi floor to 1.5.2 and use native Pi clipboard and retry
  helpers (#134)"** — the only substantive one. Replaces our 115-line
  hand-rolled `src/clipboard.ts` with pi's lazy-loaded `copyToClipboard` (30
  lines), swaps our hand-maintained `isRetryableTransientError` regex in
  `src/recovery.ts` for pi-ai's `isRetryableAssistantError`, and uses
  `replaceControlCharacters` in `src/format.ts`. No conflict with our
  `isFatalProviderError` layer, which sits on top. Also bumps devDeps to 1.5.2
  (our host is 1.5.2).
- **`4c15223` `engines.node` → `>=24.22.3 <25 || >=26.13.1`** (patched Node
  security releases). Our fork still says `>=24.0.0`.
- The rest is CI/release plumbing (`974e34c`, `c5e2000`, `6e8dc6e`, `34e083f`,
  `aeeeb56`, `25a1941`) — ignore.

## 4. pi-advisor-subagent — nothing worth merging

We forked `rpiv-advisor` ~2.12.0 on 2026-10-02 and rebuilt the review path: the
advice is assembled in `advisor/payload.ts` and run as a *visible pi-subagents
agent* (`advisor/subagent.ts`, `tools: "none"`, no extensions), replacing
upstream's `state.ts` / `pi-compat.ts` / `advisor-ui.ts` with `select.ts`,
`selection.ts`, `render.ts`, `compress.ts`, `claude-code.ts`, `agents/`.

Upstream's 2.13.x–2.15.0 fixes are all symptoms of a path we do not use:

- 2.13.7 strips the executor's tool declarations from the copied context (#295)
  — irrelevant, our reviewer gets `tools: "none"`.
- 2.14.1 sends `advisor-<session id>` for prompt-cache reuse (#263) — our
  reviewer is already a real pi session with its own id, so caching works.
- 2.15.0 retries transient provider errors — a real pi session already retries
  under pi's `retry` policy.

What does carry over: 2.13.9's `.js` → `.ts` imports (startup only). Not worth a
re-sync; if we ever bypass pi-subagents with a direct `completeSimple` call,
these three fixes become mandatory.

## 5. pi-vcc — nothing to do

`upstream/master` is unchanged since the fork (2026-10-29, 0.11.2); our only
commit is `FORK.md`. Keep as-is and re-check when upstream cuts a release.

## 6. pi-smart-compaction — not a fork

All seven commits are ours; no upstream exists. Nothing to track.

---

## Suggested order

1. **pi-todo** — one sitting, verifiable (`npx tsc --noEmit`, overlay + codemode replay smoke), removes two live bugs.
2. **pi-codex-goal** — `git merge upstream/main`, resolve only `package.json`/`src/recovery.ts`.
3. **pi-subagents Tier 1** — 9 small, mostly single-file ports; start with the mention clone (broken today) and the schedule lock, then trust/tool-scoping, then the resume/thinking/`get_subagent_result` trio.
4. **pi-subagents Tier 2** — begin with the workflow bus events, because they also simplify the codex-goal probe; the rest one at a time.
5. **pi-advisor / pi-vcc / pi-smart-compaction** — nothing.

After any of 1–4: `./install.sh` (or `pi-bolt compile`) to rebuild the compiled
bundles, then re-stamp the `FORK.md` "divergence from upstream" section with the
new upstream version.
