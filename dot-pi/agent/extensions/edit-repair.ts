/**
 * edit-repair.ts — turn a failed `edit` into the correction the agent needs, in the result.
 *
 * Failed edits are the most expensive recoverable error in the loop: the edit writes
 * nothing, so the next turn is always spent rebuilding the picture (usually a fresh
 * `read`) before the retry. Measured across this machine's sessions: 579 failed edits
 * out of 8,565 (6.8%), with 882 `edit -> read` recoveries in the transition graph.
 *
 * Classifying those 579 by their error text rather than by guesswork:
 *
 *   - ~52% "Found 2 occurrences of edits[N]" — the model wrote an `oldText` that matches
 *     twice. Nothing is stale; it simply lacks the surrounding context that would pick
 *     one. The fix is the two locations, each with a ready-made unique `oldText`.
 *   - ~49% "Could not find edits[N] / the exact text" — the block moved or drifted. The
 *     fix is the closest actual text in the file plus the lines that no longer match.
 *   - a few "overlap" (the model sent intersecting ranges) and "No changes made".
 *
 * So this handler does not guess and does not apply anything. pi's own edit tool already
 * tries whitespace- and Unicode-normalised matching, so a miss here means the text really
 * did change; silently applying a "close enough" block would corrupt files. What it does
 * instead is make the *retry* turn cheap: it returns the exact current text, the unique
 * anchors, and the specific lines that diverged — everything a re-read would have told the
 * model, without the turn.
 *
 * The one thing it does settle is "No changes made": the file already holds the intended
 * content, so that result becomes a success rather than an error to recover from.
 *
 * Pure helpers over (file text, edits) so `node --test` can exercise them; the only
 * import is type-only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/** Occurrences listed before the diagnostic starts summarising instead. */
const MAX_OCCURRENCES = 4;
/** Context lines shown either side of an occurrence. */
const CONTEXT_LINES = 3;
/** How many whole lines may be added either side when building a unique anchor. */
const MAX_ANCHOR_GROW = 12;
/** Longest anchor worth handing back as a suggestion. */
const MAX_ANCHOR_LINES = 40;
/** Files larger than this are not re-read for diagnostics. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Hard cap on the diagnostic text returned to the model. */
const MAX_OUTPUT_CHARS = 6000;

export interface Edit {
  oldText: string;
  newText: string;
}

/**
 * Normalise a line the way pi's fuzzy matcher does, so "matches except for formatting"
 * is not reported as a difference: trailing whitespace, smart quotes, dashes, and the
 * special Unicode spaces models emit.
 */
export function normalizeLine(line: string): string {
  return line
    .replace(/\r$/, "")
    .replace(/[ \t]+$/, "")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014\u2015]/g, "-")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/^[ \t]+/, "");
}

/** Non-overlapping occurrence offsets, up to `limit`. */
export function findOccurrences(haystack: string, needle: string, limit = MAX_OCCURRENCES + 1): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let from = 0;
  while (found.length < limit) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + 1;
  }
  return found;
}

interface LineIndex {
  lines: string[];
  /** offsets[i] is the character index where line i starts. */
  offsets: number[];
}

export function buildLineIndex(text: string): LineIndex {
  const lines = text.split("\n");
  const offsets: number[] = new Array(lines.length);
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = at;
    at += lines[i].length + 1;
  }
  return { lines, offsets };
}

