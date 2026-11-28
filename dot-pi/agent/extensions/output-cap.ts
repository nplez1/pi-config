/**
 * output-cap.ts — bound how many bytes of tool output a session carries.
 *
 * Measured over one 12-hour session: 1.0 MB of tool output, 40% of all calls inspection.
 * The two largest single results were 46 KB and 45 KB, and a 27 KB file read was carried
 * for 378 turns — roughly 4M token-turns — and never used before compaction. Pi has no
 * byte cap, so every one of those bytes is re-sent on every request until the context is
 * compacted, which is the most expensive way to store a fact nobody read.
 *
 * So a result over the cap is cut on a line boundary and the full text goes to a spill
 * file the model can read back if it actually needs it. The note says what to do instead
 * (`rg -n`, `jq`, `cut -c1-200`), because the cap is a prompt to ask a narrower question,
 * not a wall: nothing is lost, only moved out of the context.
 *
 * Deliberate limits:
 *
 *   - Only `bash` and `read`, the two tools that produce unbounded text.
 *   - An image or any non-text block is carried through untouched, in its original order.
 *   - A result already under the cap is not touched at all.
 *   - A result is never cut to nothing: the head of the first text block always survives.
 *   - Config is read per call, so `/output-cap` style edits apply on the next result.
 *
 * Config: `~/.config/pi-output-cap/config.json` (`PI_OUTPUT_CAP_CONFIG` overrides the path).
 *
 *   { "enabled": true, "maxBytes": 8192 }
 *
 * Everything above the handler is a pure function over (content, cap) so `node --test` can
 * exercise it without a session; the only import is type-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 8 KB: roughly the point where a result stops being read and starts being carried. */
export const DEFAULT_MAX_BYTES = 8 * 1024;

/** The two tools that produce unbounded text; everything else is left alone. */
const CAPPED_TOOLS = new Set(["bash", "read"]);

export interface OutputCapConfig {
  enabled: boolean;
  maxBytes: number;
}

/** Resolved per call, and overridable, so a test never reads the machine's real config. */
export function configPath(): string {
  return process.env.PI_OUTPUT_CAP_CONFIG || join(homedir(), ".config", "pi-output-cap", "config.json");
}

export function resolveConfig(raw: unknown): OutputCapConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const maxBytes =
    typeof source.maxBytes === "number" && Number.isFinite(source.maxBytes) && source.maxBytes > 0
      ? Math.floor(source.maxBytes)
      : DEFAULT_MAX_BYTES;
  return { enabled: source.enabled !== false, maxBytes };
}

/** Read fresh on every result: a bad or missing file falls back to the defaults. */
export function loadConfig(path: string = configPath()): OutputCapConfig {
  try {
    return resolveConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return resolveConfig(null);
  }
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Index in `text` where one more character would pass `maxBytes` of UTF-8. */
function codeUnitCut(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index);
    if (code === undefined) {
      break;
    }
    const size = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    index += code > 0xffff ? 2 : 1;
  }
  return index;
}

/**
 * Cut to the cap on a line boundary, so a truncated result ends on a whole line rather
 * than mid-token. A first line longer than the cap is cut mid-line: a minified blob is
 * still better than nothing.
 */
export function truncateText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  const cut = codeUnitCut(text, maxBytes);
  if (cut === 0) {
    const code = text.codePointAt(0) ?? 0;
    return text.slice(0, code > 0xffff ? 2 : 1);
  }
  const newline = text.lastIndexOf("\n", cut - 1);
  return newline > 0 ? text.slice(0, newline) : text.slice(0, cut);
}

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export type CapPlan =
  | { action: "keep" }
  | {
      action: "truncate";
      /** Blocks to keep, in their original order, with the text budget applied. */
      content: ContentBlock[];
      /** Every text block's content, joined as the spill file writes it. */
      fullText: string;
      originalBytes: number;
      keptBytes: number;
    };

function textOf(block: ContentBlock): string | null {
  return block.type === "text" && typeof block.text === "string" ? block.text : null;
}

/**
 * Decide whether a result needs capping and what survives. The budget is shared across
 * text blocks in order, mirroring how the joined text is measured, so a result with two
 * text blocks is capped at the same total as one with a single block.
 */
export function planCap(content: readonly ContentBlock[], maxBytes: number): CapPlan {
  const texts = content.map(textOf).filter((text): text is string => text !== null);
  const fullText = texts.join("\n");
  const originalBytes = byteLength(fullText);
  if (originalBytes <= maxBytes) {
    return { action: "keep" };
  }

  let budget = maxBytes;
  let keptBytes = 0;
  let keptBlocks = 0;
  const kept: ContentBlock[] = [];
  for (const block of content) {
    const text = textOf(block);
    if (text === null) {
      kept.push(block);
      continue;
    }
    if (budget <= 0) {
      continue;
    }
    const room = keptBlocks === 0 ? budget : budget - 1;
    const trimmed = truncateText(text, room);
    if (trimmed.length === 0) {
      continue;
    }
    budget -= byteLength(trimmed) + (keptBlocks === 0 ? 0 : 1);
    keptBytes += byteLength(trimmed);
    keptBlocks += 1;
    kept.push({ ...block, text: trimmed });
  }

  return { action: "truncate", content: kept, fullText, originalBytes, keptBytes };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

/** The note the model reads instead of the bytes it did not get. */
export function renderCapNote(originalBytes: number, keptBytes: number, spillPath: string | null): string {
  const where = spillPath ? `full output: ${spillPath}. ` : "";
  return (
    `[output-cap] truncated ${formatBytes(originalBytes)} to ${formatBytes(keptBytes)} — ${where}` +
    `Prefer a narrower command (rg -n, jq, cut -c1-200) or read the spill file.`
  );
}

/** A fresh directory per spill, so concurrent sessions can never write the same file. */
export function writeSpill(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-output-cap-"));
  const path = join(dir, "output.txt");
  writeFileSync(path, text, "utf8");
  return path;
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", (event) => {
    if (!CAPPED_TOOLS.has(event.toolName)) {
      return undefined;
    }
    const config = loadConfig();
    if (!config.enabled) {
      return undefined;
    }

    const plan = planCap(event.content as ContentBlock[], config.maxBytes);
    if (plan.action === "keep") {
      return undefined;
    }

    // A result the model can read beats a result lost to a failed write.
    let spillPath: string | null = null;
    try {
      spillPath = writeSpill(plan.fullText);
    } catch {
      spillPath = null;
    }

    const note = renderCapNote(plan.originalBytes, plan.keptBytes, spillPath);
    const content = [...plan.content];
    const last = content.at(-1);
    if (last && last.type === "text") {
      content[content.length - 1] = { ...last, text: `${last.text}\n\n${note}` };
    } else {
      content.push({ type: "text", text: note });
    }
    return { content: content as typeof event.content };
  });
}
