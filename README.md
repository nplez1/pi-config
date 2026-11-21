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
| `~/.config/pi-config/model-roles.json` | every ID | the provider IDs `AGENTS.md`'s shorthand (Explore/Fast, Deep/Pro, Opus/Sonnet/Fable, workhorse) resolves to |

Everything else — the plugin/package list, theme, tui mode, agent `.md`
definitions, extensions, skills, `models.json`, todo **guidance** — is
shared and symlinked, so editing it edits this repo. Which models those agents
run on is deliberately *not* in that list: a work machine on a different account
has to be able to retarget them without editing this repo, which is also why no
plugin here pins a model in its source.

### Which model plans and reviews

`AGENTS.md` puts judgment work on the `opus` role — `claude/opus` at
`thinking`/`effort` **high** — because that is where the judgment lives: the
agent-driver's planner, the adversarial PR reviewer, the unblock pass, and any
Orca task that says "Opus review" or "plan". `sonnet` is the cheaper expensive
tier for work that does not need Opus.

`fable` is **manual-only**. The role, the alias, the picker row and the docs all
keep `claude/fable` one request away, but it is never a default for planning,
review, unblock or any automated task — ask for it by name.

`install.sh` **seeds** four files (copy only if absent) instead of symlinking
them — the three above, plus `~/.pi/agent/pi-system-one.json`, which is seeded
because `/so` rewrites its own config — so a `/subagents` or `/model` change on
one machine can never rewrite the other's config. When you change something
*shared* inside those files, run:

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
`dot-config/pi-config/model-roles.machine.example.json`).

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
    agents/                       -> ~/.pi/agent/agents/        (per file, not the directory)
    extensions/                   -> ~/.pi/agent/extensions/    (per file)
dot-config/
  pi-config/model-roles.json      SEEDED   which ID each AGENTS.md role means
  pi-config/model-roles.machine.example.json
  rpiv-todo/config.json           -> ~/.config/rpiv-todo/config.json
  pi-smart-compaction/config.json -> ~/.config/pi-smart-compaction/config.json  (15% floor)
dot-agents/
  skills/find-skills/             -> ~/.agents/skills/find-skills   (symlinked)
plugins/                          -> ~/.pi/agent/plugins   (git submodules)
  pi-subagents/  pi-todo/  pi-smart-compaction/  pi-codex-goal/  pi-vcc/
pi-bolt/                          -> ~/.pi/agent/pi-bolt-bundles
  rebuild.sh / rebuild.mjs        the staleness check and bundle rebuild driver
  lib/bundle-info.mjs             fingerprint + build-info writer + shim snippet
  compile-exclude.txt             extensions `pi-bolt compile` must leave out
  after-update.sh                 re-syncs deps, bundles and the compile set
  after-update.ps1 / .cmd         the Windows half: bundles + the build input
  deps-audit.sh                   pins undici, then `npm audit fix`, in both trees
  pi-swap.sh                      the reversible `pi` -> pi-bolt switch
  pi-bolt-subagents/  pi-bolt-web-access/
