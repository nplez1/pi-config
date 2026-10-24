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
| `~/.pi/agent/subagents.json` | `agentOverrides.*.model`, `agentOverrides.*.thinking` | the model each subagent type runs on is an account fact, not a shared one |
| `~/.config/pi-config/model-roles.json` | every ID | the provider IDs `AGENTS.md`'s shorthand (Explore/Fast, Deep/Pro, Opus/Sonnet, workhorse) resolves to |
| `~/.config/rpiv-advisor/advisor.json` | `modelKey`, `compressorModelKey`, `effort`, `compressorEffort`, `disabledForModels` | the advisor model this machine can reach, and the effort it can afford |

Everything else — the plugin/package list, theme, tui mode, agent `.md`
definitions, extensions, skills, `models.json`, todo/advisor **guidance** — is
shared and symlinked, so editing it edits this repo. Which models those agents
run on is deliberately *not* in that list: a work machine on a different account
has to be able to retarget them without editing this repo, which is also why no
plugin here pins a model in its source.

`install.sh` **seeds** the four machine-owned files (copy only if absent) instead
of symlinking them, so a `/subagents` or `/model` change on one machine can never
rewrite the other's config. When you change something *shared* inside those
files, run:

```sh
~/Code/pi-config/install.sh capture   # copies them back, stripping account keys
```

`capture` always deletes the account keys listed above before writing the seed,
so they cannot leak into the repo. The shared keys travel back the other way
too: `install.sh` additively syncs them into an existing machine-owned file
(missing top-level keys, new `packages` entries, new `enabled` flags), so a seed
edit reaches a machine that has already run the install — while never touching a
model choice that machine made locally.

### Upgrading a machine that seeded before models moved

`subagents.json` used to be symlinked, so on an older machine its per-agent models
lived in this repo and the live file *was* the seed. Pulling this change strips
them from the seed, and the symlink shows the stripped version immediately —
before `install.sh` ever runs. Nothing is migrated automatically, so copy the file
out first if you want its values:

```sh
cp -L ~/.pi/agent/subagents.json /tmp/subagents.before.json   # before pulling
# /subagents wrote through the symlink, so models chosen there are *uncommitted
# edits in this repo* and will block the pull. They are saved above — discard:
git -C ~/Code/pi-config checkout -- dot-pi/agent/subagents.json
git -C ~/Code/pi-config pull
~/Code/pi-config/install.sh        # converts the symlink to a machine-owned copy
# then merge your models back, or set them through /subagents
```

Already pulled? The old content is still in history:
`git -C ~/Code/pi-config log -p -- dot-pi/agent/subagents.json`.

Models chosen through `/subagents` were stored in that same shared file, so they
need the same re-apply, and the provider IDs belong in
`~/.config/pi-config/model-roles.json` (see
`dot-config/pi-config/model-roles.machine.example.json`). The advisor config was
already seeded, so its `modelKey`/`effort` stay as that machine has them.

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
    subagents.json                SEEDED   agent enable flags; per-agent models local
    subagents.machine.example.json example of the per-agent model overrides
    auth.json.example             template only — auth.json is NOT tracked
    agents/                       -> ~/.pi/agent/agents/
    extensions/                   -> ~/.pi/agent/extensions/    (per file)
dot-config/
  pi-config/model-roles.json      SEEDED   which ID each AGENTS.md role means
  pi-config/model-roles.machine.example.json
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
  compile-exclude.txt             extensions `pi-bolt compile` must leave out
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
`packages` list, rebuilds the three bundles from this clone, compiles every
installed extension into the executable except those named in
`pi-bolt/compile-exclude.txt`, pins a patched `undici` in the extensions project,
and swaps `pi` to run pi-bolt.
Every step prints a SKIP instead of failing the install; `PI_CONFIG_SKIP_PIBOLT=1`
leaves Pi-Bolt out entirely. `pi-real` (or `PI_REAL=1 pi`) still reaches the stock
launcher, and `pi-bolt/pi-swap.sh remove` reverts the swap.

Re-running it is safe and additive, whether the machine already has pi or ran an
older version of this script: files it would replace are backed up, machine-owned
keys (`defaultProvider`, `defaultModel`, `enabledModels`) are never overwritten,
missing shared keys (codemode, the `piBolt` overrides, the pinned packages) are
added, and a Pi-Bolt with a different compile set keeps the extensions it already
had compiled in.

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