/** Zero-based line index containing a character offset. */
export function lineAt(index: LineIndex, charOffset: number): number {
  let low = 0;
  let high = index.lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (index.offsets[mid] <= charOffset) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Grow a match outward to the smallest whole-line snippet that occurs exactly once.
 * Returns null when no growth makes it unique — identical twin blocks, where only the
 * model can say which one it meant.
 */
export function uniqueAnchor(text: string, start: number, end: number): string | null {
  const index = buildLineIndex(text);
  const firstLine = lineAt(index, start);
  const lastLine = lineAt(index, Math.max(start, end - 1));
  const snippet = (from: number, to: number) =>
    index.lines.slice(Math.max(0, from), Math.min(index.lines.length - 1, to) + 1).join("\n");
  // A file ending in a newline splits to a final empty element; it is not a content line,
  // so "the anchor swallowed the whole file" must be measured against the last real line.
  const lastContentLine = index.lines.at(-1) === "" ? index.lines.length - 2 : index.lines.length - 1;

  const base = snippet(firstLine, lastLine);
  if (findOccurrences(text, base, 2).length === 1) return base;

  for (let grow = 1; grow <= MAX_ANCHOR_GROW; grow++) {
    // Grow downward first: a trailing unique line (a closing brace, a test assertion)
    // is usually closer to hand than a preceding header comment.
    for (const [from, to] of [
      [firstLine, lastLine + grow],
      [firstLine - grow, lastLine + grow],
    ] as const) {
      if (to - from + 1 > MAX_ANCHOR_LINES) break;
      // An anchor that swallows the whole file is not a hint, it is a rewrite of the
      // file to break a tie. Report the tie as unresolvable instead.
      if (from <= 0 && to >= lastContentLine) continue;
      const candidate = snippet(from, to);
      if (candidate.trim().length === 0) continue;
      if (findOccurrences(text, candidate, 2).length === 1) return candidate;
    }
  }
  return null;
}

export interface ClosestWindow {
  /** Zero-based line where the closest window starts. */
  startLine: number;
  lines: string[];
  /** Share of the needle's lines found in the window, by similarity, 0..1. */
  ratio: number;
  /** Needle lines with no verbatim counterpart in the window (the caller caps the list). */
  missing: string[];
}

/** Dice coefficient over character bigrams: cheap similarity for two lines. */
export function lineSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const gram = a.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  let shared = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const gram = b.slice(i, i + 2);
    const left = grams.get(gram) ?? 0;
    if (left > 0) {
      shared += 1;
      grams.set(gram, left - 1);
    }
  }
  return (2 * shared) / (a.length - 1 + (b.length - 1));
}

/**
 * The window of the file that most resembles `needle`, used when nothing matched.
 *
 * Two passes. A positional scan finds anywhere the block still lines up, which is the
 * common case for a move. When that tops out under half its lines, it anchors on the
 * longest lines of the `oldText` instead: find where the most distinctive line actually
 * lives now, and place the window around it. That is what survives the common real shape
 * of "Could not find the exact text" — a block with a line inserted or an identifier
 * renamed — where positional scoring is defeated by the shift.
 *
 * Scoring inside a candidate window is by best match anywhere in it, so an inserted line
 * costs nothing. Candidates are few, so this stays cheap even on a 5k-line file.
 */
export function closestWindow(fileText: string, needle: string): ClosestWindow | null {
  const needleLines = needle.split("\n").map(normalizeLine);
  // Blank needle lines stay in place so positions line up with the file; they are simply
  // skipped when scoring, because where a blank line falls is not evidence of anything.
  const scored = needleLines.map((line, i) => (line.trim().length > 0 ? i : -1)).filter((i) => i >= 0);
  if (scored.length === 0) return null;
  if (scored.length > 200) return null;

  const fileLines = fileText.split("\n").map(normalizeLine);
  const rawFileLines = fileText.split("\n");
  if (fileLines.length * scored.length > 4_000_000) return null;

  const positional = (score: (windowLine: string, needleLine: string) => number) => {
    let best: { start: number; score: number } | null = null;
    for (const delta of [0, -1, 1, -2, 2]) {
      const size = needleLines.length + delta;
      if (size <= 0 || size > fileLines.length) continue;
      for (let start = 0; start + size <= fileLines.length; start++) {
        let total = 0;
        for (const i of scored) {
          const candidate = fileLines[start + i];
          if (candidate !== undefined) total += score(candidate, needleLines[i]);
        }
        const value = total / scored.length;
        if (!best || value > best.score) best = { start, score: value };
      }
    }
    return best;
  };

  // Anchor candidates: put the window where the two most distinctive needle lines are.
  const anchors: number[] = [];
  const longest = [...scored].sort((a, b) => needleLines[b].length - needleLines[a].length).slice(0, 2);
  for (const i of longest) {
    let bestLine = -1;
    let bestScore = -1;
    for (let f = 0; f < fileLines.length; f++) {
      const value = lineSimilarity(fileLines[f], needleLines[i]);
      if (value > bestScore) {
        bestScore = value;
        bestLine = f;
      }
    }
    if (bestLine >= 0 && bestScore >= 0.5) anchors.push(bestLine - i);
  }

  const starts = new Set<number>();
  const exactBest = positional((candidate, target) => (candidate === target ? 1 : 0));
  if (exactBest) starts.add(exactBest.start);
  const fuzzyBest = exactBest && exactBest.score >= 0.5 ? null : positional(lineSimilarity);
  if (fuzzyBest) starts.add(fuzzyBest.start);
  for (const anchor of anchors) starts.add(anchor);
  if (starts.size === 0) starts.add(0);

  // Bag score: each needle line counts if anything in the window resembles it, so an
  // inserted or reworded line does not drag the whole block down.
  let best: { start: number; size: number; score: number } | null = null;
  for (const start of starts) {
    for (const size of [needleLines.length, needleLines.length + 1, needleLines.length + 2]) {
      const from = Math.max(0, Math.min(start, fileLines.length - size));
      if (size <= 0 || from < 0) continue;
      const window = fileLines.slice(from, from + size);
      if (window.length === 0) continue;
      let total = 0;
      for (const i of scored) {
        let closest = 0;
        for (const line of window) {
          const value = line === needleLines[i] ? 1 : lineSimilarity(line, needleLines[i]);
          if (value > closest) closest = value;
          if (closest === 1) break;
        }
        total += closest;
      }
      const value = total / scored.length;
      const tighter = best !== null && value === best.score && size < best.size;
      if (!best || value > best.score || tighter) best = { start: from, size, score: value };
    }
  }
  if (!best) return null;

  const lines = rawFileLines.slice(best.start, best.start + best.size);
  const normalizedWindow = new Set(lines.map(normalizeLine));
  return {
    startLine: best.start,
    lines,
    ratio: best.score,
    missing: scored.map((i) => needleLines[i]).filter((line) => !normalizedWindow.has(line)),
  };
}