```

`settings.json` refers to the forks as `plugins/<name>`, which pi resolves
relative to `~/.pi/agent`; the `~/.pi/agent/plugins` symlink makes that path
clone-location-independent. `agents/` and `extensions/` are linked one entry at
a time rather than as a whole directory, so a local agent or extension added
under `~/.pi/agent` is never moved aside; `install.sh`'s shell glob also skips
dotfiles such as `.glla-subagent-sync.json`, while `install.ps1` links every
entry. Every plugin is a fork under `nplez1/` with its
divergence written down in that repo's `FORK.md`; `plugins/pi-codex-goal` keeps
upstream history so it can be merged rather than re-forked.
The installer replaces the old npm package entry on existing machines, preserving
its resource filters. Restart Pi or run `/reload` after installing; a Pi-Bolt
recompile can restore compiled-extension startup speed.

## Install on another machine

```sh
git clone --recurse-submodules git@github.com:nplez1/pi-config.git ~/Code/pi-config
~/Code/pi-config/install.sh
```

On Windows the same clone is set up by `install.cmd` — see [Windows](#windows).

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
with `/model`. Restart pi; `pi list` should show this repo's packages — under
Pi-Bolt that is the npm entries, `plugins/pi-codex-goal`,
`plugins/pi-smart-compaction`, `plugins/pi-vcc` and the two
`pi-bolt-bundles/…` entries, because `piBolt.packages` swaps `pi-subagents` and
`npm:pi-web-access` for their bundles and `pi-todo`
for `npm:opensec-pi-todo`; stock pi (`PI_CONFIG_SKIP_PIBOLT=1`) lists all six
`plugins/…` forks and no bundles. `pi-bolt compile --status` reports the compiled
set.

`install.sh` is idempotent, moves any file it would replace into
`~/.pi-config-backups/<timestamp>/` (flattened, deliberately **not** next to the
target — a `<name>.pre-pi-config-*` sibling inside `~/.agents/skills` or
`~/.pi/agent/agents` gets re-discovered by the glob as a duplicate skill or
agent), never touches a whole directory that can
hold untracked user files (e.g. `~/.pi/agent/extensions`, which also has Orca
extensions not in this repo), and supports `--dry-run` and `uninstall`.

### Windows

Windows runs this repo through a PowerShell port. Use the `.cmd` wrappers, not
the `.ps1` files: Windows ships with `Set-ExecutionPolicy Restricted`, which
refuses every script, and the wrapper passes a per-process
`-ExecutionPolicy Bypass` — it changes nothing on the machine and needs no
administrator.

```bat
git clone --recurse-submodules https://github.com/nplez1/pi-config.git %USERPROFILE%\Code\pi-config
%USERPROFILE%\Code\pi-config\install.cmd            :: link + seed, plugins, Pi-Bolt, bundles
%USERPROFILE%\Code\pi-config\install.cmd -DryRun    :: print what would happen, change nothing
%USERPROFILE%\Code\pi-config\install.cmd capture    :: publish this machine's settings back
%USERPROFILE%\Code\pi-config\install.cmd uninstall  :: remove the links that point into this repo
```

`install.ps1` mirrors `install.sh` — the same portable/seeded split, the same
machine-owned files, the same `%USERPROFILE%\.pi-config-backups\<stamp>\` for
anything it replaces — and prints each platform difference per target instead of
assuming it:

| step | Unix | Windows |
| --- | --- | --- |
| portable files | symlinks | symlink, else junction (dirs) / hardlink (files), else a copy that says so |
| `fd`, `rg` | Homebrew | `winget` (`sharkdp.fd`, `BurntSushi.ripgrep.MSVC`) |
| Pi-Bolt | `install.sh` | the official Windows installer |
| bundles | `rebuild.sh` from the `~/.zshrc` hook | `after-update.cmd` after `pi update`, and `pi-bolt\rebuild.cmd` by hand |
| `pi` → pi-bolt | `pi-swap.sh` | `pi-bolt\pi-swap.ps1` |

The env vars are the same: `PI_CONFIG_SKIP_PLUGINS`, `PI_CONFIG_SKIP_PIBOLT`,
`PI_CONFIG_SKIP_TOOLS`, `PI_CONFIG_SKIP_BUNDLES`, `PIBOLT_BUN`. Two more are
Windows-only: `PI_CONFIG_LINK_MODE` pins one link tier (`symlink`, `hardlink` or
`copy`), and `PI_SWAP_SKIP_PATH=1` leaves the user `PATH` alone.

The hardlink tier is worth knowing about: it is what a machine without Developer
Mode falls back to for files, and unlike a symlink it shares the repo file's
bytes rather than pointing at it. That survives an in-place edit but not a
replacement — `git checkout`, `git pull` and editors that save by rename all
write a new file — so a pull can turn the live file into a private copy. The
installer says so when it uses that tier, and the next run repairs it by
noticing the link is gone.

**Not ported.** `pi-bolt compile` answers "compiling extensions in is not
available on Windows yet" for every mode, so extensions load from files and the
prebuilt `dist-bun` bundles are the only start-up lever — which is why the bundle
rebuild matters more here than on Unix. The `pi` shim routes `pi update`
through `after-update.cmd`, which is the Windows half of `after-update.sh`: it
restores the `pi-web-access` build input that `npm install` prunes out of the
extension tree, then rebuilds the bundles if they went stale, so a bumped
pi-web-access can neither leave the old code running silently nor leave a bundle
that cannot be rebuilt at all (`update --models` moves no packages and re-syncs
nothing). It is silent when there is nothing to do, reports problems on stderr,
and never changes the update's exit code. Two steps stay Unix-only, and it says so
rather than implying otherwise: `deps-audit.sh` (the `undici` pin, then
`npm audit fix`) is bash, and there is no compile set to re-assert.
`patches/model-picker.mjs` patches the pi bundle Windows never installs, so the
model-picker guard reports "nothing to patch" rather than an error. Run
`pi-bolt\rebuild.cmd` after a pull or a submodule bump, or
`pi-bolt\after-update.cmd` to reconcile both halves: `-Check` exits 1 when
something is out of step and changes nothing, `-Verbose` prints every verdict.

**The `pi` swap.** `pi-swap.ps1 apply` puts `%USERPROFILE%\.pi\agent\bin` on the
user `PATH` (broadcasting the change, so Explorer and what it launches see it
without a logoff) and writes the shim there **twice**, because the shells resolve
commands differently: `pi.cmd` for cmd and PowerShell, and an extensionless `pi`
POSIX script for git-bash/MSYS, which does not use `PATHEXT` and so cannot see a
bare name resolved to `.cmd`. Both route `update` the same way, and both honour
`PI_REAL=1`.

A real launcher is preserved as `pi-real.cmd` first: the one it displaces in that
directory, or a stock `pi` found elsewhere on `PATH` — npm installs `pi.ps1`,
`pi.cmd` and an extensionless script side by side, and only the `.cmd` is a
launcher worth wrapping. A POSIX `pi-real` sits beside it for git-bash. `pi-real`
or `PI_REAL=1` reaches it, and `remove` puts a displaced launcher back byte for
byte (a wrapper to a stock pi elsewhere is simply deleted, since that pi never
moved). With no preserved launcher, `PI_REAL=1` exits 127 instead of quietly
running pi-bolt. `status` prints what `pi`, `pi-real` and `pi-bolt` resolve to.

**Tests.** `node --test tests/*.test.mjs` covers `install.ps1`, `rebuild.ps1`,
`after-update.ps1` and `pi-swap.ps1` against a disposable repo and
`%USERPROFILE%`, with a `PATH` that holds no winget and no reachable npm (a
fail-closed stub stands in for it, since npm.cmd lives beside node.exe); those
cases report as skipped off Windows.
The fast-search suite is green on Windows apart from two POSIX-only cases it
reports as skipped, and
[`probe-windows.mjs`](dot-pi/agent/extensions/fast-search/tests/probe-windows.mjs)
proves inside the real Pi-Bolt runtime that fd/rg run there and match native.

## GitHub Copilot models, long context, and Fusion

One plugin, `extensions/copilot.ts`, covers the account: the live catalog and
billing on Pi's native Copilot provider, `/long-context`, and Fusion Standard.
They are one file because they act on one account and one selected model — the
catalog bounds a model's budget, `/long-context` raises it for the current
selection only, and Fusion has to know when a compaction check may run at all.
An empty or missing section below therefore still needs this one plugin.

## GitHub Copilot models and billing

The plugin builds on Pi's native Copilot
provider. Keep using `/login` and the `github-copilot` model IDs. The extension
uses the signed-in account's catalog to populate `/model` with eligible chat
models that support Pi's transports, including IDs not yet in Pi's bundled
catalog. It applies the reported default prompt and output budgets without
turning on long context. If your `enabledModels` list is scoped, add new IDs to
it as needed.

Pi refreshes the catalog when opening the model picker; `/copilot-refresh`
forces a refresh. Catalog discovery is in memory. An offline startup or a failed
lookup falls back to existing model metadata; use `/model` after refresh for
IDs that weren't in Pi's startup catalog. `models.json` is not rewritten.

The catalog is laid over the provider registered for `github-copilot` on the
session's first start, rather than replacing it, and `models.json` still applies
above the result. That registration happens before `/long-context` picks its
clone, because Pi re-reads the selected model from the registry whenever a
provider is registered. Another extension that serves Copilot through a
provider configuration keeps working, layered over the catalog, and a `/reload`
unwraps to the provider this plugin originally wrapped instead of nesting
another layer. One versioned `/models` read is shared between the provider's
priced tiers and the `/long-context` probe for five minutes, so a selection no
longer sends the same request twice; `/long-context` and `/copilot-refresh`
always re-read it.

For direct Copilot and Fusion chat responses that report billing, the session
JSONL stores `usage.copilotBilling.totalNanoAiu` and `usage.copilotBilling.aiCredits`.
The provider amount replaces the estimate in `usage.cost.total` (USD equivalent,
[1 AI Credit = $0.01](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals));
`usage.cost.totalFromProvider` is `true`. Component costs remain estimates.
The footer's `AIC` subtotal includes reported credits only. Responses without
billing data keep their estimates, and older logs are not backfilled. The USD
value represents usage, not necessarily an out-of-pocket charge.

```sh
python3 tests/copilot_provider_test.py
node --test tests/nice-model-footer.test.mjs
```

## GitHub Copilot long context

The standard pi-config install includes `/long-context`. Select a direct
`github-copilot` model and run **`/long-context`** to enable its larger context
window immediately. No model ID, config edit, or reload is needed to switch
modes. This is a no-op on unsupported models and other providers, including
Copilot Fusion.

Long context is the default where it costs no more: when a direct Copilot model
is selected, when the session starts, or when you send a message (which covers
re-selecting the same model), its catalog long-context tier is checked,
and if every token rate is at or below the standard tier's rate, the larger
budget is applied automatically. Models whose long tier is priced higher keep
the standard budget until you run `/long-context`. With `--offline` or
`PI_OFFLINE` set, the automatic check is skipped entirely, so run `/long-context`
to enable it.

The command reads the signed-in account's versioned Copilot `/models` catalog.
It uses the `long_context` tier and the model's reported limits to set Pi's
prompt budget with room for output, and adds `X-GitHub-Api-Version: 2026-08-01`
to that selection's inference requests. `--list-models` still shows the
registry's model metadata, not this session-local override. No inference
request is sent just by running the command.

Use `/long-context off` to restore the standard budget. It stays off for that
model for the rest of the session, even if you reselect it; a reload or new
session applies the default again. Selecting a different model applies its own
default. No changes are written to `models.json`. [Larger contexts can consume more AI credits](https://github.blog/changelog/2026-06-04-larger-context-windows-and-configurable-reasoning-levels-for-github-copilot/).

```sh
bun test dot-pi/agent/extensions/shared/copilot-long-context.test.ts
python3 tests/copilot_long_context_test.py
```

## GitHub Copilot Fusion Standard

The same plugin adds **`copilot-fusion/standard`**. Select it in
`/model` or start Pi with `--model copilot-fusion/standard`; keep your existing
`github-copilot` login. Pi runs its own tools and streams the model GitHub
selects, with the Fusion routing token passed only in that request's headers.
The token is kept in memory, never saved in Pi's session or model catalog. The
picker shows the selection as `Fusion/Standard`, and the footer's model segment
shows where the latest response was routed, e.g. `(copilot-fusion)
Fusion/Standard → Luna-6` (family-first shorthand for `GPT-6 Luna`).

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
node --test tests/nice-model-footer.test.mjs
node --test tests/loop.test.mjs
node --test tests/continue.test.mjs
(cd plugins/pi-smart-compaction && npm test)
```

## `/continue` — resume a stopped session without sending anything

`extensions/continue.ts`. After a dropped connection, a killed terminal, or a
run that stopped mid-work, `/continue` runs the model on the transcript as it
stands. No text is added to the context.

Pi has no public call to start a run from an existing transcript, so the command
appends a hidden, empty custom message (`continue-run`) and triggers a turn. A
`context` handler removes that marker from every request. It also omits an
interrupted tail the way pi's auto-retry does: an errored or aborted reply, or
tool calls with no result, along with the results after them. The command
refuses when the agent is busy, when the session is empty, or when the last
reply already finished (`stop` / `length`), since nothing is pending then.

Limit: a session killed mid-tool-call can leave an unpaired tool call in the
transcript. `/continue` omits it for its own request, but later turns send it
as pi does today, which some providers reject.

## DeepSeek V4.1 Flash provider routing

DeepSeek bills two tiers by wall clock (peak = 2x off-peak: 01:00-04:00 and
06:00-10:00 UTC, Mon-Fri). The same checkpoint (DeepSeek-V4.1-Flash-1017) is
resold flat by two other providers, so `extensions/deepseek-routing.ts`
registers a virtual model, **`deepseek/deepseek-flash-auto`**, that sends each
request to whichever of the three is cheaper at that moment:

| | DeepSeek direct | DeepInfra | IsoQuant |
| --- | --- | --- | --- |
| card (in / out / cache-read, per 1M) | $0.15 / $0.60 / $0.003 off-peak, 2x at peak | $0.20 / $0.60 / $0.006 list, times `1 - discount` | $0.035 / $0.37 / $0.005 flat, no cache-write charge |
| promo | — | 51% off, 2026-11-16 | none |
| cache | on disk, improves as the context grows | memory-resident, degrades | tracks DeepSeek's |

IsoQuant's side is optional: its provider is registered by a **machine-local**
extension (`~/.pi/agent/extensions/isoquant-provider.ts`), because the machines
sharing this repo have no IsoQuant account. A side that is not in the catalog is
simply not a candidate, which is also how a DeepSeek-only machine keeps working.

**How "cheaper" is decided.** Measured, not asserted axis by axis: the three
prices are not remotely equally important. A long agent session replays its
whole history every turn, so on this machine **99.4% of every prompt token is a
cache read**, and the measured split of a turn's tokens is:

| axis | share of tokens | share of spend, DeepSeek off-peak |
| --- | --- | --- |
| input (cache miss) | 0.36% | 10.4% |
| cache read (cache hit) | 99.4% | 57.2% |
| output | 0.28% | 32.4% |

Cache reads are therefore both the heaviest axis and the one the cards differ
most on — DeepInfra's list price is 2x DeepSeek's off-peak there (1.33x on input,
the same on output) and IsoQuant's 1.67x (a fifth on input, 0.62x on output) — so
the decision is essentially a cache-read comparison. `TOKEN_MIX` in the shared
module holds that measurement, from DeepSeek traffic only: measuring the mix on
each side instead would put its cache penalty in the weighting *and* in the
ratio, counting the same thing twice.

**The mix alone is not enough, because the caches age differently as the context
grows.** DeepSeek caches KV state on disk; DeepInfra's cache is best-effort and
memory-resident; IsoQuant forwards to the same upstream checkpoint, so its cache
behaves like DeepSeek's. Holding the gap under 60 seconds — so elapsed time
cannot explain it — the miss rates are identical up to ~65K tokens and then
diverge, while DeepSeek's *improves*:

| prompt size | DeepSeek | DeepInfra | IsoQuant | ratio DI | ratio IQ |
| --- | --- | --- | --- | --- | --- |
| 0–65K | 1 per 29 | 1 per 30 | 1 per 24 | 0.99x | 1.23x |
| 65K–131K | 1 per 115 | 1 per 107 | 1 per 154 | 1.08x | 0.75x |
| 131K–262K | 1 per 385 | 1 per 185 | 1 per 471 | 2.07x | 0.82x |
| 262K–524K | 1 per 840 | 1 per 256 | 1 per 1090 | 3.29x | 0.77x |
| 524K–1M | 1 per 1675 | 1 per 85 | 1 per 1981 | 19.82x | 0.85x |

`CACHE_BANDS` holds that table, and `priceSide` prices **every** side at the
band the current prompt falls in — each at its own measured cache behaviour —
using the latest turn's `input + cacheRead` as the size; `cheapestSideAt` then
picks the winner. A single scalar was wrong in both directions: the old 1.87 was
tuned for the ~160K band this machine happens to live in, and it kept choosing
DeepInfra at 524K+ where the two cards reach parity. Blended over a billion
tokens:

| prompt size | DeepSeek off-peak | DeepInfra @51% | IsoQuant |
| --- | --- | --- | --- |
| 30K | $9.49 | $6.93 | $7.23 |
| 200K | $5.06 | $4.26 | $6.09 |
| 600K | $4.76 | $4.87 | $6.04 |

IsoQuant is the cheapest side at **peak** whenever DeepInfra's promo lapses —
0.60x DeepSeek's peak card at 200K — and it beats DeepSeek off-peak on a fresh,
short prompt, where its input rate is a fifth. From ~65K up off-peak it is third,
and while a deep promo is live it is third everywhere: 27% off DeepInfra's list
undercuts it at 524K, 49% at a short prompt.

The old rule required DeepInfra to beat DeepSeek on *all three* axes. That test
is never wrong, just far too conservative: it demands a 50% discount where the
break-even is **~32% at a short prompt** and **~42% at 200K**. At 51% the promo
wins off-peak up to ~400K; at 30% — what DeepInfra's un-suffixed
`DeepSeek-V4.1-Flash` lists — it loses off-peak and wins at peak.

**No tier is hardcoded, and no price is assumed.** Every request ranks all three
cards and takes the cheapest reachable one, so a DeepInfra price above DeepSeek's
peak card sends peak to IsoQuant with no code change, and a lapsed promo moves
peak off DeepInfra entirely. The extension is seeded with DeepInfra's *list*
price, never with the current promo, and `route()` awaits the live fetch before
deciding — so a session whose fetch fails routes conservatively on list price
instead of on an assumed discount. IsoQuant's card is static because it has
nothing to discover: no promo, no peak tier, one published rate. (`PI_DEEPSEEK_TIER`
still forces a tier for testing, and the footer label shows which side the
comparison picked — and which of them this machine can actually reach — not what
a DeepSeek-only machine would end up using.)

- DeepInfra publishes its rates publicly at `/v1/openai/models`, so the extension
  refetches them each session and re-registers the model's cost — the footer's
  dollar figure tracks the real billed rate, promos included. `models.json`
  deliberately has no `deepinfra` entry: an override there would freeze the
  price at whatever was true when the file was written.
- IsoQuant publishes its card at `/v1/models` (nano-USD per token) and has
  nothing to fetch for: no promo, no peak tier. So its card is a constant,
  `ISOQUANT_RATES`, verified against that endpoint. It is deliberately *not*
  re-registered here — that provider's model list and cost belong to the
  machine-local extension that owns it, and a `{}` registration from the router
  would replace them. The one maintenance rule: a price change belongs in both
  files, or the router compares a card pi no longer bills.
- `TOKEN_MIX` and `CACHE_BANDS` are measurements, not guesses. Re-derive them
  with `node dot-pi/agent/extensions/shared/measure-token-mix.mjs` (and
  `--penalty`, which now reports all three sides), passing `--provider deepinfra`
  or `--provider isoquant` for a side's own cache-efficiency figure, and
  `bun test dot-pi/agent/extensions/shared/` pins the arithmetic — including the
  break-even discount — so a drifted constant fails instead of quietly flipping
  the router.
- Provider choice is per turn, not per request: tool follow-ups stay where the
  turn started, so only crossing a peak boundary costs a prompt-cache miss. A
  retry after a provider-side error (5xx, 429, overload, network) crosses to the
  next-cheapest side that is not the one that failed, once; then the next user
  message returns to the clock/price choice. A side that degenerates *without*
  erroring — HTTP 200, a full stream, and nothing usable at the end of it — has
  no retry to cross on, so it is demoted to last for 30 minutes instead, relearned
  from the branch when a session resumes after a kill. DeepInfra's own
  registration declares 128K of output rather than the catalog's 384K, which
  bounds one such answer at ~8 minutes; DeepSeek direct and IsoQuant keep their
  own caps. See `degeneratedResponse`.
- Every side is in `enabledModels`, `defaultModel` is the router, and
  `model-roles.json` `workhorse` points at it, so sessions, subagents and
  workflows all route.

**Where it shows up.** The router is a model, not a proxy: nothing else is
redirected, and selecting `deepseek/deepseek-flash`, the `deepinfra` model or
the `isoquant` model directly pins that provider. It is registered under the
`deepseek` provider, so it exists only on a machine logged into DeepSeek —
without that credential it never appears in `/model` and no routing code runs,
so a work machine that has none of the three stays untouched. It routes to
DeepInfra or IsoQuant only when that side also has a credential and a catalog
entry; a DeepSeek-only machine stays on DeepSeek instead of failing
(`modelRegistry.find()` returns credential-less models, so the router checks
`getAvailable()` first). Without a key, pi hides that provider entirely. The
footer label names the side the comparison picked *and this machine can reach*,
so it does not promise a provider the request can never go to.
`getAvailable()` is a *cache* pi refreshes asynchronously, so it
decides the preferred side and nothing more: when it omits every side — or comes
back empty — the router confirms against the catalog and notes it once on stderr,
because `route()` throwing ends the request with an error pi does not retry and —
every request going through the router — would keep ending it until pi was
restarted. It also re-checks a stale credential snapshot live before failing: on
resume, `session_start` re-registers the DeepInfra side and the availability
refresh that follows replaces the configured-provider set wholesale, so the first
request can arrive while that set is momentarily empty. pi's own send path does
not trust it either (`hasConfiguredAuth() || await checkAuth()`), and
`modelRegistry.refresh({ providers })` runs that live check, so the router
rebuilds the snapshot for every side in the catalog and re-resolves. If that
rebuild still
leaves the cached verdict saying no, the router repairs what pi reads instead of
trusting it: `getProviderAuth()` resolves the credential without the cache, and
re-registering the provider restores a lost registration — DeepInfra is not in
pi's builtin catalog, so its entry exists only because this extension registered
it — and marks the provider configured again, which is the cache
`hasConfiguredAuth()` reads. IsoQuant is the exception: its registration belongs
to the machine-local extension, so the router never re-registers it, and a lost
IsoQuant simply drops out of the ranking. The error, naming `/reload`, is only
for the case where the live check itself finds no key; it names, per side,
whether the
model was in the catalog, what the credential store holds, what the cached
verdict said, and what the live check found, so a recurrence is diagnosable from
the message instead of by reproduction.

**A dead context is a different failure, and it used to be misreported as this
one.** Every field of the context `route()` is handed is a getter that begins
with the extension runner's staleness check, so once pi replaces or reloads the
session behind the registration — `/new`, `/fork`, `/resume`, `/reload`, or
another session's runner in the same process — *every* registry read throws at
once. That produces exactly the same four facts on every side as the missing
credentials would, with nothing wrong with any key, and none of the recovery
above
can help because each step re-reads the same dead context. So the router checks
for that state first and answers with the last physical model it saw this session
use — seeded at `session_start`, refreshed on every decision, topped up from the
`previous` / `failed` model pi supplies — noting the stale context once on stderr.
A guard around the whole of `route()` does the same for any failure the file has
not anticipated, so the router can no longer end a turn at all except on a verdict
it means to report: a readable registry that positively says no key exists. pi
re-checks credentials on what `route()` returns, so the worst case is pi's own
accurate error rather than a dead turn.

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

IsoQuant is optional on top of that: a key as provider `isoquant` in the same
file **plus** the machine-local `~/.pi/agent/extensions/isoquant-provider.ts`
(which registers the provider and its card — it is kept out of this repo because
no other machine has an IsoQuant account). With the key but no extension the
side never enters the catalog, so the router behaves exactly as it does on a
two-provider machine.

Known gap: DeepSeek's docs also make Chinese public holidays off-peak all day;
`DEEPSEEK_HOLIDAYS` in the shared module is empty, so a holiday is treated as a
normal weekday (it over-routes to DeepInfra or IsoQuant for that day rather than
mis-pricing).

## Compaction

Four things touch compaction, and they are deliberately on different halves of it:

| Component | Decides | Hook |
| --- | --- | --- |
| `plugins/pi-vcc` | **how** every compaction is summarized | returns a compaction from `session_before_compact`; adds `vcc_recall` over the raw session file |
| `plugins/pi-smart-compaction` | **when** an idle session is worth compacting on resume | `input` gate + `ctx.compact()`; no summarizer of its own |
| `dot-pi/agent/extensions/copilot.ts` | whether a pre-route check may compact at all | returns `{cancel}` on a `fusion/standard` session before a model was routed; manual `/compact` passes through |
| `plugins/pi-codex-goal` | what a goal loop's control messages look like | filters `preparation` in the same hook, returns no compaction |

`plugins/pi-todo` / `npm:opensec-pi-todo` replays its task list from the branch
on `session_compact` and never summarizes; pi-subagents,
pi-web-access, pi-system-one, rpiv-ask-user-question, `deepseek-*`, `loop` and
`orca-*` register no compaction hook at all. The one other request-time
`context` transform is `cache-keepalive`'s `context_with_system` hook, which Pi
runs in a second phase after every `context` handler, so it sees pi-vcc's
filtered messages rather than competing with them.

They compose rather than fight. Pi's `ctx.compact()` — which is all
pi-smart-compaction calls — emits `session_before_compact`, so a resume-time
compaction gets a pi-vcc summary and the same 15 % floor / cache-lifetime gate
as before. Of the two other handlers on that event, one only cancels (a cancel
short-circuits the runner, so `copilot-fusion`'s answer wins whichever order it
runs in) and one returns `undefined` (goal bookkeeping), so pi-vcc is the single
handler that returns a compaction and Pi's "last handler wins" rule has one
candidate. No provider is listed in pi-vcc's `skipForProviders`, so it also
compacts the automatic threshold/overflow case that Copilot Fusion's pre-route
check hands back to Pi, and it compacts the `deepseek/deepseek-flash-auto`
router model the same way — pi-vcc reads the transcript, never the provider, so
there is no model call to fail or skip.

Per-compaction cost falls out of this: smart-compaction still chooses *not* to
compact a warm cache or a small context, and when it does compact, the summary
costs no model call.

**`skipCustomTypes` must name `pi-codex-goal`.** pi-vcc builds its own cut from
`branchEntries`, so it never reads `preparation.messagesToSummarize` — which is
what `pi-codex-goal` filters goal control messages out of
(`src/goal-compaction.ts:filterGoalCompactionInput`) so the summarizer does not
see "Continue pursuing the goal" boilerplate. That filter is inert under
pi-vcc, and its documented lever is `skipCustomTypes`. Measured on a real
session with 22 spliced continuations: without the key the summary carries the
boilerplate (2 transcript lines, 13,585 chars), with it zero (13,320 chars).
The objective itself is unaffected either way — it rides on the system prompt,
not on the summary.

```json
"skipCustomTypes": ["pi-codex-goal"]
```

`~/.pi/agent/pi-vcc-config.json` is **machine-owned** and not tracked here. It
is created by the extension with its defaults (`overrideDefaultCompaction: true`,
`smartKeepTail: true`, `continueAfterThresholdCompact: true`, empty
`skipCustomTypes`) on first load, and a later release only fills in keys it is
missing — so a machine keeps its own `skipForProviders` / `trackCommands`
choices across installs. The `pi-codex-goal` entry above is the one value a
machine running this repo has to set; it is not shipped as a seed because the
extension writes the file itself. Tracked config stays on the smart-compaction
side (`dot-config/pi-smart-compaction/config.json`, the 15 % context floor).

On Pi ≥ 0.84.4 pi-vcc sends no continue of its own after an automatic
compaction (Pi resumes the run itself), so `pi-codex-goal` stays the single
source of post-compaction continuation.

Commands: `/pi-vcc` compacts now (keeping the last user turn, `keep:N [prompt]`
to choose), `/pi-vcc-recall <query>` runs the recall search as a command, and
`/smart-compaction [force]` prints the resume gate's status or fires it.

## `/loop` — one scheduler, two execution homes

`extensions/loop.ts` owns every recurring prompt in a session. It has two
backends and presents them as one command, one list, and one footer segment:

| backend | what fires | cost per tick |
| --- | --- | --- |
| live (default) | the prompt re-enters **this** session — conversation, model and tools intact | the whole transcript goes to the model again |
| cold (`--cold`) | the `pi-subagents` scheduler spawns a fresh subagent session | a small fresh context, nothing added here |

Cold is **not** about persistence — both backends are session-scoped, both come
back on `/resume`, and neither outlives the session. Cold is about context: a
context-free repeat costs less in a subagent even when prompt caching makes the
live tick look nearly free.

```text
/loop 5m check the deploy        live, fixed interval — first run immediately
/loop check the deploy           live, self-paced — the model picks each delay
/loop 1m --cold say hello        cold — a subagent session per fire
/loop                            self-paced on .pi/loop.md (or ~/.pi/agent/loop.md)
/loop 5m                         that file at a fixed cadence
/loop list · /loop stop [id|all] both backends; cold rows are tagged [cold]
```

Recurring work has exactly **two doors — one per audience**, and neither one is
the other's job:

| audience | door | what it covers |
| --- | --- | --- |
| you | `/loop` | arm/list/stop, and `--cold` to pick the execution home |
| the model | `manage_schedules` | the whole lifecycle, both homes |

The model's door is one tool with one verb per intent, so there is nothing to
infer and no reason to hand a command back to you:

| action | what it does |
| --- | --- |
| `create` | arm a job — `schedule` + `prompt`, plus `backend` and, for cold, `name` / `subagent_type` / `model` / `thinking` / `max_turns` |
| `list` | every job in the session, both homes, with cadence, next run, runs, paused state, agent and prompt |
| `update` | change cadence, prompt, name, agent type, model, thinking or turn cap |
| `run` | fire it now, leaving its own schedule armed (an extra iteration, not a replacement) |
| `pause` / `resume` | hold it (timer disarmed, row and history kept) / let it fire on its own cadence again |
| `cancel` | remove it for good |

Every verb works on **both** homes, because a door that can arm a job but not
see, change or stop it is half a door — and half a door is exactly what made a
model narrate `/loop` commands at the user instead of acting. `create` picks a
home:

- `backend: "cold"` (the default) — a job in pi-subagents' scheduler; each fire
  spawns a fresh subagent session. Cheap in this conversation: nothing is added
  to your transcript, and the result arrives as a notification.
- `backend: "live"` — a loop in `/loop`'s own table; each fire re-enters **this**
  session as a user message, inheriting the conversation, model and tools. It
  pays for the whole transcript every fire and leaves its own turns behind, so
  it is the one to use when the repeat has to happen *here*, and not something
  to arm off a vague "monitor X".

Cold is the default because it is the safe one — a wrong cold job wastes tokens,
a wrong live job also spends your context. Either way the job the model creates
is the same object `/loop list` shows and `/loop stop` disarms, and `live` is
refused cleanly (naming `/loop`) when that extension is not loaded.

The Agent tool has **no** `schedule` param and no setting adds one back: it was
retired because it and `/loop` shared one scheduler, so the louder guideline
decided where a job landed and a job created from a turn ended up somewhere the
user was not looking — with no model-side way to list or cancel it. A stale
caller that still sends `schedule` is answered with `manage_schedules` by name
rather than silently spawning an agent now.

The two homes are reached differently, because they live in different processes'
worth of state. A **cold** job is in pi-subagents' own scheduler, so the model's
tool calls it in-process; other extensions reach it over
`subagents:rpc:schedules:{list,create,remove}`
(`plugins/pi-subagents/src/schedule-rpc.ts`). A **live** loop is a closure inside
`loop.ts`, so the tool reaches it over the bus —
`loop:rpc:schedules:{list,create,update,run,remove}`, served by `loop.ts` and
called from `plugins/pi-subagents/src/schedule-live-rpc.ts`. The scheduler
announces restored and changed jobs on `subagents:scheduled`, which is how
`/loop` mirrors them without knowing where the scheduler keeps its store.

Both sides refuse a call that changes nothing, so "did it work?" is answerable
rather than assumed; `run` never fires inside the turn that asked for it; and a
cold fire that fails synchronously is reported as a failure instead of as a run
that started.

Self-paced mode is driven by the `ScheduleWakeup` tool, which the model calls at
the end of each turn with `delaySeconds` (clamped to `[60, 3600]`), a `reason`,
and `noop` for a tick that changed nothing. A turn that ends without scheduling
one gets a single 20-minute grace wakeup; a second silent turn ends the loop. It
is live-only — a cold loop has no session to pace itself in.

It is also the one deliberate exception to "one door": it **paces** a loop that
already exists, and is refused on a paused one, but it cannot arm, cancel or
re-time anything. Its description says that outright and points at
`manage_schedules`, because a model that reads "schedule" in a tool name is a
model that tries to create a 25-minute job with it — and only finds out, a turn
later, that nothing was armed.

The count and the soonest fire ride on the footer's **path/branch row** —
`~/Code/pi-config (main) • ◷ 1 loop · 1 job · next in 4m 30s` — naming each
backend that has work armed, plus `quiet ×N` while consecutive live no-op ticks
pile up. It is appended there rather than given a status row of its own
(`nice-model-footer.ts` pulls the `loop` status out of the status list), and a
narrow footer truncates the path before it truncates the countdown.
Claude's REPL has no such persistent counter (2.1.316 shows a `next run` row per
tool call instead); `setStatus` is what makes it possible here.

Rules carried over from Claude, each of which is a lesson rather than a detail:

| Rule | Why |
| --- | --- |
| Fires land between turns, never mid-response | a due loop waits for the run to settle |
| No catch-up | N missed fires become one fire, not N |
| 7-day expiry, one final fire | a forgotten loop cannot run forever |
| 60 s floor | anything faster is a busy-wait with extra tokens |
| First iteration runs at creation | a loop you cannot see start is one you cannot trust |
| Max 50 live loops, one self-paced loop | a pending wakeup is a per-session slot |
| Pause is persisted, not session state | a restart is not a request to resume something you held |

Session-scoped, restored on `/resume`, never standing: live loops are written to
`.pi/loops/<sessionId>.json` and cold jobs to `.pi/subagent-schedules/<sessionId>.json`.
A new session starts empty, a resumed one re-arms its own work one interval out
(no replay of missed slots), and closing the terminal stops everything — there is
no durable flag to set, because a schedule nobody is listening to is not a
feature.

```sh
node --test tests/loop.test.mjs
(cd plugins/pi-subagents && npx vitest run)
```

## Intentionally not tracked

| Excluded | Why |
| --- | --- |
| `~/.pi/agent/auth.json` | live provider keys and OAuth tokens |
| `models.json` `apiKey` values | replaced with `${OMLX_API_KEY}` |
| `~/.pi/agent/sessions/` | private conversation transcripts (~1 GB) |
| `~/.pi/agent/npm/`, `models-store.json`, `web-search-cache/` | caches |
| `~/.pi/agent/bin/{fd,rg}` | platform-specific binaries |
| `~/.pi/agent/trust.json`, `run-history.jsonl` | machine-local state |
| `~/.pi/agent/pi-vcc-config.json` | pi-vcc's own compaction policy; the extension writes it with its defaults on first load |
| `~/.pi/agent/reports/` | generated analyses of my own sessions |
| Orca-specific extensions (`orca-*.ts`) | deliberately not shared |
| Orca-managed skills (`orca-cli`, `orchestration`, `computer-use`) | installed and updated locally by Orca, so transferring them would fight that |
| `pi-bolt/*/dist-bun/`, `pi-bolt/*/build-info.json` | bundle build output; each machine rebuilds it from this clone |
| `pi-bolt/.pi-swap-state` | records what `~/.local/bin/pi` was before the swap |
| `~/.pi-bolt/` | the Pi-Bolt executable and compile cache; installed per machine |
| `~/.agents/.skill-lock.json` | per-machine install state (it lists what *this* machine has installed) |
