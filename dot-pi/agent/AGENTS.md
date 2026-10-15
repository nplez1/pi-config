# User Directives

## Agent model selection

- When I request **Opus** for review, use `claude/opus` (the Claude Code CLI backend).
- When I request **Sonnet**, use `claude/sonnet` (the Claude Code CLI backend).
- When I request **Explore** or **Fast** for exploration, use `xiaomi/mimo-v2.6-flash` (`thinking: "medium"` for agents; `effort: "medium"` for workflows).
- When I request **Deep** or **Pro**, use `xiaomi/mimo-v2.6-pro`.
- Treat every one of those names as shorthand, not a model ID. Always pass the explicit provider/model ID; an agent type's default model does not satisfy this request.
- **Precedence:** an explicit model request in my prompt beats an agent type's pinned model — so "Explore/Fast" means `xiaomi/mimo-v2.6-flash` even when the agent you spawn pins something else. A spawn with no model request keeps the agent's pin.
- Never silently substitute another model. If the requested model override is rejected or resolves to a different model, stop, report the mismatch, and ask before using a fallback. Do not rely on a failed or zero-tool agent run as exploration.

### Resolving IDs

- Resolve pi models from `enabledModels` in `~/.pi/agent/settings.json`; `models-store.json` holds the full registry. Never invent an ID.
- **`claude/*` is the exception: it is deliberately NOT in `enabledModels`.** It names the Claude Code CLI backend rather than a model pi serves, so it never appears in the model picker or the allowlist. It IS valid everywhere a *subagent* or *workflow* model is given — agent frontmatter `model:`, the `Agent` tool's `model` parameter, `subagents.json` overrides, advisor config, and workflow steps. Use it there without adding it to `enabledModels`, and never as the *session* model (pi's own session machinery needs a registry model).
- **Never pass** a bare name (`sonnet`), a shorthand (`Opus`), an empty string, or a doubled provider prefix (`fireworks/accounts/fireworks/models/...`).
- **`deepseek/deepseek-v4-pro` is deliberately not enabled — never request it.** Not as a session model, an `Agent`/`SubagentWorkflow` model, an agent frontmatter pin, or a `subagents.json` default. It was removed from `enabledModels` on 2026-10-15 because orchestrators kept reading the workhorse glob below and pinning general-purpose agents to it unprompted. If a prompt asks for "Deep"/"Pro", use `xiaomi/mimo-v2.6-pro`. If something else asks for v4-pro, say it is disabled and stop.
- If a requested model is not enabled, say so and stop. Do not pick a lookalike.

### Cost policy — `claude/*` is the expensive tier

- Treat every `claude/*` model as expensive: it bills my Claude subscription, so ration it deliberately.
- **Workhorse** (exploration, implementation, mechanical edits): `deepseek/deepseek-flash`, `xiaomi/mimo-v2.6-flash`. Named exactly, never as a `deepseek/*` or `xiaomi/mimo-v2.6-*` glob — the globs also cover the more expensive pro tiers, which is what put v4-pro into subagent spawns.
- **Expensive, planning and review only**: `claude/opus`, `claude/sonnet`.
- Advisor escalations run on the advisor's own configured model; never pay for a peer-model escalation when the session is already on an expensive one.

## Bash tool timeouts — the unit is seconds

- **`timeout` is in seconds.** The harness computes `timeout * 1000` internally, so `timeout: 120000` is ~33 hours, not two minutes. Never pass a millisecond-scale number: values up to ~24.8 days are accepted silently, so a wrong unit produces no error — it just means the command has no real deadline and can hang the session.
- **There is no default timeout.** Omitting `timeout` means the command runs until it finishes; an explicit value is how you get a deadline at all.
- **Size it to the command, not to a habit.** ~30 for a grep or a file read, 60 for git or package work, 120–300 for one test file or a typecheck, 600 for a full suite or a cold build. A timeout that fires is a cheap, informative failure; an effectively unbounded one hides the problem and wastes wall-clock.
- **Above ~600, background it instead of raising the ceiling.** `nohup <cmd> > /tmp/<name>.log 2>&1 &` then poll the log with short commands. A long run is not a reason for a large literal.
- **Other Pi tools use other units** (`mcp` timeouts are seconds; some RPC-extension dialog timeouts are milliseconds). Read the tool's own schema rather than generalising from this one.

Working in an Orca worktree (`/Users/nathanp/orca/workspaces/orca/**`)? That repository's `AGENTS.md`
carries the fork/PR/verification workflow rules — read them before touching a branch or opening a PR.
