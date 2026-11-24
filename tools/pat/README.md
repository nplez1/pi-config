# pat — PAT inventory, peer sync, expiry watch

One place that answers *which token is this, where do I renew it, what breaks
when it expires* — across every machine, without a central server and without
secrets in git.

`pat` lives in this repo because it holds no values. The inventory it reads
does: internal hostnames, renewal URLs, owners. Keep that in `~/.config/pat`,
never here.

## The two problems it separates

Expiring PATs hurt for two different reasons, and only one of them is expiry:

- **Distribution.** The same secret is copied into shell profiles, agent config,
  CI. Rotating means finding every copy, and four machines multiply that.
- **Observability.** Nothing links a token to its owner, its renewal portal and
  its consumers — so a 401 becomes a bisect instead of a lookup.

An inventory plus per-token state fixes the second outright. Peer sync fixes the
first. Expiry is just the trigger.

## The model: no canonical machine

Earlier designs put one machine in charge. That only papers over the real bug,
which is that the unit of sync was the whole file: rotate `github` on one box and
`linear` on another and the last writer destroys the other's rotation.

Here the unit of sync is **a token**, and there is no authority:

```
~/.config/pat/
  config.toml            this machine: its tags, its peers. No values.
  inventory.toml         one [[token]] per PAT: metadata only. No values.
  state/github.meta.json { version: 7, sha, updated_at, updated_by, removed, only_on }
  state/github.secret    the value, mode 600
  archive/github.secret  the value a rotation or a removal displaced (local undo)
  secrets.env            RENDERED from state/ — sourced by your shell
  .lock
```

Merge rules, applied locally on whichever machine you are typing on:

| situation | result |
| --- | --- |
| peer version higher | peer wins, adopted here |
| peer version lower | kept locally; the peer catches up on its next sync |
| equal version, equal hash | converged, no-op |
| equal version, different hash | **conflict** — reported, never applied |
| `removed: true` | tombstone: a delete propagates and cannot be resurrected by a stale peer |

`version` is a counter, not a timestamp: clock skew across four machines must
never decide which credential is live. Resolve a conflict with
`pat take <host> <id>`, which adopts the peer's value at a version above both.

## First run

```sh
pat setup --tag work --tag homelab
```

Creates `~/.config/pat` (700), both TOML files (600), and appends a fenced block
to `~/.zprofile` and `~/.zshrc`:

```sh
# >>> pat >>>
[ -r '/Users/you/.config/pat/secrets.env' ] && . '/Users/you/.config/pat/secrets.env'
# <<< pat >>>
```

There is deliberately no `pat sync` in that block: shell startup must never block
on ssh. Sync is an explicit command or a scheduled job.

Then migrate what the machine already has:

```sh
pat setup import-env               # show PAT-shaped env vars
pat setup import-env --yes --apply # add inventory rows and store their values
```

Fill in `renew_url`, `ttl_days` and `issued` in `inventory.toml` — that row is
what turns a failure into a lookup.

## Adding machines

```sh
pat setup host add office_m1 --tags work
```

`add` **probes first** and refuses to record a host that fails: reachable with
`BatchMode=yes` (so a password prompt is an error, not a hang), has `tar` and
`sh`, and has a writable root. Then it writes one section:

```toml
[hosts.office_m1]
ssh  = "office_m1"     # an alias from ~/.ssh/config, or user@host
tags = ["work"]
path = "~/.config/pat"
mode = "both"          # both | push | pull   (pull = read-only peer)
```

**Nothing has to be installed on the peer** — a POSIX login shell, sshd, `tar`,
`grep` and `stat` are the whole requirement. The peer never runs `pat`;
transport is a tar stream in each direction and merge happens on your machine.

```sh
pat setup host list | probe <alias> | tags <alias> a,b | rm <alias>
pat setup hosts                    # suggest unmanaged aliases from ~/.ssh/config
pat setup hosts --from orca        # one-time convenience; pat never depends on it
```

## The daily loop

```sh
pat set github           # rotate: prompts hidden, verifies with the canary first
pat sync                 # pull from every peer, merge, push what each may hold
pat status --all         # per-token version vector across machines
pat check                # expiry + live canary; exit 3 when something needs you
pat rm github            # retire: writes a tombstone that propagates on sync
pat get github --previous  # the value the last rotation or removal displaced
```

