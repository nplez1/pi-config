// Compatibility primitives for Pi-Bolt's native find/grep walker (Pi 1.4 and 1.5).
// This module intentionally has no Pi, TypeBox, or executable dependencies.
import { constants as fsConstants, closeSync, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const NATIVE_COMPAT_VERSIONS = Object.freeze(["1.4.0", "1.5.0"]);
export const MAX_RULE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_BRACE_EXPANSIONS = 1024;
const MAX_BRACE_DEPTH = 256;
const MAX_GENERIC_GLOB_LENGTH = 1024;
const MAX_GLOB_STEPS = 65_536;

export class CannotProveParityError extends Error {
  constructor(message, options) {
    super(`cannot prove parity: ${message}`, options);
    this.name = "CannotProveParityError";
  }
}

/** Require callers that know the installed native version to gate this helper. */
export function assertNativeVersion(version) {
  if (!NATIVE_COMPAT_VERSIONS.includes(version)) {
    throw new CannotProveParityError(`supported Pi native versions are ${NATIVE_COMPAT_VERSIONS.join(", ")}; got ${String(version)}`);
  }
  return true;
}

function cannot(message, cause) {
  throw new CannotProveParityError(message, cause === undefined ? undefined : { cause });
}

function expandBraces(pattern, limit = MAX_BRACE_EXPANSIONS, expansionDepth = 0) {
  if (limit < 1) cannot(`glob braces expand beyond ${MAX_BRACE_EXPANSIONS} patterns`);
  if (expansionDepth > MAX_BRACE_DEPTH) cannot(`glob brace nesting exceeds ${MAX_BRACE_DEPTH} levels`);
  let depth = 0;
  let open = -1;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
    } else if (c === "{") {
      if (depth === 0) open = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0) {
        const parts = [];
        let start = open + 1;
        let inner = 0;
        for (let j = open + 1; j < i; j++) {
          const d = pattern[j];
          if (d === "\\") j++;
          else if (d === "{") inner++;
          else if (d === "}") inner--;
          else if (d === "," && inner === 0) {
            parts.push(pattern.slice(start, j));
            start = j + 1;
          }
        }
        parts.push(pattern.slice(start, i));
        if (parts.length < 2) continue;
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        const expanded = [];
        for (const part of parts) {
          expanded.push(...expandBraces(`${head}${part}${tail}`, limit - expanded.length, expansionDepth + 1));
        }
        return expanded;
      }
    }
  }
  return [pattern];
}

function matchClass(pattern, start, char) {
  let i = start + 1;
  const negated = pattern[i] === "!" || pattern[i] === "^";
  if (negated) i++;
  let matched = false;
  let first = true;
  while (i < pattern.length && (pattern[i] !== "]" || first)) {
    first = false;
    let low = pattern[i];
    if (low === "\\" && i + 1 < pattern.length) low = pattern[++i];
    let high = low;
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      high = pattern[i + 2] === "\\" && i + 3 < pattern.length ? pattern[i + 3] : pattern[i + 2];
      i += pattern[i + 2] === "\\" ? 3 : 2;
    }
    if (char >= low && char <= high) matched = true;
    i++;
  }
  if (i >= pattern.length) return undefined;
  return { matched: matched !== negated, end: i + 1 };
}

