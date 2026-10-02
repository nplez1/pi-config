# pi-config

My [pi](https://pi.dev) agent configuration — model providers, custom subagents
and extensions, skills, and package settings — so a second machine can be set up
with one clone.

> **This repository is public.** It is sanitized, but treat it as public: never
> commit `auth.json`, API keys, session transcripts, or private notes. CI runs
> [gitleaks](.github/workflows/secret-scan.yml) on every push, and every file
> here was scanned before the first commit.

## Layout

The tree mirrors `$HOME`; a `dot-X/` directory maps to `~/.X/`. `install.sh`
symlinks each tracked file into place.

```
dot-pi/
  web-search.json                 -> ~/.pi/web-search.json
  agent/
    settings.json                 -> ~/.pi/agent/settings.json      (packages, theme, models, tui)
    models.json                   -> ~/.pi/agent/models.json        (custom providers; keys via $VAR)
    AGENTS.md                     -> ~/.pi/agent/AGENTS.md          (personal directives)
    subagents.json                -> ~/.pi/agent/subagents.json
    auth.json.example             (template only — the real auth.json is NOT tracked)
    agents/                       -> ~/.pi/agent/agents/             (custom subagent definitions)
    extensions/                   -> ~/.pi/agent/extensions/         (per-file: model/footer/pricing helpers)
dot-config/
  rpiv-todo/config.json           -> ~/.config/rpiv-todo/config.json
  rpiv-advisor/advisor.json       -> ~/.config/rpiv-advisor/advisor.json
dot-agents/
  .skill-lock.json                -> ~/.agents/.skill-lock.json
  skills/<name>/SKILL.md          -> ~/.agents/skills/<name>/SKILL.md
plugins/                          -> ~/.pi/agent/plugins  (git submodules)
  pi-subagents/                   local fork (fleet view, viewer, workflows)
  pi-advisor-subagent/            local fork (advisor runs as a visible agent)
  pi-todo/                        local fork (cumulative Todos heading)
```

`settings.json` references the forks as `plugins/<name>`, which pi resolves
relative to `~/.pi/agent`. The `~/.pi/agent/plugins` symlink makes that path
clone-location-independent.

## Install on a second machine

```sh
git clone --recurse-submodules git@github.com:nplez1/pi-config.git ~/Code/pi-config
~/Code/pi-config/install.sh
```

`install.sh` links each file, initializes the submodules, and runs `npm install`
inside each plugin. It never deletes: an existing real file is moved to
`<file>.pre-pi-config-<timestamp>`. `./install.sh --dry-run` previews, and
`./install.sh uninstall` removes the symlinks and restores the newest backup.

Then bring credentials (none are in this repo):

1. `export OMLX_API_KEY=…` for any provider `models.json` references as `${VAR}`
   (the `omlx` provider reads it; its `baseUrl` also points at a home-LAN server,
   so edit that if you are not on the same network).
2. Run `pi` and use `/login` for `deepseek`, `fireworks`, `xiaomi`, and
   `github-copilot`; or copy a private `auth.json` to `~/.pi/agent/auth.json`.
3. Restart pi, then `pi list` — the three plugins should appear.

## Making changes

Because the files are **symlinked**, editing `~/.pi/agent/settings.json` (or
letting pi rewrite it) edits this repo's working tree directly:

```sh
git -C ~/Code/pi-config status
git -C ~/Code/pi-config commit -am "…"
git -C ~/Code/pi-config push
```

One caveat: `pi install <path>` rewrites package entries relative to
`~/.pi/agent`, which produces a machine-specific path. For the three plugins,
keep the `plugins/<name>` form by hand.

To add a new tracked file, drop it under the right `dot-X/` directory, add its
mapping to `targets()` in `install.sh`, and re-run `./install.sh`.

## Intentionally not tracked

| Excluded | Why |
| --- | --- |
| `~/.pi/agent/auth.json` | live provider keys and OAuth tokens |
| `~/.pi/agent/models.json` `apiKey` values | replaced with `${OMLX_API_KEY}` |
| `~/.pi/agent/sessions/` | private conversation transcripts (~1 GB) |
| `~/.pi/agent/npm/`, `models-store.json`, `web-search-cache/` | caches and installed packages |
| `~/.pi/agent/bin/{fd,rg}` | platform-specific binaries |
| `~/.pi/agent/trust.json`, `run-history.jsonl` | machine-local state |
| `~/.pi/agent/reports/` | generated analyses of my own sessions |
| Orca-specific extensions (`orca-*.ts`) | intentionally left out of this repo |
