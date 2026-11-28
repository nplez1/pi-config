# User Directives

## Agent model selection

- **The model IDs are machine-owned — read them, do not assume them.** Before you
  request any model, read `~/.config/pi-config/model-roles.json`: it maps a role to
  this machine's provider/model ID. That file is seeded per machine and never
  shared, so another machine's IDs differ. A `null` or missing role means this
  machine configured no preference: when the spawn carries no explicit model
  request, inherit the session model — that is the configured answer. When I *did*
  ask for that shorthand, a `null` role is not an answer: say the role is unset on
  this machine and ask me which model to use.
- Shorthand → role: **Explore**/**Fast** → `exploration` (`thinking: "low"` for agents; `effort: "low"` for workflows), **Deep**/**Pro** → `heavy` (`thinking: "max"` for agents; `effort: "max"` for workflows), **Opus** → `opus`, **Sonnet** → `sonnet`, **Fable** → `fable`. The last three name the Claude Code CLI backend on the seeding machine (`claude/opus`, `claude/sonnet`, `claude/fable`); a machine without that CLI retargets them in its own file. **Opus is the default for review and planning; Fable is manual-only** — the cost policy below spells that out.
- Those names are shorthand, not model IDs. Pass the explicit provider/model
  ID from the roles file; an agent type's default does not satisfy the request.
- **Precedence:** an explicit model request in my prompt beats an agent type's
  configured default (`agentOverrides` in `subagents.json`), so "Explore/Fast"
  means the roles file's `exploration` ID even when that default is something
  else. A model pinned in an agent's own `.md` frontmatter is authoritative and
  outranks the caller — if a spawn reports a mismatch, stop and tell me rather
  than continuing on the pinned model. A spawn with no model request keeps the
  agent's configuration.
- Never silently substitute another model. If the requested model override is rejected or resolves to a different model, stop, report the mismatch, and ask before using a fallback. Do not rely on a failed or zero-tool agent run as exploration.
- **Review, planning, verification and unblock passes default to Opus.** Any
  automated step whose job is judgment — the agent-driver's planner, the
  adversarial PR reviewer, the unblock pass, an Orca task that says "Opus review"
  or "plan" — runs on the `opus` role at `thinking`/`effort` **high**. That is the
  default whenever I did not name a model; a model I name still wins.
- **Fable is manual-only.** The `fable` role (`claude/fable`) stays fully
  available — role, alias, picker row and docs all keep it — but it is never the
  default for planning, review, unblock or any automated task. Use it only when I
  ask for it by name.

### Resolving IDs

- Resolve pi models from `enabledModels` in `~/.pi/agent/settings.json`; `models-store.json` holds the full registry. Never invent an ID.
- **`claude/*` is the exception: it is deliberately NOT in `enabledModels`.** It names the Claude Code CLI backend rather than a model pi serves, so it never appears in the model picker or the allowlist. It IS valid everywhere a *subagent* or *workflow* model is given — agent frontmatter `model:`, the `Agent` tool's `model` parameter, `subagents.json` overrides, and workflow steps. Use it there without adding it to `enabledModels`, and never as the *session* model (pi's own session machinery needs a registry model).
- **Never pass** a bare name (`sonnet`), a shorthand (`Opus`), an empty string, or a doubled provider prefix (`fireworks/accounts/fireworks/models/...`).
- **Never request `deepseek/deepseek-v4-pro`.** It is disabled by policy on every machine this config seeds: dropped from `enabledModels` on 2026-10-15 because orchestrators kept reading the workhorse glob and pinning general-purpose agents to it unprompted. Never as a session model, an `Agent`/`SubagentWorkflow` model, an agent frontmatter pin, or a `subagents.json` default. A machine can disable more models by listing them under `never` in the roles file — treat that list the same way, and if a prompt asks for a disabled model, say it is disabled and stop.
- If a requested model is not enabled, say so and stop. Do not pick a lookalike.

### Cost policy — `claude/*` is the expensive tier

- Treat every `claude/*` model as expensive: it bills my Claude subscription, so ration it deliberately.
- **Workhorse** (exploration, implementation, mechanical edits): every ID in `workhorse` and `exploration`. Named exactly as the roles file writes it, never as a provider glob (`xiaomi/*`, `deepseek/*`) — the globs also cover the more expensive pro tiers, which is what put v4-pro into subagent spawns.
- **Expensive, planning and review only**: the `opus`, `sonnet` and `fable` roles (the Claude Code backend by default). **Review, planning, verification and unblock work defaults to `opus` at `thinking`/`effort` high** — that tier is where the judgment lives. `sonnet` is the cheaper expensive tier for work that does not need Opus. `fable` is **manual-only**: kept available for when I ask for it by name, never a default for planning, review, unblock or any automated task.

## Bash tool timeouts — the unit is seconds