// A memoized form of the native recursive glob matcher. It retains native `*`,
// `**`, `?`, bracket-class and backslash behavior while refusing pathological
// inputs instead of guessing when its bounded work budget is exceeded.
function globFrom(pattern, text) {
  const width = text.length + 1;
  const memo = new Map();
  let steps = 0;
  function visit(pi, si) {
    if (++steps > MAX_GLOB_STEPS) cannot(`glob match exceeded ${MAX_GLOB_STEPS} matcher steps`);
    const key = pi * width + si;
    if (memo.has(key)) return memo.get(key);
    // Mark before recursion; this protects unusual repeated-star patterns.
    memo.set(key, false);
    let result;
    if (pi >= pattern.length) {
      result = si === text.length;
    } else {
      const c = pattern[pi];
      if (c === "*") {
        if (pattern[pi + 1] === "*") {
          const next = pi + 2;
          if (pattern[next] === "/") {
            result = visit(next + 1, si);
            for (let k = si; !result && k < text.length; k++) {
              if (text[k] === "/") result = visit(next + 1, k + 1);
            }
          } else {
            result = false;
            for (let k = text.length; !result && k >= si; k--) result = visit(next, k);
          }
        } else {
          result = false;
          for (let k = si; ; k++) {
            result = visit(pi + 1, k);
            if (result || k >= text.length || text[k] === "/") break;
          }
        }
      } else if (si >= text.length) {
        result = false;
      } else if (c === "?") {
        result = text[si] !== "/" && visit(pi + 1, si + 1);
      } else if (c === "[") {
        const cls = text[si] === "/" ? undefined : matchClass(pattern, pi, text[si]);
        if (cls) result = cls.matched && visit(cls.end, si + 1);
        else if (text[si] === "/") result = false;
        else {
          const literal = c;
          result = text[si] === literal && visit(pi + 1, si + 1);
        }
      } else {
        const escaped = c === "\\" && pi + 1 < pattern.length;
        const literal = escaped ? pattern[pi + 1] : c;
        result = text[si] === literal && visit(pi + (escaped ? 2 : 1), si + 1);
      }
    }
    memo.set(key, result);
    return result;
  }
  return visit(0, 0);
}

function compileGlob(pattern) {
  const hasMeta = /[*?[\\]/.test(pattern);
  if (!hasMeta) return (text) => text === pattern;
  if (pattern.startsWith("*") && !/[*?[\\]/.test(pattern.slice(1)) && !pattern.includes("/")) {
    const suffix = pattern.slice(1);
    return (text) => text.endsWith(suffix) && text.indexOf("/") === -1;
  }
  if (pattern.endsWith("*") && !pattern.endsWith("**") && !/[*?[\\]/.test(pattern.slice(0, -1))) {
    const prefix = pattern.slice(0, -1);
    return (text) => text.startsWith(prefix) && text.indexOf("/", prefix.length) === -1;
  }
  if (pattern.startsWith("**/") && !pattern.slice(3).includes("/")) {
    const name = compileGlob(pattern.slice(3));
    return (text) => name(text.slice(text.lastIndexOf("/") + 1));
  }
  if (pattern.length > MAX_GENERIC_GLOB_LENGTH) {
    cannot(`generic glob pattern exceeds ${MAX_GENERIC_GLOB_LENGTH} characters`);
  }
  return (text) => globFrom(pattern, text);
}

/** Conservative exposure for building candidate supersets. */
export function nativeExpandBraces(pattern) {
  if (typeof pattern !== 'string') cannot('glob must be a string');
  return expandBraces(pattern);
}

/** Compile once per search, including on an empty directory, as native does. */
export function createNativeFindMatcher(pattern) {
  if (typeof pattern !== "string") cannot("find glob requires a string pattern");
  let adjusted = pattern;
  const fullPath = adjusted.includes("/");
  if (adjusted.startsWith("/")) adjusted = adjusted.slice(1);
  else if (fullPath && !adjusted.startsWith("**/") && adjusted !== "**") adjusted = `**/${adjusted}`;
  const matchers = expandBraces(adjusted).map(compileGlob);
  return relativePath => {
    if (typeof relativePath !== "string") cannot("find glob requires a string relativePath");
    const subject = fullPath ? relativePath : relativePath.slice(relativePath.lastIndexOf("/") + 1);
    return matchers.some(matches => matches(subject));
  };
}

/** Exact native find pattern preparation, including basename/full-path rules. */
export function nativeGlobMatches(pattern, relativePath) {
  return createNativeFindMatcher(pattern)(relativePath);
}

function parseIgnoreFile(text, base, git) {
  const rules = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\) +$/, "");
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    if (line.startsWith("!")) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith("\\!") || line.startsWith("\\#")) {
      line = line.slice(1);
    }
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (!line) continue;
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    rules.push({ base, pattern: line, matches: compileGlob(line), negate, dirOnly, anchored, git });
  }
  return rules;
}

