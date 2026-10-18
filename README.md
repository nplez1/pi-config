# pi-config

My [pi](https://pi.dev) agent configuration — model providers, custom subagents
and extensions, skills, and package settings — so another machine can be set up
with one clone.

> **This repository is public.** It is sanitized, but treat it as public: never
> commit `auth.json`, API keys, session transcripts, or private notes. CI runs
> [gitleaks](.github/workflows/secret-scan.yml) on every push, and every file
> here was scanned before the first commit.

## Machines with different accounts

Accounts differ per machine (this one uses DeepSeek/Xiaomi/Fireworks; another
uses GitHub Copilot Enterprise), and pi writes the chosen model back into
`settings.json`. So account-specific values are **machine-owned**, not shared:

| Machine-owned (seeded once, kept local) | Key | Why |
| --- | --- | --- |
| `~/.pi/agent/settings.json` | `defaultProvider`, `defaultModel`, `enabledModels` | which providers/models this machine actually has |
| `~/.config/rpiv-advisor/advisor.json` | `modelKey`, `compressorModelKey` | the advisor model this machine can reach |

Everything else — the plugin/package list, theme, tui mode, subagent
definitions, extensions, skills, `models.json`, todo/advisor **guidance** — is
shared and symlinked, so editing it edits this repo.

`install.sh` **seeds** the two machine-owned files (copy only if absent) instead
of symlinking them, so a `/model` change on one machine can never rewrite the
other's config. When you change something *shared* inside those two files, run:

```sh
~/Code/pi-config/install.sh capture   # copies them back, stripping account keys
git -C ~/Code/pi-config diff
```

`capture` always deletes the account keys listed above before writing the seed,
so they cannot leak into the repo.

## Layout

The tree mirrors `$HOME`; a `dot-X/` directory maps to `~/.X/`.

```
dot-pi/
  web-search.json                 -> ~/.pi/web-search.json
  agent/
    settings.json                 SEEDED   packages, piBolt overrides, codemode, theme
    settings.machine.example.json example of the account keys (not installed)
    pi-system-one.json            SEEDED   /so mode; seeded because /so config rewrites it
    models.json                   -> ~/.pi/agent/models.json   (keys via ${VAR})
    AGENTS.md                     -> ~/.pi/agent/AGENTS.md
    subagents.json                -> ~/.pi/agent/subagents.json
    auth.json.example             template only — auth.json is NOT tracked
    agents/                       -> ~/.pi/agent/agents/
    extensions/                   -> ~/.pi/agent/extensions/    (per file)
dot-config/
  rpiv-todo/config.json           -> ~/.config/rpiv-todo/config.json
  rpiv-advisor/advisor.json       SEEDED   guidance shared, models local
  rpiv-advisor/advisor.machine.example.json
dot-agents/
  skills/find-skills/             -> ~/.agents/skills/find-skills   (symlinked)
plugins/                          -> ~/.pi/agent/plugins   (git submodules)
  pi-subagents/  pi-advisor-subagent/  pi-todo/
pi-bolt/                          -> ~/.pi/agent/pi-bolt-bundles
  rebuild.sh / rebuild.mjs        the staleness check and bundle rebuild driver
  lib/bundle-info.mjs             fingerprint + build-info writer + shim snippet
  compile-set.txt                 extensions `pi-bolt compile --only` bakes in
  pi-swap.sh                      the reversible `pi` -> pi-bolt switch
  pi-bolt-subagents/  pi-bolt-web-access/  pi-bolt-advisor-subagent/
```

`settings.json` refers to the forks as `plugins/<name>`, which pi resolves
relative to `~/.pi/agent`; the `~/.pi/agent/plugins` symlink makes that path
clone-location-independent.

## Install on another machine

```sh
git clone --recurse-submodules git@github.com:nplez1/pi-config.git ~/Code/pi-config
~/Code/pi-config/install.sh
```

`install.sh` also provisions Pi-Bolt (see [pi-bolt/README.md](pi-bolt/README.md)):
it installs it from the official installer if it is missing, materializes the
`packages` list, rebuilds the three bundles from this clone, compiles
`pi-bolt/compile-set.txt` into the executable, and swaps `pi` to run pi-bolt.
Every step prints a SKIP instead of failing the install; `PI_CONFIG_SKIP_PIBOLT=1`
leaves Pi-Bolt out entirely. `pi-real` (or `PI_REAL=1 pi`) still reaches the stock
launcher, and `pi-bolt/pi-swap.sh remove` reverts the swap.

Then: `export` any env var `models.json` references (e.g. `OMLX_API_KEY`), run
`pi` and `/login` for the providers that machine has, and pick a default model
with `/model`. Restart pi; `pi list` should show the three plugins, and
`pi-bolt compile --status` the compiled set.

`install.sh` is idempotent, moves any file it would replace into
`~/.pi-config-backups/<timestamp>/` (flattened, deliberately **not** next to the
target — a `<name>.pre-pi-config-*` sibling inside `~/.agents/skills` or
`~/.pi/agent/agents` gets re-discovered by the glob as a duplicate skill or
agent), never touches a whole directory that can
hold untracked user files (e.g. `~/.pi/agent/extensions`, which also has Orca
extensions not in this repo), and supports `--dry-run` and `uninstall`.

## Intentionally not tracked

| Excluded | Why |
| --- | --- |
| `~/.pi/agent/auth.json` | live provider keys and OAuth tokens |
| `models.json` `apiKey` values | replaced with `${OMLX_API_KEY}` |
| `~/.pi/agent/sessions/` | private conversation transcripts (~1 GB) |
| `~/.pi/agent/npm/`, `models-store.json`, `web-search-cache/` | caches |
| `~/.pi/agent/bin/{fd,rg}` | platform-specific binaries |
| `~/.pi/agent/trust.json`, `run-history.jsonl` | machine-local state |
| `~/.pi/agent/reports/` | generated analyses of my own sessions |
| Orca-specific extensions (`orca-*.ts`) | deliberately not shared |
| Orca-managed skills (`orca-cli`, `orchestration`, `computer-use`) | installed and updated locally by Orca, so transferring them would fight that |
| `pi-bolt/*/dist-bun/`, `pi-bolt/*/build-info.json` | bundle build output; each machine rebuilds it from this clone |
| `pi-bolt/.pi-swap-state` | records what `~/.local/bin/pi` was before the swap |
| `~/.pi-bolt/` | the Pi-Bolt executable and compile cache; installed per machine |
| `~/.agents/.skill-lock.json` | per-machine install state (it lists what *this* machine has installed) |
