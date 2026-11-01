// deepseek-pricing.ts
//
// DeepSeek bills two rate tiers by time of day (peak = 2x off-peak), and pi's
// built-in model catalog stores ONE static rate per field, so pi cannot model
// this itself. This extension rewrites usage.cost per message at message_end,
// using the message's own timestamp to pick peak vs off-peak rates. Session
// totals are summed from stored message costs, so correcting here makes the
// footer, /session, and RPC totals accurate.
//
// The schedule and the rate card live in shared/deepseek-schedule.ts, together
// with the provider/model ids that deepseek-routing.ts swaps between — one
// source of truth, so a message can never be priced at a tier the router did
// not use.
//
// Complemented by a static off-peak cost override in ~/.pi/agent/models.json,
// which keeps the in-flight streaming estimate (before message_end fires) and
// the /model picker display on realistic numbers.
//
// DeepInfra requests are deliberately untouched: that provider bills a flat
// rate (with a live discount), so its cost comes from the model registration
// in deepseek-routing.ts and is already correct when the message lands.
//
// The footer tier indicator ("peak", "off-peak", "peak → DeepInfra") is
// published by deepseek-routing.ts, which owns that decision; this file stays
// a pure cost corrector.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CACHE_WRITE_RATE, RATES, isPeak } from "./shared/deepseek-schedule";

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event) => {
    const msg = event.message;
    if (msg.role !== "assistant") return;
    if (msg.provider !== "deepseek") return;
    const rates = RATES[msg.model];
    if (!rates || !msg.usage) return;

    const peak = isPeak(msg.timestamp);
    const basis = peak ? rates.peak : rates.offPeak;
    const { input, output, cacheRead, cacheWrite } = msg.usage;

    const cost = {
      input: (basis.input / 1e6) * input,
      output: (basis.output / 1e6) * output,
      cacheRead: (basis.cacheRead / 1e6) * cacheRead,
      cacheWrite: (CACHE_WRITE_RATE / 1e6) * cacheWrite,
      total: 0,
    };
    cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;

    return {
      message: {
        ...msg,
        usage: { ...msg.usage, cost },
      },
    };
  });
}