function isIgnored(rules, rel, isDir) {
  let ignored = false;
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (ignored !== rule.negate) continue;
    let below;
    if (rule.base === "") below = rel;
    else if (rel.startsWith(`${rule.base}/`)) below = rel.slice(rule.base.length + 1);
    else continue;
    if (rule.matches(rule.anchored ? below : name)) ignored = !rule.negate;
  }
  return ignored;
}

function readSmallFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    cannot(`could not safely open rule file ${file}`, error);
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) cannot(`rule path ${file} is not a regular file`);
    if (stats.size > MAX_RULE_FILE_BYTES) cannot(`rule file ${file} exceeds ${MAX_RULE_FILE_BYTES} bytes`);
    const buffer = Buffer.alloc(stats.size);
    let length = 0;
    while (length < buffer.length) {
      let count;
      try {
        count = readSync(fd, buffer, length, buffer.length - length, length);
      } catch (error) {
        cannot(`could not read rule file ${file}`, error);
      }
      if (count === 0) break;
      length += count;
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    try {
      closeSync(fd);
    } catch (error) {
      cannot(`could not close rule file ${file}`, error);
    }
  }
}

function readRules(file, base, git) {
  const text = readSmallFile(file);
  return text === undefined ? [] : parseIgnoreFile(text, base, git);
}

function globalExcludesFile() {
  const configPath = path.join(homedir(), ".gitconfig");
  const config = readSmallFile(configPath);
  if (config !== undefined) {
    const match = /^\s*excludesfile\s*=\s*(.+?)\s*$/im.exec(config);
    if (match) {
      const value = match[1].replace(/^"(.*)"$/, "$1");
      return value.startsWith("~") ? path.join(homedir(), value.slice(1)) : value;
    }
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "git", "ignore");
}

async function readDirectory(file) {
  try {
    return await readdir(file, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    cannot(`could not read directory ${file}`, error);
  }
}

function gitExcludePath(repository) {
  const dotGit = path.join(repository, ".git");
  let stats;
  try {
    stats = statSync(dotGit);
  } catch (error) {
    if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") cannot(`could not inspect repository metadata ${dotGit}`, error);
    return path.join(dotGit, "info", "exclude");
  }
  if (stats.isDirectory()) return path.join(dotGit, "info", "exclude");
  const text = readSmallFile(dotGit);
  if (text === undefined) return path.join(dotGit, "info", "exclude");
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return path.join(dotGit, "info", "exclude");
  const gitDir = path.resolve(repository, match[1]);
  let common = gitDir;
  const commondir = readSmallFile(path.join(gitDir, "commondir"));
  if (commondir !== undefined) common = path.resolve(gitDir, commondir.trim());
  return path.join(common, "info", "exclude");
}

function repositoryOf(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    // Match native existsSync semantics (not lstat: a dangling .git symlink is
    // not a repository to repositoryOf, though it still triggers nested reset
    // when encountered in a directory listing).
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
  }
}

function toPosix(value) {
  return path.sep === "\\" ? value.split("\\").join("/") : value;
}

export function nativeGrepGlobFilter(override) {
  if (override === undefined || override === null || override === "") return {take:() => true, override:undefined};
  if (typeof override !== "string") cannot("override must be a positive grep glob string");
  const exclude = override.startsWith("!");
  const pattern = exclude ? override.slice(1) : override;
  const fullPath = pattern.includes("/");
  const adjusted = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  const matchers = expandBraces(adjusted).map(compileGlob);
  const matches = (rel) => {
    const subject = fullPath ? rel : rel.slice(rel.lastIndexOf("/") + 1);
    return matchers.some((matcher) => matcher(subject));
  };
  // Native grep only passes an override callback for positive glob patterns.
  return {take:rel => matches(rel) !== exclude, override:exclude ? undefined : matches};
}

/**
 * Build a path-local filter that mirrors native walker ignore decisions.
 * `override` is the grep glob string; only a positive glob bypasses ignore rules
 * for matching non-directory files. The caller still applies its own glob take
 * predicate to decide which unignored files to search.
 */