export interface EditMatch {
  index: number;
  /** Character offsets of each occurrence, when the oldText is present. */
  occurrences: number[];
}

/** Where each edit matches now: 0 occurrences, 1, or ambiguous. */
export function matchEdits(fileText: string, edits: Edit[]): EditMatch[] {
  return edits.map((edit, index) => ({
    index,
    occurrences: findOccurrences(fileText, edit.oldText ?? ""),
  }));
}

export interface Overlap {
  a: number;
  b: number;
  aRange: [number, number];
  bRange: [number, number];
}

/** Edit pairs whose ranges intersect, which the tool refuses as a batch. */
export function findOverlaps(fileText: string, edits: Edit[]): Overlap[] {
  const spans = edits.map((edit, index) => {
    const at = findOccurrences(fileText, edit.oldText ?? "", 2);
    return at.length === 1 ? { index, start: at[0], end: at[0] + (edit.oldText?.length ?? 0) } : null;
  });
  const overlaps: Overlap[] = [];
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (!a || !b) continue;
      if (a.start < b.end && b.start < a.end) {
        overlaps.push({ a: a.index, b: b.index, aRange: [a.start, a.end], bRange: [b.start, b.end] });
      }
    }
  }
  return overlaps;
}

export interface DiagnosticInput {
  path: string;
  fileText: string;
  edits: Edit[];
  errorText: string;
}

export interface Diagnostic {
  text: string;
  /** True when the file already holds the intended content: nothing to recover from. */
  alreadyApplied: boolean;
}

function lineLabel(index: LineIndex, charOffset: number): number {
  return lineAt(index, charOffset) + 1;
}

/** Context block for a run of whole lines, marking the matched lines with `>`. */
function renderContext(index: LineIndex, first: number, last: number): string[] {
  const from = Math.max(0, first - CONTEXT_LINES);
  const to = Math.min(index.lines.length - 1, last + CONTEXT_LINES);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    const marker = i >= first && i <= last ? ">" : " ";
    out.push(`  ${marker} ${String(i + 1).padStart(5)} | ${index.lines[i]}`);
  }
  return out;
}

/**
 * Build the replacement text for a failed edit. Never asserts success: the caller keeps
 * `isError` unless `alreadyApplied` says the file is already in the intended state.
 */
