// Guards the single-discovery-entry invariant, see ../fast-search.js.
//
// Pi discovers `extensions/<name>.js`, and also `extensions/<name>/` when that
// directory has an `index.js`, an `index.ts` or a package.json `pi.extensions`
// entry. Pi 1.5.1 and later discover symlinked directories as well as symlinked
// files, so an entry inside the directory made 1.5.1+ load the extension twice:
// two session_start handlers and two registrations of the same tools. Keeping
// the entry in `index.mjs` leaves the directory undiscoverable on every version.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.dirname(here);
const shim = path.join(path.dirname(extensionDir), "fast-search.js");

test("the extension directory has no file or manifest Pi would discover as an entry", () => {
  const names = readdirSync(extensionDir);
  assert.ok(names.includes("index.mjs"), "the implementation stays in index.mjs");
  assert.ok(!names.includes("index.js"), "index.js would make the directory a second discovery entry");
  assert.ok(!names.includes("index.ts"), "index.ts would make the directory a second discovery entry");
  assert.ok(!names.includes("package.json"), "a package.json here could declare a second discovery entry");
});

test("the file shim is the only discovery entry and targets index.mjs", () => {
  const text = readFileSync(shim, "utf-8");
  const exports = text.split("\n").filter((line) => line.startsWith("export "));
  assert.deepEqual(exports, ["export { default } from './fast-search/index.mjs';"]);
});