export function createNativeFilter(root, { requireGit, override } = {}) {
  if (typeof root !== "string" || !root) cannot("root must be a non-empty path string");
  if (typeof requireGit !== "boolean") cannot("requireGit must be explicitly true or false");
  const absRoot = path.resolve(root);
  const repository = repositoryOf(absRoot);
  const top = repository ?? absRoot;
  const rootRel = toPosix(path.relative(top, absRoot));
  const initialGit = repository !== undefined || !requireGit;
  const positiveOverride = nativeGrepGlobFilter(override).override;
  const ruleCache = new Map();
  const directoryCache = new Map();
  let initialPromise;

  function loadRules(file, base, git) {
    const key = `${file}\0${base}\0${git ? 1 : 0}`;
    if (!ruleCache.has(key)) ruleCache.set(key, readRules(file, base, git));
    return ruleCache.get(key);
  }

  async function listDirectory(dir) {
    if (!directoryCache.has(dir)) directoryCache.set(dir, readDirectory(dir));
    return directoryCache.get(dir);
  }

  async function initialContext() {
    if (!initialPromise) {
      initialPromise = (async () => {
        const rules = [];
        if (repository) {
          rules.push(...await loadRules(globalExcludesFile(), "", true));
          rules.push(...await loadRules(gitExcludePath(repository), "", true));
          const segments = rootRel ? rootRel.split("/") : [];
          let dir = repository;
          for (let i = 0; i < segments.length; i++) {
            const base = toPosix(path.relative(top, dir));
            if (initialGit) rules.push(...await loadRules(path.join(dir, ".gitignore"), base, true));
            rules.push(...await loadRules(path.join(dir, ".ignore"), base, false));
            dir = path.join(dir, segments[i]);
          }
        }
        return { rules, git: initialGit };
      })();
    }
    return initialPromise;
  }

  function topRel(rel) {
    return rootRel ? (rel ? `${rootRel}/${rel}` : rootRel) : rel;
  }

  async function visitDirectory(abs, rel, inherited) {
    const entries = await listDirectory(abs);
    if (entries === undefined) return undefined;
    let rules = inherited.rules;
    let git = inherited.git;
    const names = new Set(entries.map((entry) => entry.name));
    const base = topRel(rel);
    if (rel !== "" && names.has(".git")) {
      rules = rules.filter((rule) => !rule.git);
      rules = [...rules, ...await loadRules(gitExcludePath(abs), base, true)];
      git = true;
    }
    if (git && names.has(".gitignore")) {
      rules = [...rules, ...await loadRules(path.join(abs, ".gitignore"), base, true)];
    }
    if (names.has(".ignore")) {
      rules = [...rules, ...await loadRules(path.join(abs, ".ignore"), base, false)];
    }
    return { entries, rules, git };
  }

  return async function include(relativePath, kind) {
    if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.startsWith("/")) {
      cannot("relativePath must be a non-empty relative path using slash separators");
    }
    if (!["dir", "file", "symlink"].includes(kind)) cannot(`unsupported entry kind ${String(kind)}`);
    const parts = relativePath.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) cannot(`unsafe relativePath ${relativePath}`);
    if (parts.includes(".git")) return false;

    let context = await initialContext();
    let abs = absRoot;
    let rel = "";
    for (let i = 0; i < parts.length; i++) {
      const current = await visitDirectory(abs, rel, context);
      if (!current) cannot(`candidate ancestor disappeared: ${abs}`);
      const name = parts[i];
      const entry = current.entries.find((candidate) => candidate.name === name);
      if (!entry) cannot(`candidate disappeared: ${relativePath}`);
      const childKind = entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "symlink" : entry.isFile() ? "file" : undefined;
      if (!childKind) return false;
      const final = i === parts.length - 1;
      if (final && childKind !== kind) cannot(`kind mismatch for ${relativePath}: caller said ${kind}, filesystem says ${childKind}`);
      const childRel = rel ? `${rel}/${name}` : name;
      const ignored = current.rules.length > 0 && isIgnored(current.rules, topRel(childRel), childKind === "dir");
      if (ignored && (childKind === "dir" || !positiveOverride?.(childRel))) return false;
      if (final) return true;
      if (childKind !== "dir") return false;
      rel = childRel;
      abs = path.join(abs, name);
      context = { rules: current.rules, git: current.git };
    }
    return false;
  };
}
