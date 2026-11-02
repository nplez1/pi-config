#!/usr/bin/env node
// Re-derives `TOKEN_MIX` in deepseek-schedule.ts from this machine's own
// transcripts. The provider comparison is only as good as that weighting, and
// the weighting drifts with how the machine is used — so this prints the
// measurement next to the constants currently in the source, so a maintainer
// can see whether they still agree.
//
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs --since 2026-10-01
//   node dot-pi/agent/extensions/shared/measure-token-mix.mjs --provider deepinfra
//
// DeepSeek-only sessions are the baseline on purpose: DeepInfra re-reads more
// of the prompt as cache misses, so its transcripts would inflate the input
// share and quietly make DeepInfra look cheaper than it is. `--provider` is how
// you measure the other side, which is how DEEPINFRA_INPUT_MULTIPLIER was
// derived — compare the two "input misses per cache read" figures.
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
    if ((message.timestamp ?? 0) < Date.parse(SINCE)) continue;
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
  console.error(`no assistant messages for provider "${PROVIDER}" since ${SINCE}`);
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

console.log(`provider ${PROVIDER}${MODEL ? ` model ${MODEL}` : ""}, since ${SINCE}`);
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
  console.log("    DeepInfra's figure goes in DEEPINFRA_INPUT_MULTIPLIER; run again with --provider deepinfra.");
}