- **`timeout` is in seconds.** The harness computes `timeout * 1000` internally, so `timeout: 120000` is ~33 hours, not two minutes. Never pass a millisecond-scale number: values up to ~24.8 days are accepted silently, so a wrong unit produces no error — it just means the command has no real deadline and can hang the session.
- **There is no default timeout.** Omitting `timeout` means the command runs until it finishes; an explicit value is how you get a deadline at all.
- **A detached job never notifies.** `... &` (or `nohup`) hands the process to the shell and ends the question: no completion message exists for a bash job, so a turn that starts one and stops is never woken. Measured on a 2026-11-24 release session: 4 hours of dead wall clock between the turn that backgrounded `gh run watch`/`gate-unit` and the user returning. Only an `Agent` self-delivers a notification; anything else must be held in the turn with a sized `timeout`, or polled by a bounded `while kill -0` loop inside one call.
- **Size it to the command, not to a habit.** ~30 for a grep or a file read, 60 for git or package work, 120–300 for one test file or a typecheck, 900–1800 for a full suite or a cold build. A timeout that fires is a cheap, informative failure; an effectively unbounded one hides the problem and wastes wall-clock.
- **A long run blocks once; it is never polled.** Run it in the foreground with the literal sized to it — `orca-queue pnpm test > "$log" 2>&1; tail -n 120 "$log"` at `timeout: 1800`. If it genuinely must detach, wait in **one** call: `while kill -0 "$pid" 2>/dev/null; do sleep 20; done; tail -n 120 "$log"`. Never issue `sleep N; tail log` as separate turns — each poll re-processes the whole conversation to learn nothing, and a 300 s quantum overshoots the run's real end. Never call `get_subagent_result` to wait; background agents notify on completion.
- **Above ~1800, background it deliberately** and hand back the log path, rather than raising the literal to an unbounded number. A long run is not a reason for a missing deadline.
- **Other Pi tools use other units** (`mcp` timeouts are seconds; some RPC-extension dialog timeouts are milliseconds). Read the tool's own schema rather than generalising from this one.

## Tool selection — codemode, not bash scripting

- **Two in a row is the trigger.** The moment your next step is a *second* `read`, `grep`, or `bash` call for the same purpose, stop and write one `codemode` script that does the whole step. Measured over 785 sessions: 1,490 runs of consecutive `read`/`grep` turns holding 5,489 turns, plus 4,154 of 51,640 `bash` calls that ran a python program inline (1,779 via `python3 -c`, 2,375 via heredoc) and 748 more via `node -e`. Every one of those turns re-sends the entire prompt; a single script sends one.
- **Python inside `bash` is banned, not discouraged.** No `python3 -c`, no `python3 - <<'PY'`, no `node -e`, no `jq`/`sed`/`awk` program standing in for logic. If the command needs a loop, a conditional, a parse, or a data structure, it is a `codemode` script. The only exceptions are things the sandbox genuinely cannot do: `pip`/venv work, a real TTY, a process you are deliberately backgrounding, or a tool that must run with real filesystem or network access. 'Quicker to type' is not an exception, and neither is habit.
- **The win is turns, not milliseconds.** From the same transcripts `codemode` averages 207 ms per call against 78 ms for `bash` — a lone command is a wash or a small loss. What pays is collapsing N calls and N prompts into one call. Do not reach for a script to run one command.
- Use `codemode` when:
  - the step touches several files — `Promise.allSettled` over `tools.read` / `tools.grep` / `tools.write`;
  - the answer is a subset of a large result — `tools.bash` returns up to 1 MiB where the `bash` tool shows you 50 KB, so filter in the script and `text()` only what matters;
  - you would otherwise write a script of any kind — see the ban above;
  - you are polling several agents, endpoints or files at once — settle them all, then `text()` one line each;
  - a value is worth keeping across calls — `store`/`load` beats re-deriving it.
- Keep a plain `bash` call when it really is one command: `git status`, `pnpm tc`, a `curl`, a single file read. A one-command script adds a sandbox and a failure mode for no gain.
- **The sandbox has no Node APIs, filesystem, network or timers.** Reach the outside world through `tools.*` only. A failing call rejects, so wrap independent calls in `Promise.allSettled` and report what settled rather than letting one rejection discard the batch.
- **The Claude Code backend has this too, when its rollout allows it.** `pi-subagents` reads `CLAUDE_CODE_EXPERIMENTAL_CODE_MODE` and re-sends it to `claude -p` through `--settings` — the only surface a headless run honours, since neither the process environment nor `~/.claude/settings.json` reaches it — and grants `REPL` in the tool allowlist, without which a restricted agent cancels the feature. It needs Claude Code 2.1.323+, a 5.5-tier model, and an account Anthropic has enabled; while the gate is shut a `claude/*` run silently uses the ordinary tools, so the instructions above still stand for it.

Working in an Orca worktree (`/Users/nathanp/orca/workspaces/orca/**`)? That repository's `AGENTS.md`
carries the fork/PR/verification workflow rules — read them before touching a branch or opening a PR.
