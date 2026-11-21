/**
 * settings-overlay.test.mjs — the machine-local half of settings.json.
 *
 * `dot-pi/agent/settings.json` is seeded onto every machine and published back by
 * `./install.sh capture`, so a key that legitimately differs per machine had
 * nowhere to live: either it went into the shared seed (and travelled), or it was
 * left divergent in the live file (and the next capture published it anyway). The
 * overlay is that home, which makes two things load-bearing enough to pin here:
 *
 *   - the merge rules, so a machine's additions cannot silently restate or erase
 *     the shared baseline;
 *   - `stripOwnChoices`, which is what keeps a machine-only package out of the
 *     seed on capture — the exact leak the overlay exists to close.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const modulePath = fileURLToPath(new URL("../scripts/settings-overlay.mjs", import.meta.url));
const { applyOverlay, stripOwnChoices, pkgName } = await import(modulePath);

const roots = [];
after(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-overlay-"));
  roots.push(dir);
  return dir;
}

const seed = () => ({
  defaultThinkingLevel: "high",
  packages: ["npm:a@1.0.0", { source: "plugins/local-thing" }, "npm:b@2.0.0"],
  piBolt: { theme: "dark", packages: [] },
});

test("a plain object merges key by key, so the rest of it need not be restated", () => {
  const { settings } = applyOverlay(seed(), { piBolt: { theme: "light" } });

  assert.equal(settings.piBolt.theme, "light");
  // The key the overlay never mentioned survives, which is the whole reason this
  // is a merge and not a replacement.
  assert.deepEqual(settings.piBolt.packages, []);
  assert.equal(settings.defaultThinkingLevel, "high");
});

test("an array replaces instead of merging, because a list must be shorten-able", () => {
  const { settings } = applyOverlay(seed(), { defaultTools: ["read"] });

  assert.deepEqual(settings.defaultTools, ["read"]);
});

test("packages unions by name, so a machine adds without restating the baseline", () => {
  const { settings, added } = applyOverlay(seed(), { packages: ["npm:system-one@1.3.4"] });

  assert.deepEqual(settings.packages.map(pkgName), [
    "npm:a",
    "plugins/local-thing",
    "npm:b",
    "npm:system-one",
  ]);
  assert.deepEqual(added, ["npm:system-one"]);
});

test("a package already present under another version is not added twice", () => {
  const { settings, added } = applyOverlay(seed(), { packages: ["npm:a@9.9.9"] });

  assert.deepEqual(settings.packages.map(pkgName), ["npm:a", "plugins/local-thing", "npm:b"]);
  assert.deepEqual(added, []);
});

test("packagesRemove subtracts, and the directive is not written into settings", () => {
  const { settings, removed } = applyOverlay(seed(), {
    packagesRemove: ["npm:b@2.0.0"],
  });

  assert.deepEqual(settings.packages.map(pkgName), ["npm:a", "plugins/local-thing"]);
  assert.deepEqual(removed, ["npm:b"]);
  assert.equal("packagesRemove" in settings, false);
});

test("removing and adding in one overlay lands in the right order", () => {
  const { settings } = applyOverlay(seed(), {
    packages: ["npm:c@1.0.0"],
    packagesRemove: ["npm:a@1.0.0"],
  });

  assert.deepEqual(settings.packages.map(pkgName), ["plugins/local-thing", "npm:b", "npm:c"]);
});

test("the seed is never mutated, so a dry run and a real run agree", () => {
  const base = seed();
  const before = JSON.stringify(base);
  applyOverlay(base, { packages: ["npm:c@1.0.0"], piBolt: { theme: "light" } });

  assert.equal(JSON.stringify(base), before);
});

test("stripOwnChoices keeps a machine's added package out of the published seed", () => {
  const base = seed();
  // The report is what `capture` reads back from the same function, so taking it
  // from `applyOverlay` is the round trip that has to work, not a hand-written one.
  const { settings, added, removed } = applyOverlay(base, { packages: ["npm:system-one@1.3.4"] });

  const { packages, changes } = stripOwnChoices(settings.packages, { added, removed }, base.packages);

  // The seed must not learn about a package only this machine can run.
  assert.deepEqual(packages.map(pkgName), ["npm:a", "plugins/local-thing", "npm:b"]);
  assert.match(changes.join(" "), /system-one/);
});

test("stripOwnChoices puts back a package this machine removed, so capture cannot delete it", () => {
  const base = seed();
  const { settings, added, removed } = applyOverlay(base, { packagesRemove: ["npm:b@2.0.0"] });

  const { packages } = stripOwnChoices(settings.packages, { added, removed }, base.packages);

  assert.deepEqual(packages.map(pkgName), ["npm:a", "plugins/local-thing", "npm:b"]);
  // Restored as the seed's own entry, so the published version is the pinned one
  // rather than a bare name that would unpin it.
  assert.equal(packages.at(-1), "npm:b@2.0.0");
});

test("a removal of something the seed never had is not published as an addition", () => {
  const base = seed();
  const { settings, added, removed } = applyOverlay(base, { packagesRemove: ["npm:not-in-seed"] });

  const { packages, changes } = stripOwnChoices(settings.packages, { added, removed }, base.packages);

  assert.deepEqual(packages.map(pkgName), ["npm:a", "plugins/local-thing", "npm:b"]);
  assert.deepEqual(changes, []);
});

test("stripOwnChoices is a no-op without an overlay", () => {
  const base = seed();
  const { packages, changes } = stripOwnChoices(base.packages, { added: [], removed: [] });

  assert.deepEqual(packages, base.packages);
  assert.deepEqual(changes, []);
});

test("--json reports the machine's own choices without writing anything", () => {
  const repo = sandbox();
  const home = sandbox();
  fs.mkdirSync(path.join(repo, "dot-pi/agent"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "dot-pi/agent/settings.local.json"),
    JSON.stringify({ packages: ["npm:system-one@1.3.4"], packagesRemove: ["npm:b@2.0.0"] }),
  );
  const livePath = path.join(home, ".pi/agent/settings.json");
  fs.writeFileSync(livePath, JSON.stringify(seed(), null, 2) + "\n");
  const before = fs.readFileSync(livePath, "utf8");

  const out = execFileSync(process.execPath, [modulePath, "--repo", repo, "--home", home, "--json"], {
    encoding: "utf8",
  });

  assert.deepEqual(JSON.parse(out), { added: ["npm:system-one"], removed: ["npm:b"] });
  // Reporting is what capture calls; it must be read-only.
  assert.equal(fs.readFileSync(livePath, "utf8"), before);
});

test("applying writes the merged file, and says what it changed", () => {
  const repo = sandbox();
  const home = sandbox();
  fs.mkdirSync(path.join(repo, "dot-pi/agent"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "dot-pi/agent/settings.local.json"),
    JSON.stringify({ defaultThinkingLevel: "low" }),
  );
  const livePath = path.join(home, ".pi/agent/settings.json");
  fs.writeFileSync(livePath, JSON.stringify(seed(), null, 2) + "\n");

  const out = execFileSync(process.execPath, [modulePath, "--repo", repo, "--home", home], {
    encoding: "utf8",
  });

  assert.match(out, /applied/);
  assert.equal(JSON.parse(fs.readFileSync(livePath, "utf8")).defaultThinkingLevel, "low");
});

test("a machine with no overlay is left exactly as it is", () => {
  const repo = sandbox();
  const home = sandbox();
  fs.mkdirSync(path.join(home, ".pi/agent"), { recursive: true });
  const livePath = path.join(home, ".pi/agent/settings.json");
  fs.writeFileSync(livePath, JSON.stringify(seed(), null, 2) + "\n");
  const before = fs.readFileSync(livePath, "utf8");

  const out = execFileSync(process.execPath, [modulePath, "--repo", repo, "--home", home], {
    encoding: "utf8",
  });

  assert.match(out, /skip/);
  assert.equal(fs.readFileSync(livePath, "utf8"), before);
});

test("--strip is what capture publishes with, so it must undo the machine's choices", () => {
  const repo = sandbox();
  fs.mkdirSync(path.join(repo, "dot-pi/agent"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "dot-pi/agent/settings.local.json"),
    JSON.stringify({ packages: ["npm:system-one@1.3.4"], packagesRemove: ["npm:b@2.0.0"] }),
  );
  // What capture holds: the live list (baseline + system-one - b) and the seed's.
  const input = {
    packages: ["npm:a@1.0.0", "plugins/local-thing", "npm:system-one@1.3.4"],
    seed: seed().packages,
  };

  const out = execFileSync(process.execPath, [modulePath, "--repo", repo, "--strip"], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  const result = JSON.parse(out);

  assert.deepEqual(result.packages.map(pkgName), ["npm:a", "plugins/local-thing", "npm:b"]);
  assert.equal(result.packages.at(-1), "npm:b@2.0.0");
});
