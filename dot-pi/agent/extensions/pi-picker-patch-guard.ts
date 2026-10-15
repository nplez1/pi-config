/**
 * Model-picker patch guard
 *
 * `patches/model-picker.mjs` in this repo patches pi's *own* bundle (the chunk
 * that defines the /model picker), because the extension API cannot replace the
 * built-in picker. A pi install/update overwrites that file, which used to mean
 * the patch silently disappeared until someone noticed.
 *
 * This guard closes that loop: at the start of every TUI session it checks the
 * patch cheaply (a recorded chunk size/mtime, falling back to a real check) and
 * re-applies it when missing, telling you to restart pi so the new bundle is
 * loaded.
 *
 *   /picker-patch          check and apply now, with details
 *   PI_PICKER_PATCH=off    never write; still warn when the patch is missing
 *   PI_PICKER_PATCH_SCRIPT override the applier path
 *   PI_PICKER_PATCH_DEBUG=1 append decisions to $TMPDIR/picker-guard-debug.log
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The applier lives in the pi-config checkout. Extensions are symlinked into
 * ~/.pi/agent/extensions, so resolve through both the real path and the
 * symlinked one before falling back to the default checkout location.
 */
function findApplier(): string | undefined {
  const candidates = [
    process.env.PI_PICKER_PATCH_SCRIPT,
    path.resolve(HERE, "../../../patches/model-picker.mjs"),
    path.join(os.homedir(), "Code/pi-config/patches/model-picker.mjs"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate));
}

interface PatchState {
  chunk?: string;
  size?: number;
  mtimeMs?: number;
}

/** Fast path: the applier records the patched chunk's size and mtime. */
function stateIsCurrent(): boolean {
  const applier = findApplier();
  if (!applier) return true; // nothing we can do; do not nag without a reason
  const statePath = path.join(path.dirname(applier), ".state.json");
  try {
    const state: PatchState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (!state.chunk) return false;
    const stat = fs.statSync(state.chunk);
    return stat.size === state.size && stat.mtimeMs === state.mtimeMs;
  } catch {
    return false;
  }
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

function runApplier(args: string[]): Result {
  const applier = findApplier();
  if (!applier) return { code: 127, stdout: "", stderr: "patches/model-picker.mjs not found" };
  try {
    const stdout = execFileSync(process.execPath, [applier, ...args], {
      encoding: "utf8",
      timeout: 120_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? failure.message ?? String(error),
    };
  }
}

export default function (pi: ExtensionAPI) {
  // The applier smoke-tests the patched bundle by launching `pi --version`;
  // never let that child run this guard.
  if (process.env.PI_MODEL_PICKER_VERIFY === "1") return;

  const check = (): number => runApplier(["--check", "--quiet"]).code;

  const debug = (event: string, data: Record<string, unknown> = {}) => {
    if (process.env.PI_PICKER_PATCH_DEBUG !== "1") return;
    try {
      fs.appendFileSync(
        path.join(os.tmpdir(), "picker-guard-debug.log"),
        `${JSON.stringify({ event, pid: process.pid, ...data })}\n`,
      );
    } catch {}
  };

  pi.on("session_start", (_event, ctx) => {
    debug("session_start", {
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      current: stateIsCurrent(),
      // Set by the appended block in the bundle we are running right now: false
      // means this process still has the old bundle (restart pi).
      blockInstalled: (globalThis as { __piPickerPatchInstalled?: boolean }).__piPickerPatchInstalled === true,
    });
    if (process.env.PI_PICKER_PATCH === "off") return;
    if (ctx.mode !== "tui") return;
    if (stateIsCurrent()) return;
    debug("checking", { applier: findApplier() });
    if (check() === 0) return;

    const result = runApplier(["--quiet"]);
    debug("applied", { code: result.code, stderr: result.stderr.slice(0, 300) });
    if (result.code === 0) {
      ctx.ui.notify("Model-picker patch re-applied after the pi update — restart pi to activate it.", "warning");
    } else {
      ctx.ui.notify(
        `Model-picker patch could not be re-applied: ${result.stderr.trim().split("\n")[0] || "unknown error"}`,
        "error",
      );
    }
  });

  pi.registerCommand("picker-patch", {
    description: "Check and re-apply the local model-picker patch to installed pi",
    handler: async (_args, ctx) => {
      if (stateIsCurrent() && check() === 0) {
        ctx.ui.notify("Model-picker patch is applied and current.", "info");
        return;
      }
      const result = runApplier(["--quiet"]);
      if (result.code === 0) {
        ctx.ui.notify("Model-picker patch applied — restart pi to activate it.", "warning");
        return;
      }
      ctx.ui.notify(`Model-picker patch failed: ${result.stderr.trim()}`, "error");
    },
  });
}
