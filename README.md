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
| `~/.config/rpiv-advisor/advisor.json` | `disabledForModels` | which executor models the advisor refuses to escalate from |

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

The advisor and compressor models are **not** in `advisor.json`. They are the
`rpiv-advisor` / `rpiv-compressor` entries in `subagents.json`'s
`agentOverrides`, so `/subagents` is the only writer and `/advisor` only reports
what resolved — one store cannot disagree with itself, which two files plus a
precedence rule or a sync step eventually do. `install.sh` migrates any legacy
`modelKey` / `compressorModelKey` / `effort` / `compressorEffort` from
`advisor.json` into those entries once (never overwriting a value `/subagents`
already set), then deletes them; what remains in `advisor.json` is `guidance`
(shared) and `disabledForModels` (machine-owned).

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
  pi-smart-compaction/config.json -> ~/.config/pi-smart-compaction/config.json  (15% floor)
  rpiv-advisor/advisor.json       SEEDED   guidance shared, models local
  rpiv-advisor/advisor.machine.example.json
dot-agents/
  skills/find-skills/             -> ~/.agents/skills/find-skills   (symlinked)
plugins/                          -> ~/.pi/agent/plugins   (git submodules)
  pi-subagents/  pi-advisor-subagent/  pi-todo/  pi-smart-compaction/
pi-bolt/                          -> ~/.pi/agent/pi-bolt-bundles
  rebuild.sh / rebuild.mjs        the staleness check and bundle rebuild driver
  lib/bundle-info.mjs             fingerprint + build-info writer + shim snippet
  compile-exclude.txt             extensions `pi-bolt compile` must leave out
  after-update.sh                 re-syncs deps, bundles and the compile set
  deps-audit.sh                   pins undici, then `npm audit fix`, in both trees
  pi-swap.sh                      the reversible `pi` -> pi-bolt switch
  pi-bolt-subagents/  pi-bolt-web-access/  pi-bolt-advisor-subagent/
