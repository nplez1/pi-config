#!/usr/bin/env node
// Re-derives `TOKEN_MIX` in deepseek-schedule.ts from this machine's own
// transcripts. The provider comparison is only as good as that weighting, and
// the weighting drifts with how the machine is used — so this prints the
// measurement, to be compared by hand with the constants in the source.
//
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs --since 2026-10-14 --until 2026-11-01T09:00Z
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs --provider deepinfra
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs --penalty
//
// `--since` / `--until` are parsed by `Date.parse`, so a date-time without a
// trailing `Z` is read as LOCAL time. Pass the `Z` when the window is a UTC
// boundary, as the TOKEN_MIX provenance is.
//
// Session transcripts live at `sessions/<mangled-cwd>/<session>.jsonl`, so the
// scan is one level of directories deep — the layout, not a limit.
//
// DeepSeek-only sessions are the baseline on purpose: the input share this
// prints is what `TOKEN_MIX` holds, and DeepInfra's extra re-reads are priced
// separately by `CACHE_BANDS`. Measuring the mix on DeepInfra
// traffic instead would count that penalty twice. `--provider` is how you
// measure the other side; `--penalty` is the report that derives the table.
//
// The first request on a provider after the router switched costs a full cache
// miss, and that is an artefact of routing, not of the provider's cache. Those
// turns are dropped, so what is left is steady-state behaviour on each side.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const SESSIONS = join(homedir(), ".pi", "agent", "sessions");
const PROVIDER = flag("provider", "deepseek");
const SINCE = flag("since", "1970-01-01");
const UNTIL = flag("until", "9999-12-31");

/** `message.timestamp` is epoch ms here; tolerate an ISO string if it ever is not. */
function timestampOf(message) {
  const raw = message.timestamp;
  if (typeof raw === "number") return raw;
  const parsed = Date.parse(String(raw ?? ""));
  if (Number.isNaN(parsed)) {
    console.error(`unreadable message timestamp: ${String(raw)}`);
    process.exit(1);
  }
  return parsed;
}
// The router swaps between these two checkpoints, so those are the defaults.
const MODEL = flag(
  "model",
  PROVIDER === "deepseek" ? "deepseek-flash" : "deepseek-ai/DeepSeek-V4.1-Flash-1017",
);
/** Sessions shorter than this are mostly first-turn cache misses, not usage. */
const MIN_SESSION_MESSAGES = Number(flag("min-messages", 60));

/** Assistant messages with usage, in order, for one session file. */
async function sessionMessages(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message?.role !== "assistant" || !message.usage) continue;
    out.push(message);
  }
  return out;
}

async function* sessionFiles(root) {
  let dirs;
  try {
    dirs = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(root, dir.name));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith(".jsonl")) yield join(root, dir.name, file);
    }
  }
}

/** The two checkpoints the router swaps between, for the `--penalty` report. */
const ROUTED = new Set(["deepseek", "deepinfra"]);

/**
 * Re-derives `CACHE_BANDS` in deepseek-schedule.ts: how much more of
 * the prompt DeepInfra re-bills as cache misses than DeepSeek does, as a
 * function of CONTEXT SIZE.
 *
 * Only turns whose previous turn was under a minute away are counted, so
 * elapsed time cannot be the explanation — what is left is the provider's cache
 * holding up as the context grows, which is the thing the table prices.
 */
async function penaltyReport() {
  const BANDS = [
    [0, 65_000],
    [65_000, 131_000],
    [131_000, 262_000],
    [262_000, 524_000],
    [524_000, Number.POSITIVE_INFINITY],
  ];
  const blank = () => BANDS.map(() => ({ turns: 0, input: 0, cacheRead: 0 }));
  const acc = { deepseek: blank(), deepinfra: blank() };

  for await (const path of sessionFiles(SESSIONS)) {
    const messages = await sessionMessages(path);
    const ordered = messages
      .map((message) => ({ message, at: timestampOf(message) }))
      .sort((a, b) => a.at - b.at);
    for (let k = 1; k < ordered.length; k += 1) {
      const { message: current, at } = ordered[k];
      const previous = ordered[k - 1];
      if (!ROUTED.has(current.provider)) continue;
      // A provider switch starts cold; that miss is the router's, not the cache's.
      if (previous.message.provider !== current.provider) continue;
      if (at - previous.at >= 60_000) continue;
      const prompt = (current.usage.input ?? 0) + (current.usage.cacheRead ?? 0);
      if (prompt <= 0) continue;
      const index = BANDS.findIndex(([lo, hi]) => prompt >= lo && prompt < hi);
      if (index < 0) continue;
      const bucket = acc[current.provider][index];
      bucket.turns += 1;
      bucket.input += current.usage.input ?? 0;
      bucket.cacheRead += current.usage.cacheRead ?? 0;
    }
  }

  const perRead = (bucket) => (bucket.input > 0 ? bucket.cacheRead / bucket.input : Number.NaN);
  console.log("cache misses per cache read, warm turns only (<60s since the previous turn)");
  console.log("\nprompt size      DeepSeek            DeepInfra           ratio");
  const rows = [];
  BANDS.forEach(([lo, hi], index) => {
    const ds = perRead(acc.deepseek[index]);
    const di = perRead(acc.deepinfra[index]);
    const ratio = di > 0 && ds > 0 ? 1 / di / (1 / ds) : Number.NaN;
    const label = hi === Number.POSITIVE_INFINITY ? `${lo / 1000}K+` : `${lo / 1000}K-${hi / 1000}K`;
    const cell = (value, bucket) =>
      bucket.turns === 0 ? "—" : `1 per ${Math.round(value)} (${bucket.turns})`;
    console.log(
      `${label.padEnd(16)}  ${cell(ds, acc.deepseek[index]).padEnd(19)} ${cell(di, acc.deepinfra[index]).padEnd(19)} ${Number.isNaN(ratio) ? "—" : `${ratio.toFixed(2)}x`}`,
    );
    rows.push({ label, ratio, deepseekMiss: ds > 0 ? 1 / (ds + 1) : Number.NaN });
  });
  console.log("\nCACHE_BANDS for deepseek-schedule.ts:");
  for (const row of rows) {
    const miss = Number.isNaN(row.deepseekMiss) ? "?" : row.deepseekMiss.toFixed(6);
    const ratio = Number.isNaN(row.ratio) ? "?" : row.ratio.toFixed(2);
    console.log(`  { upTo: ${row.label}, deepseekMiss: ${miss}, ratio: ${ratio} },`);
  }
  console.log("\nA band with few turns is indicative, not measured — check the counts.");
}