`pat set` runs the canary **before** writing, so a mistyped or already-revoked
token is never distributed to four machines. It also asks every reachable peer
what version it has (2s each, 6s total, and skipped when a peer is offline — it
tells you which ones it could not read) and writes above the highest one, so a
rotation made while this machine is behind does not lose to an older,
higher-numbered value.

Whatever a rotation, an adoption or a removal displaces goes to `archive/`, so a
bad rotation is an undo rather than a new ticket to the provider. That includes
the case where a peer turns out to be ahead after all: the value adopted replaces
yours, and yours is still in the archive.

`pat push` is pull-merge-then-send on purpose: pushing blind would clobber a
token a peer rotated since your last sync. A conflicting id is reported and
**left out of the push entirely** — the peer keeps its own value and its own
`secrets.env` line until you run `pat take`, so neither its state nor the file
its shells source is rewritten behind your back. That holds however the peer's
tags are configured: an id we cannot judge (a conflict, a refused adoption, a
meta we cannot parse) is never pruned either, because the value it holds may
exist nowhere else.

Drift looks like this — no authority involved, you decide:

```
id      var           ver  days  state  updated              office_m1  mbp_m3
github  GITHUB_TOKEN  v7   41d   ok     2026-11-21 localbox  v7         v6⚠
linear  LINEAR_TOKEN  v3   12d   ok     2026-11-19 localbox  v3≠        v3
```

The peer column reads `vN` same · `vN⚠` peer behind · `vN↑` peer ahead · `vN≠`
same version, different value (the conflict `pat take` resolves) · `gone` removed
there · `–` absent. Every cell is a version counter, never a timestamp: clock
skew must not decide which credential is live.

## Tags decide what a host may hold

`only_on = ["work"]` in a token row means the value is never written to a peer
whose tags do not intersect, is never adopted on a machine whose own tags do not
cover it, and is deleted from a machine that stops qualifying.

The restriction also travels in the token's own metadata, because `inventory.toml`
is local and never syncs — a home machine usually has no row for a work token,
and it still has to refuse one. A local row, when present, is the authority; the
metadata is the fallback. Rotating a token on a machine that has no row inherits
the restriction rather than clearing it.

Enforcement is on both sides. A push carries an `.allowed` list, which answers
"what may this peer keep" — a question about the *peer's* tags, not about what
this machine happens to hold. The peer's script deletes every id absent from it,
value and metadata, so a work token cannot survive on a home machine even if an
earlier push put one there; and equally, a home machine's push cannot delete the
work tokens from the work peer just because it does not hold them itself. The
peer's `secrets.env` is rendered from the peer's own post-push state for the same
reason.

Pruning a token deletes it rather than archiving it — but only when a peer
provably holds that value (or a newer one). If this machine is the only holder,
the token is kept: unrendered, so nothing leaks into a shell, and `pat doctor`
says it is here and not tagged for here. A missing credential is worse than an
untidy one, and the alternative — deleting on a typo — destroys a value that
exists nowhere else.

Editing `only_on` in the registry takes effect on the next push, so the
import-then-tag flow (`import-env --apply`, then tag) does not leave an
unrestricted copy on the peers.

One deliberate concession: a machine that declares no tags at all cannot filter
anything. `pat doctor` warns about exactly that, because it is also the state
where a work PAT could land somewhere it should not.

## Checks

```toml
check = { kind = "http", method = "GET", url = "https://api.example/user" }
check = { kind = "http", url = "https://gitlab/api/v4/user", header = "PRIVATE-TOKEN" }
check = { kind = "command", command = "gh auth status" }
```

Default HTTP auth is `Authorization: Bearer <value>`; `header` sends the raw
value in another header. `command` gets the token in the environment variable
named by `var`. A `check` url must be `https` (plain `http` only for loopback),
and a redirect fails the check instead of re-sending the token to another origin.

Most PAT APIs never expose a token's expiry, so `pat` derives one from
`issued + ttl_days` **and** asks the provider whether it still works. Derivation
says what you assume; the canary says what is true.

## Backup

```sh
pat backup  --out ~/pat-$(date +%F).tar.enc
pat restore ~/pat-2026-11-23.tar.enc
```