```

`settings.json` refers to the forks as `plugins/<name>`, which pi resolves
relative to `~/.pi/agent`; the `~/.pi/agent/plugins` symlink makes that path
clone-location-independent. `plugins/pi-codex-goal` is a vendored upstream
release with a one-row goal footer; see its [customization notes](plugins/pi-codex-goal/PI-CONFIG.md).
The installer replaces the old npm package entry on existing machines, preserving
its resource filters. Restart Pi or run `/reload` after installing; a Pi-Bolt
recompile can restore compiled-extension startup speed.

## Install on another machine

```sh
git clone --recurse-submodules git@github.com:nplez1/pi-config.git ~/Code/pi-config
~/Code/pi-config/install.sh
```

`install.sh` also provisions Pi-Bolt (see [pi-bolt/README.md](pi-bolt/README.md)):
it installs it from the official installer if it is missing, materializes the
`packages` list, rebuilds the three bundles from this clone, compiles every
installed extension into the executable except those named in
`pi-bolt/compile-exclude.txt`, pins a patched `undici` in both npm trees, and swaps
`pi` to run pi-bolt — and the `pi` shim it installs repeats that maintenance after
every `pi update`, so nobody has to remember it (pi-bolt/README.md,
"Keeping up to date").
Every step prints a SKIP instead of failing the install; `PI_CONFIG_SKIP_PIBOLT=1`
leaves Pi-Bolt out entirely. `pi-real` (or `PI_REAL=1 pi`) still reaches the stock
launcher, and `pi-bolt/pi-swap.sh remove` reverts the swap.

The fast-search extension uses `fd` and `rg` behind the existing `find` and
`grep` tools. `install.sh` installs missing commands with Homebrew (`fd` and
`ripgrep`) when available; if Homebrew is unavailable or installation fails,
install them separately and search falls back to native until they are on
`PATH`. It never installs Homebrew itself; set `PI_CONFIG_SKIP_BREW=1` to
skip this step. See
[`fast-search/README.md`](dot-pi/agent/extensions/fast-search/README.md) for
compatibility limits, tests and rollback.

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

## GitHub Copilot Fusion Standard

`extensions/copilot-fusion.ts` adds **`copilot-fusion/standard`**. Select it in
`/model` or start Pi with `--model copilot-fusion/standard`; keep your existing
`github-copilot` login. Pi runs its own tools and streams the model GitHub
selects, with the Fusion routing token passed only in that request's headers.
The token is kept in memory, never saved in Pi's session or model catalog.

If `enabledModels` is configured, add `copilot-fusion/standard` to that
machine-owned list. The physical `github-copilot` models Fusion may select must
also be in the active scope. A missing, disabled, or unsupported selected model
fails explicitly; the extension never substitutes a different model or routes
through a proxy. The picker entry is available only when GitHub Copilot is
configured; it reuses Pi's Copilot credentials rather than storing another login.

GitHub currently advertises a [30% Fusion discount for paid plans through
November 30, 2026](https://docs.github.com/copilot/concepts/models/copilot-fusion).
Actual billing is determined by GitHub and account policy. Pi's displayed dollar
estimate is not a Copilot AI-credit receipt; check GitHub's usage and billing.
The extension uses GitHub's client routing protocol, which may change. It exposes
Standard only; High and Max require multi-model orchestration and are not
implemented here. Before the first Fusion response, Pi may display the previous
model's window or a conservative scope-based hint; afterward it displays the
selected physical model's total context window. GitHub may enforce a smaller
prompt-input limit, which is used for compaction when supplied by the router.
The selected model's output limit is used for requests.

Pi can check compaction before Fusion selects a model. The extension cancels
those pre-route checks, then Pi performs **automatic threshold and overflow
compaction** against the chosen model. This avoids shrinking context based on a
previous or merely possible model. The `pi-smart-compaction` plugin skips its
idle-resume compaction for Fusion because that runs before routing; explicit
`/compact` and `/smart-compaction force` remain available.

Run the isolated tests with:

```sh
bun test dot-pi/agent/extensions/shared/copilot-fusion-*.test.ts
python3 tests/fusion_auth_test.py
python3 tests/fusion_compaction_test.py
(cd plugins/pi-smart-compaction && npm test)
```

## DeepSeek peak/off-peak routing

DeepSeek bills two tiers by wall clock (peak = 2x off-peak: 01:00-04:00 and
06:00-10:00 UTC, Mon-Fri). `extensions/deepseek-routing.ts` registers a virtual
model, **`deepseek/deepseek-flash-auto`**, that sends each request to whichever
provider for DeepSeek-V4.1-Flash-1017 is cheaper at that moment:

| | DeepSeek direct | DeepInfra |
| --- | --- | --- |
| off-peak | $0.15 / $0.60 / $0.003 (in/out/cache-read) | same model, flat rate |
| peak | $0.30 / $1.20 / $0.006 | flat rate |

**How "cheaper" is decided.** Not axis by axis — the three prices are not
remotely equally important. A long agent session replays its whole history every
turn, so on this machine **99.4% of every prompt token is a cache read**, and
the measured split of a turn's tokens is:

| axis | share of tokens | share of spend, DeepSeek off-peak |
| --- | --- | --- |
| input (cache miss) | 0.35% | 10% |
| cache read (cache hit) | 99.4% | 59% |
| output | 0.27% | 31% |

Cache reads are therefore both the heaviest axis and the one the two cards
differ most on — DeepInfra's list price is 2x DeepSeek's off-peak there, 1.33x
on input and exactly equal on output — so the decision is essentially a
cache-read comparison. `TOKEN_MIX` in the shared module holds that measurement
and `cheaperOnMyMix` compares the two cards at it, after scaling DeepInfra's
input axis by `DEEPINFRA_INPUT_MULTIPLIER` (1.87) for the cache misses it
re-reads that DeepSeek does not. Blended over a billion tokens of this usage:

| | DeepSeek | DeepInfra list | DeepInfra @51% |
| --- | --- | --- | --- |
| off-peak | $5.09 | $8.84 | $4.33 |
| peak | $10.18 | $8.84 | $4.33 |

The old rule required DeepInfra to beat DeepSeek on *all three* axes. That test
is never wrong, just far too conservative: it demands a 50% discount where this
mix's break-even is **42%** (38% without the cache-miss penalty). At 51% the
promo wins at every hour; at 30% — what DeepInfra's un-suffixed
`DeepSeek-V4.1-Flash` lists — it loses off-peak and wins at peak.

**No tier is hardcoded, and no price is assumed.** The peak branch runs the same
comparison as the off-peak one, against DeepSeek's peak card instead of its
off-peak card, so a DeepInfra price above DeepSeek's peak price sends peak back
to DeepSeek with no code change. The extension is seeded with DeepInfra's *list*
price, never with the current promo, and `route()` awaits the live fetch before
deciding — so a session whose fetch fails routes conservatively on list price
instead of on an assumed discount. (`PI_DEEPSEEK_TIER` still forces a tier for
testing, and the footer label shows which side the comparison picked, not what a
DeepSeek-only machine would end up using.)

- DeepInfra publishes its rates publicly at `/v1/openai/models`, so the extension
  refetches them each session and re-registers the model's cost — the footer's
  dollar figure tracks the real billed rate, promos included. `models.json`
  deliberately has no `deepinfra` entry: an override there would freeze the
  price at whatever was true when the file was written.
- `TOKEN_MIX` is a measurement, not a guess. Re-derive it with
  `node dot-pi/agent/extensions/shared/measure-token-mix.mjs` (add
  `--provider deepinfra` for the cache-efficiency figure behind the multiplier),
  and `bun test dot-pi/agent/extensions/shared/` pins the arithmetic — including
  the break-even discount — so a drifted constant fails instead of quietly
  flipping the router.
- Provider choice is per turn, not per request: tool follow-ups stay where the
  turn started, so only crossing a peak boundary costs a prompt-cache miss. A
  retry after a provider-side error (5xx, 429, overload, network) crosses to the
  other side once, then the next user message returns to the clock/price choice.
- Both sides are in `enabledModels`, `defaultModel` is the router, and
  `model-roles.json` `workhorse` points at it, so sessions, subagents and
  workflows all route.

**Where it shows up.** The router is a model, not a proxy: nothing else is
redirected, and selecting `deepseek/deepseek-flash` or the `deepinfra` model
directly pins that provider. It is registered under the `deepseek` provider, so
it exists only on a machine logged into DeepSeek — without that credential it
never appears in `/model` and no routing code runs, so a work machine that has
neither provider stays untouched. It routes to DeepInfra only when DeepInfra
also has a credential; a DeepSeek-only machine stays on DeepSeek instead of
failing (`modelRegistry.find()` returns credential-less models, so the router
checks `getAvailable()` first). Without a DeepInfra key pi hides that provider
entirely. `getAvailable()` is a *cache* pi refreshes asynchronously, so it
decides the preferred side and nothing more: when it omits both sides — or comes
back empty — the router confirms against the catalog and notes it once on stderr,
because `route()` throwing ends the request with an error pi does not retry and —
every request going through the router — would keep ending it until pi was
restarted. It cannot rescue the case where pi's own credential snapshot is what
went stale: `hasConfiguredAuth()` reads the same snapshot, pi refuses every
route, and the router says so instead of blaming a key that is probably fine.

The schedule and rate card live in
`extensions/shared/deepseek-schedule.ts`, shared with `deepseek-pricing.ts` so
the footer tier and the provider choice cannot disagree. `PI_DEEPSEEK_TIER=peak`
(or `off-peak`) forces a tier without editing code, for testing outside the UTC
windows.

Setup per machine: the **DeepInfra key must go in `~/.pi/agent/auth.json`** as
provider `deepinfra` (it is not tracked, and `models.json` holds no key):

```json
"deepinfra": { "type": "api_key", "key": "sk-di-REPLACE_ME" }
```

Known gap: DeepSeek's docs also make Chinese public holidays off-peak all day;
`DEEPSEEK_HOLIDAYS` in the shared module is empty, so a holiday is treated as a
normal weekday (it over-routes to DeepInfra for that day rather than mis-pricing).

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
