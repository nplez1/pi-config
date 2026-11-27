# pi-todo-bundle

Generated build of `plugins/pi-todo`, installed as `plugins/pi-todo-bundle` in
`~/.pi/agent/settings.json`. **Do not edit `dist/` or `locales/` by hand.**

```sh
bun scripts/build-todo-bundle.mjs            # rebuild after any plugins/pi-todo change
bun scripts/build-todo-bundle.mjs --check    # diff dist/ against a fresh build; exit 1 on drift
```

`plugins/pi-todo` stays the source of truth: it is the fork of upstream
`@juicesharp/rpiv-todo` 2.15.0, the thing `deps-audit`/`FORK.md` track, and the
tree `tests/todo-settle-reminder.test.mjs` runs directly.

## Why this exists

Pi-Bolt compiles every installed extension into its executable, so the TypeScript
extension costs a compile per install. `npm:opensec-pi-todo@2.13.1` existed to
avoid that, but it is a third-party prebuilt of upstream 2.13.1 — behind on
2.13.5's codemode state persistence, without this repo's `Todos (done/total)`
fix, and without the settle reminder. Building here keeps the speed and our
behaviour, and removes the third-party prebuilt from the load path.

## Why `--target=node --format=cjs`

One artifact serves both runtimes. Bun's own CJS format wraps the module in an
uncalled `(function(exports, require, module, __filename, __dirname) {…})` fenced
by `// @bun @bun-cjs`; only Bun's loader executes that, so under Node
`require()` returns `{}` — which is why `opensec-pi-todo`'s entry throws unless
`process.versions.bun`. A plain CJS bundle runs unchanged under stock pi (Node)
and Pi-Bolt (Bun). `tests/todo-bundle.test.mjs` loads the committed artifact and
drives the settle boundary, so a stale or unloadable `dist/` fails the suite.

## What the build transforms

A CJS bundle cannot contain top-level await, and 2.15.0 has two:

- `index.ts` — the optional i18n SDK registration becomes an exported
  `registerLocales(packageUrl)`, called from `dist/index.js` (the only place with
  a valid `import.meta.url`). `opensec-pi-todo`'s build does the same.
- `state/i18n-bridge.ts` — resolving the SDK's scope becomes a synchronous
  `require` inside the same `try`/`catch`: installed is the same scope, absent is
  the same English fallback.

`@juicesharp/rpiv-i18n` is an optional peer, and the build settles it statically:
if the fork's own `node_modules` has it, its code is **inlined**; if not (the
normal case), the two SDK calls are replaced by the English fallback the source's
`catch` would have produced. The artifact therefore never carries a bare require
it cannot satisfy — which matters because Bun resolves one anyway: from
`~/.bun/install/cache`, where loading `@juicesharp/rpiv-i18n@2.16.0` costs
**~45 ms** of transpile inside every extension load (measured 2026-11-26). Node
misses in 0.14 ms, so the same artifact would also have registered locales on Bun
and been English-only on Node — a machine-dependent behaviour, not just a slow
one. With the decision made at build time: `require` + factory is **1.5–1.8 ms on
both runtimes**, level with the `opensec-pi-todo` bundle this replaces (~1.9 ms).

Install that SDK next to the fork and rebuild to get locales.

The anchor strings are matched literally; a fork sync that changes them fails the
build rather than silently dropping i18n registration.

## Host modules

`@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox` and
`typebox/value` are never bundled — a second copy would be a different class
identity than the running host's. `dist/index.js` imports them, publishes them on
`Symbol.for("pi-todo-bundle@<version>:host-modules")`, and only then requires
`dist/core.cjs`; the version in the key means a `/reload` cannot hand the new
core the previous generation's hosts.
