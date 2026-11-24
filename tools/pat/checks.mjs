// Expiry derivation and live canaries.
//
// Most PAT APIs never expose a token's expiry, so pat derives one from the
// documented TTL and *separately* asks the provider whether the token still
// works. Derivation says what you assume; the canary says what is true. Both
// are reported, because they disagree in exactly the cases that hurt.

import { spawnSync } from 'node:child_process';
import { DEFAULT_WARN_DAYS } from './config.mjs';

const DAY_MS = 86_400_000;

export function expiryInfo(token, now = new Date()) {
  if (!token.issued || !Number.isFinite(token.ttlDays)) return { known: false, state: 'unknown' };
  const issuedMs = Date.parse(token.issued.length === 10 ? `${token.issued}T00:00:00Z` : token.issued);
  if (Number.isNaN(issuedMs)) return { known: false, state: 'unknown' };
  const expires = new Date(issuedMs + token.ttlDays * DAY_MS);
  const daysLeft = Math.floor((expires.getTime() - now.getTime()) / DAY_MS);
  return { known: true, expires, daysLeft };
}

export function expiryState(token, { warnDays = DEFAULT_WARN_DAYS, now = new Date() } = {}) {
  const info = expiryInfo(token, now);
  if (!info.known) return { ...info, state: 'unknown' };
  if (info.daysLeft < 0) return { ...info, state: 'expired' };
  if (info.daysLeft <= warnDays) return { ...info, state: 'expiring' };
  return { ...info, state: 'ok' };
}

/** Ask the provider (or a local command) whether this token still works. */
export async function canary(token, value, { timeoutMs = 10_000 } = {}) {
  const check = token.check ?? { kind: 'none' };
  if (check.kind === 'none') return { state: 'skipped', detail: 'no check configured' };

  if (check.kind === 'command') {
    const result = spawnSync(check.command, {
      shell: '/bin/sh',
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, [token.var]: value },
    });
    if (result.status === 0) return { state: 'ok', detail: 'command exited 0' };
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n')[0];
    return { state: 'invalid', detail: detail || `exit ${result.status}` };
  }

  const headers = { ...(check.headers ?? {}) };
  for (const [key, headerValue] of Object.entries(headers)) {
    headers[key] = String(headerValue).replaceAll('{token}', value);
  }
  if (check.header) headers[check.header] = value;
  else if (!Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.Authorization = `Bearer ${value}`;
  }

  try {
    const response = await fetch(check.url, {
      method: check.method ?? 'GET',
      headers,
      // A redirect would re-send a token header to another origin, so a
      // redirecting endpoint is a failed check, not a followed one.
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return { state: 'ok', detail: `HTTP ${response.status}` };
    if (response.status === 401 || response.status === 403) return { state: 'invalid', detail: `HTTP ${response.status}` };
    return { state: 'warn', detail: `HTTP ${response.status}` };
  } catch (error) {
    return { state: 'unknown', detail: error instanceof Error ? error.message : String(error) };
  }
}

export const ATTENTION_STATES = new Set(['expired', 'expiring', 'invalid', 'warn']);

/** Worst of the two signals: a live token that is about to expire still matters. */
export function overallState(expiry, probe) {
  if (probe.state === 'invalid') return 'invalid';
  if (expiry.state === 'expired') return 'expired';
  if (probe.state === 'warn') return 'warn';
  if (expiry.state === 'expiring') return 'expiring';
  if (expiry.state === 'ok') return 'ok';
  return probe.state === 'ok' ? 'ok' : 'unknown';
}

export function needsAttention(state) {
  return ATTENTION_STATES.has(state);
}

export function describeDaysLeft(expiry) {
  if (!expiry.known) return 'unknown';
  if (expiry.daysLeft < 0) return `${Math.abs(expiry.daysLeft)}d ago`;
  if (expiry.daysLeft === 0) return 'today';
  return `${expiry.daysLeft}d`;
}