A passphrase-encrypted tar of `state/`, `config.toml` and `inventory.toml`
(openssl AES-256-CBC, PBKDF2-SHA256 at 200k iterations; the passphrase arrives on
stdin, so it never reaches the process list). The plaintext tar is written into a
`mkdtemp` directory at mode 700 and removed afterwards. Four replicas is good for
durability and bad for "which one is right"; this is the copy that survives
losing every machine. Keep it off-machine.

`restore` keeps this machine's own `config.toml` — a backup carries state and the
registry, not another machine's identity — and says which files it kept.

## Orca

`pat` is ADE-agnostic, but Orca is where it pays off:

- **Daily automation** — schedule `pat check` (add `--json` to parse, or just use
  the exit code) and post through `orca-np slack post` only when it exits 3. No
  cron, no launchd, survives a closed laptop, and the run history is in Orca.
- **Agent preflight** — add one line to `~/.orca/agent-hooks/{claude,codex}-hook.sh`
  on session start: if `pat check` is not clean, emit the token id, days left and
  renew URL into the agent's context. The agent warns you instead of dying
  mid-task, and it knows to resolve through `pat run` rather than inherited env.
- **The stale-env trap** — a GUI app inherits its environment at launch, so a
  rotation in `.zprofile` never reaches a running Orca app's children. That is
  structural, which is why long-lived consumers should get tokens via
  `pat run <id> -- cmd` and the preflight is worth having.

## Security notes

- Values are files at mode 600 under a 700 directory; `secrets.env` and every
  `state/*.secret` are checked by `pat doctor`.
- Values never travel to a peer that is not allowed to hold them, and `pat check`
  never prints one.
- Only `pat get <id>` and `pat env` print a value; nothing else does.
- A value adopted from a peer is checked against the hash in its metadata first,
  and a secret that is a symlink rather than a regular file is never read.
- `secrets.env` takes its variable name from `inventory.toml`, else from the
  token's metadata **only when that name is credential-shaped** (`*_TOKEN`,
  `*_API_KEY`, `*_PAT`, `*_SECRET`, …), else it derives one from the id. A peer
  can write values; it cannot make your shell run text — `PROMPT_COMMAND` is a
  valid identifier and is refused for exactly that reason. Registered rows claim
  their variable before any pulled token, and a collision is reported by
  `pat doctor` rather than resolved silently.
- `archive/` holds the value each rotation, adoption or removal displaced, at
  mode 600 — one file per token, overwritten each time. It is not part of a
  backup, is never synced, and nothing clears it automatically: delete
  `archive/<id>.secret` yourself once you no longer want the undo. A token pruned
  because this machine is not tagged for it is **not** archived, and any archive
  copy it already had is deleted with it: the archive is a copy of the same
  credential, and leaving it behind would undo the prune.
- Nothing in this repo is sensitive; nothing sensitive belongs in this repo.

## Exit codes

`0` ok · `1` error, including every peer unreachable · `2` usage · `3` attention
needed (expiring, expired, invalid canary, conflict). `--json` is available on
`check`, `status` and `doctor` for scripting.

## Runtime: why Node, not a compiled binary

`pat` is plain Node ESM using only `node:` builtins — no dependencies, no build
step. Measured on an M-series Mac, warm:

| | startup |
| --- | --- |
| `node -e ''` (the floor) | 40 ms |
| `node pat.mjs` | 55 ms |
| `bun pat.mjs` | 10 ms |
| `bun build --compile` | 10 ms, 59 MB artifact |

Pi-Bolt's AOT win is ~1,300 ms of interpreter work avoided *inside a long-running
process*. `pat` is a short-lived CLI with 8 small modules, so the only thing on
offer is node's 40 ms process floor — and that floor is not on the hot path:
shell startup sources `secrets.env` directly and never executes `pat`.

Spending 59 MB per platform plus a rebuild-on-edit staleness hazard to save 45 ms
on a command you run a few times a day is a bad trade. If it ever changes, the
work is already proven: `bun test tests/pat.test.mjs` passes 49/49 and a compiled
binary handles ssh sync, canaries, `doctor` and PBKDF2 `backup`/`restore`
identically.

## What it does not do

- It does not mint tokens. Providers decide their TTLs; `pat` tracks them.
- It does not sync while you are offline. Unreachable peers catch up whenever
  they next see anyone, and every machine keeps a working local copy meanwhile.
- It does not run on Windows peers: the remote script is POSIX `sh`. The local
  client works anywhere Node does.