if (args.includes("--penalty")) {
  await penaltyReport();
  process.exit(0);
}

const totals = { input: 0, cacheRead: 0, output: 0, messages: 0 };
/** input misses per cache read, per session — the cache-efficiency figure. */
const perSession = [];
let droppedSwitchMisses = 0;

for await (const path of sessionFiles(SESSIONS)) {
  const messages = await sessionMessages(path);
  const bucket = { input: 0, cacheRead: 0, messages: 0 };
  let previousProvider;
  for (const message of messages) {
    // A turn that changed provider starts cold; that miss is the router's
    // doing, so it must not be attributed to the provider's cache.
    const switched = previousProvider !== undefined && message.provider !== previousProvider;
    previousProvider = message.provider;
    if (message.provider !== PROVIDER) continue;
    if (MODEL && message.model !== MODEL) continue;
    const at = timestampOf(message);
    if (at < Date.parse(SINCE) || at > Date.parse(UNTIL)) continue;
    if (switched) {
      droppedSwitchMisses += 1;
      continue;
    }
    const { input = 0, cacheRead = 0, output = 0 } = message.usage;
    bucket.input += input;
    bucket.cacheRead += cacheRead;
    bucket.messages += 1;
    totals.input += input;
    totals.cacheRead += cacheRead;
    totals.output += output;
    totals.messages += 1;
  }
  if (bucket.messages > 0) perSession.push(bucket);
}

if (totals.messages === 0) {
  console.error(`no assistant messages for provider "${PROVIDER}" between ${SINCE} and ${UNTIL}`);
  process.exit(1);
}

const total = totals.input + totals.cacheRead + totals.output;
const mix = {
  input: totals.input / total,
  cacheRead: totals.cacheRead / total,
  output: totals.output / total,
};

// DeepSeek's off-peak card, only to show what the token shares mean in dollars.
const card = { input: 0.15, cacheRead: 0.003, output: 0.6 };
const spend = {
  input: mix.input * card.input,
  cacheRead: mix.cacheRead * card.cacheRead,
  output: mix.output * card.output,
};
const spendTotal = spend.input + spend.cacheRead + spend.output;

const ratios = perSession
  .filter((b) => b.messages >= MIN_SESSION_MESSAGES && b.cacheRead > 0)
  .map((b) => b.input / b.cacheRead)
  .sort((a, b) => a - b);
const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : Number.NaN;

const pct = (n) => `${(n * 100).toFixed(2)}%`;
const fixed = (n) => n.toFixed(5);

console.log(`provider ${PROVIDER}${MODEL ? ` model ${MODEL}` : ""}, ${SINCE} .. ${UNTIL}`);
console.log(`  ${totals.messages.toLocaleString()} assistant messages, ${total.toLocaleString()} tokens`);
console.log(`  input misses ${totals.input.toLocaleString()}  cache reads ${totals.cacheRead.toLocaleString()}  output ${totals.output.toLocaleString()}`);
console.log(`  ${droppedSwitchMisses.toLocaleString()} post-switch turns dropped`);
console.log("");
console.log("  TOKEN_MIX (token shares — what the source should hold):");
console.log(`    input: ${fixed(mix.input)},`);
console.log(`    cacheRead: ${fixed(mix.cacheRead)},`);
console.log(`    output: ${fixed(mix.output)},`);
console.log("");
console.log("  spend shares on DeepSeek's off-peak card (what to reason with):");
console.log(`    input ${pct(spend.input / spendTotal)}  cacheRead ${pct(spend.cacheRead / spendTotal)}  output ${pct(spend.output / spendTotal)}`);
console.log("");
console.log(`  cache efficiency over ${ratios.length} sessions of >=${MIN_SESSION_MESSAGES} messages:`);
console.log(`    median ${median.toFixed(4)} input misses per cache read = 1 per ${Math.round(1 / median)}`);
if (PROVIDER === "deepseek") {
  console.log("    This is the baseline `TOKEN_MIX` holds. For the DeepInfra cache penalty,");
  console.log("    run with --penalty, which buckets by prompt size.");
}
