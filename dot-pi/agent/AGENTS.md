# User Directives

## Agent model selection

- When I request **Luna/Med** for exploration, use `github-copilot/gpt-5.6-luna` with medium reasoning (`thinking: "medium"` for agents; `effort: "medium"` for workflows).
- When I request **Sol/High** for review, use `github-copilot/gpt-6.1-sol` with high reasoning (`thinking: "high"` for agents; `effort: "high"` for workflows).
- When I request **Opus 5.5**, use `github-copilot/claude-opus-5.5`.
- When I request **Sonnet 5.5**, use `github-copilot/claude-sonnet-5.5`.
- Treat every one of those names as shorthand, not a model ID. Always pass the explicit provider/model ID; an agent type's default model does not satisfy this request.
- **Precedence:** an explicit model request in my prompt beats an agent type's pinned model. So "Luna/Med" means `gpt-5.6-luna` even when the agent you spawn is `Explore` — whose own pin is the cheaper `gpt-6-luna`, kept deliberately because GPT-6 Luna is fine for the narrow search and compression jobs. A spawn with no model request keeps the agent's pin.
- Never silently substitute another model. If the requested model override is rejected or resolves to a different model, stop, report the mismatch, and ask before using a fallback. Do not rely on a failed or zero-tool agent run as exploration.

### Resolving IDs

- Resolve every subagent/workflow model from `enabledModels` in `~/.pi/agent/settings.json` before passing it; `models-store.json` holds the full registry. Never invent an ID.
- **Never pass** a bare name (`sonnet`), a shorthand (`Luna/Med`), an empty string, or a doubled provider prefix (`fireworks/accounts/fireworks/models/...`).
- If a requested model is not enabled, say so and stop. Do not pick a lookalike.

### Cost policy — `github-copilot/*` is expensive

- Treat every `github-copilot/*` model as expensive; it bills against a Copilot allowance I ration deliberately.
- **Workhorse** (exploration, implementation, mechanical edits): `deepseek/*`, `xiaomi/mimo-v2.6-*`.
- **Expensive, planning and review only**: `gpt-6-astra`, `claude-opus-5.5`, `claude-sonnet-5.5`, `claude-fable-5.1`, `gpt-6.1-sol`, `kimi-k3`.
- **Cheap copilot exceptions** — do not generalise from these: `gpt-6-luna` for the `Explore` subagent and the advisor compressor, and `gpt-5.6-luna` for exploration and mechanical work because I asked for it.
- Never pay for an advisor escalation to a peer model when the session is already on an expensive one.

Working in an Orca worktree (`/Users/nathanp/orca/workspaces/orca/**`)? That repository's `AGENTS.md`
carries the fork/PR/verification workflow rules — read them before touching a branch or opening a PR.