export function renderDiagnostic(input: DiagnosticInput): Diagnostic {
  const { path, fileText, edits, errorText } = input;
  const index = buildLineIndex(fileText);
  const original = errorText.trim();

  // "No changes made" means the replacement produced content identical to what is on
  // disk: the desired state already holds. Recovering from it would be pure waste.
  if (/No changes made/i.test(original)) {
    return {
      text:
        `edit had nothing to do: ${path} already contains the intended content ` +
        `(the replacement produced no change). No further edit is needed.\n\n--- original result ---\n${original}`,
      alreadyApplied: true,
    };
  }

  const matches = matchEdits(fileText, edits);
  const overlaps = findOverlaps(fileText, edits);
  const sections: string[] = [];

  sections.push(
    `edit did not apply: nothing was written to ${path}. The text below is the file as it is now, ` +
      `so you can correct the edit without re-reading it.`,
  );

  // Overlaps first: they explain a whole-batch rejection, and the fix applies to the batch.
  if (overlaps.length > 0) {
    const lines = overlaps.map((o) => {
      const aLine = lineLabel(index, o.aRange[0]);
      const bLine = lineLabel(index, o.bRange[0]);
      return `  edits[${o.a}] (line ${aLine}) and edits[${o.b}] (line ${bLine}) matched overlapping text`;
    });
    sections.push(`overlapping edits: merge each pair into one edit with a single merged newText.\n${lines.join("\n")}`);
  }

  for (const match of matches) {
    const edit = edits[match.index];
    if (!edit || typeof edit.oldText !== "string" || edit.oldText.length === 0) continue;

    if (match.occurrences.length === 1) {
      // This one is fine: only report the ones that are not, to keep the message dense.
      continue;
    }

    if (match.occurrences.length > 1) {
      const shown = match.occurrences.slice(0, MAX_OCCURRENCES);
      const parts: string[] = [
        `edits[${match.index}] matches ${match.occurrences.length} places in ${path}. ` +
          `Each is shown below with a unique oldText — resend the edit that means the right one, keeping newText as you had it.`,
      ];
      shown.forEach((at, n) => {
        const end = at + edit.oldText.length;
        parts.push(`\n  occurrence [${n + 1}] starts line ${lineLabel(index, at)}`);
        parts.push(...renderContext(index, lineAt(index, at), lineAt(index, end - 1)));
        const anchor = uniqueAnchor(fileText, at, end);
        if (anchor) {
          parts.push(`  unique oldText for [${n + 1}] (verbatim, ${anchor.split("\n").length} line(s)):`);
          parts.push(...anchor.split("\n").map((l) => `    ${l}`));
        } else {
          parts.push(
            `  no unique oldText exists: the matches are identical blocks. Choose by content that differs elsewhere, or edit each by a broader surrounding block.`,
          );
        }
      });
      if (match.occurrences.length > shown.length) {
        parts.push(`\n  (${match.occurrences.length - shown.length} further occurrences not shown)`);
      }
      sections.push(parts.join("\n"));
      continue;
    }

    // Not found at all: hand back the closest real text and what diverged.
    const closest = closestWindow(fileText, edit.oldText);
    if (!closest) {
      sections.push(
        `edits[${match.index}] was not found in ${path}, and the closest region could not be scored ` +
          `(the oldText is too large or the file too big to scan). Re-read the target region with read and retry.`,
      );
      continue;
    }
    const parts: string[] = [
      `edits[${match.index}] was not found in ${path}. Closest current text starts at line ` +
        `${closest.startLine + 1} (${Math.round(closest.ratio * 100)}% of its lines match positionally) — ` +
        `copy the exact text from here rather than reconstructing it:`,
    ];
    parts.push(
      ...renderContext(index, closest.startLine, closest.startLine + closest.lines.length - 1),
    );
    if (closest.missing.length > 0) {
      const shown = closest.missing.slice(0, 5);
      parts.push(`  lines in your oldText that are not in this region verbatim:`);
      parts.push(...shown.map((l) => `    - ${l}`));
      if (closest.missing.length > shown.length) parts.push(`    (+${closest.missing.length - shown.length} more)`);
    }
    sections.push(parts.join("\n"));
  }

  if (sections.length === 1) {
    // Every edit matched exactly once, so the failure came from something else (a
    // permission problem, a concurrent writer). Do not invent a cause.
    sections.push(
      `every oldText matches exactly once now, so the rejection was not a text mismatch. ` +
        `Check the original result below before retrying.`,
    );
  }

  let text = `${sections.join("\n\n")}\n\n--- original result ---\n${original}`;
  if (text.length > MAX_OUTPUT_CHARS) text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n… [diagnostic truncated]`;
  return { text, alreadyApplied: false };
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "edit" || !event.isError) return undefined;
    const input = event.input as { path?: unknown; edits?: unknown };
    const path = typeof input?.path === "string" ? input.path : "";
    const edits = Array.isArray(input?.edits) ? (input.edits as Edit[]) : [];
    if (!path || edits.length === 0) return undefined;

    const errorText = event.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("\n");

    const absolute = isAbsolute(path) ? path : resolve(ctx.cwd, path);
    let fileText: string;
    try {
      fileText = await readFile(absolute, "utf8");
    } catch {
      // The file is gone or unreadable (a pruned worktree, a bad path). Say so plainly
      // instead of pretending to diagnose a mismatch.
      return {
        content: [
          {
            type: "text",
            text: `${errorText.trim()}\n\n[edit-repair] ${path} could not be read back (${absolute}), so the closest-matching text is unavailable. The path may be wrong or the file gone — check it before retrying.`,
          },
        ],
      };
    }
    if (fileText.length > MAX_FILE_BYTES) return undefined;
    if (ctx.signal?.aborted) return undefined;

    const diagnostic = renderDiagnostic({ path, fileText, edits, errorText });
    return {
      content: [{ type: "text", text: diagnostic.text }],
      isError: !diagnostic.alreadyApplied,
    };
  });
}
