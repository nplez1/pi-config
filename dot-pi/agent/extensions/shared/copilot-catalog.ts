import { getModelType, type Api, type Credential, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  COPILOT_CHAT_ENDPOINTS, COPILOT_CONTEXT_API_VERSION, COPILOT_PROVIDER, CopilotCatalogError,
  copilotVersionHeader, fetchCopilotCatalog, isDirectCopilotEndpoint, limit, record,
} from "./copilot-long-context";

const MAX_AGE_MS = 5 * 60_000;

function rows(raw: unknown) {
  const data = record(raw)?.data;
  if (!Array.isArray(data)) throw new CopilotCatalogError("GitHub Copilot returned an invalid model catalog.");
  return data.map(record).filter((row) => row !== undefined);
}

function unitPrice(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function catalogCost(billing: unknown): Model<Api>["cost"] | undefined {
  const prices = record(record(billing)?.token_prices);
  const batchSize = limit(prices?.batch_size);
  if (!batchSize) return;
  // The catalog prices each batch in AI Credits (one cent per credit).
  const usdPerMillion = 10_000 / batchSize;
  const rates = (raw: unknown) => {
    const tier = record(raw);
    const input = unitPrice(tier?.input_price);
    const output = unitPrice(tier?.output_price);
    const cacheRead = unitPrice(tier?.cache_read_price ?? tier?.cache_price);
    const cacheWrite = unitPrice(tier?.cache_write_price);
    if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return;
    return { input: input * usdPerMillion, output: output * usdPerMillion,
      cacheRead: cacheRead * usdPerMillion, cacheWrite: cacheWrite * usdPerMillion };
  };
  const normal = rates(prices?.default);
  if (!normal) return;
  const normalTier = record(prices?.default);
  const inputTokensAbove = limit(normalTier?.max_prompt_tokens) ?? limit(normalTier?.context_max);
  const long = rates(prices?.long_context);
  return long && inputTokensAbove ? { ...normal, tiers: [{ inputTokensAbove, ...long }] } : normal;
}

export function catalogModels(
  raw: unknown, priced: unknown, base: readonly Model<Api>[], baseUrl: string,
): Map<string, Model<Api>> {
  const result = new Map<string, Model<Api>>();
  const known = new Map(base.map((m) => [m.id, m]));
  const pricedRows = record(priced)?.data;
  const billing = new Map(Array.isArray(pricedRows) ? pricedRows.map(record).flatMap((row) => row ? [[row.id, row.billing] as const] : []) : []);
  for (const row of rows(raw)) {
    if (typeof row.id !== "string" || !/^[\w][\w.:-]{0,159}$/.test(row.id) || row.model_picker_enabled !== true) continue;
    const policy = record(row.policy)?.state;
    if (policy === "disabled" || policy === "unconfigured") continue;
    const capabilities = record(row.capabilities);
    if (capabilities?.type !== "chat") continue;
    const supports = record(capabilities.supports);
    if (supports?.tool_calls === false) continue;
    const endpoints = row.supported_endpoints;
    if (!Array.isArray(endpoints)) continue;
    const apis = Object.entries(COPILOT_CHAT_ENDPOINTS).filter(([, path]) => endpoints.includes(path)).map(([api]) => api);
    const existing = known.get(row.id);
    const api = existing && apis.includes(existing.api) ? existing.api : apis[0];
    if (!api) continue;
    const limits = record(capabilities.limits);
    const prompt = limit(limits?.max_prompt_tokens);
    const total = limit(limits?.max_context_window_tokens);
    const output = limit(limits?.max_output_tokens);
    if (!output || (!prompt && !total)) continue;
    const maxTokens = Math.min(existing?.maxTokens || output, output);
    const contextWindow = Math.min(prompt ?? Infinity, total === undefined ? Infinity : total - maxTokens);
    if (contextWindow <= 0) continue;
    const cost = catalogCost(billing.get(row.id) ?? row.billing) ?? existing?.cost;
    const name = typeof row.name === "string" && row.name.trim() ? row.name : row.id;
    // Only borrow transport-specific compatibility from the same API. Unknown
    // models use Pi's native Copilot transport defaults, not another model's flags.
    const template = existing?.api === api ? existing : undefined;
    result.set(row.id, {
      ...template,
      id: row.id, provider: COPILOT_PROVIDER, api, baseUrl: template?.baseUrl ?? baseUrl,
      name: template?.name ?? name.replace(/[\x00-\x1f\x7f]/g, ""),
      reasoning: template?.reasoning ?? (supports?.reasoning_effort === true || Array.isArray(supports?.reasoning_effort)),
      input: template?.input ?? (supports?.vision === true ? ["text", "image"] : ["text"]),
      contextWindow, maxTokens,
      cost: cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return result;
}

export interface CatalogSource {
  // Reads the versioned /models response for an account. The extension supplies
  // a shared, briefly cached reader, so this does not re-fetch what the
  // long-context probe already read for the same account. `signal` only bounds
  // this caller's wait; a shared request keeps running for the other callers.
  versionedCatalog(endpoint: string, apiKey: string, force?: boolean, signal?: AbortSignal): Promise<unknown>;
}

const defaultSource: CatalogSource = {
  versionedCatalog: (endpoint, apiKey, _force, signal) => fetchCopilotCatalog(endpoint, apiKey, undefined, { signal }),
};

export function withCopilotCatalog(base: Provider, source: CatalogSource = defaultSource) {
  let live: { fetchedAt: number; models: Map<string, Model<Api>>; credential: string } | undefined;
  // Compare credentials only in memory. Never persist an account's model visibility
  // in the account-agnostic built-in catalog store.
  const identity = (credential: Credential | undefined) => credential?.type === "oauth" ? credential.refresh : credential?.key;
  const useLive = (credential: Credential | undefined) => live &&
    (!credential || live.credential === identity(credential) || credential.type === "api_key" && !credential.key);
  const filterModels = (models: readonly Model<Api>[], credential: Credential | undefined) => useLive(credential)
    ? models.filter((model) => live!.models.has(model.id))
    : base.filterModels?.(models, credential) ?? models;

  const provider: Provider = {
    ...base,
    refreshModelsAuth: "credential",
    getModels: () => live ? [...live.models.values()] : base.getModels(),
    getAllModels: () => live ? [
      ...live.models.values(), ...(base.getAllModels?.() ?? []).filter((model) => getModelType(model) !== "chat"),
    ] : base.getAllModels?.() ?? base.getModels(),
    filterModels,
    filterAllModels(models, credential) {
      return useLive(credential) ? models.filter((model) => getModelType(model) !== "chat" || live!.models.has(model.id))
        : base.filterAllModels?.(models, credential) ?? models.filter((model) => getModelType(model) !== "chat" ||
          filterModels([model as Model<Api>], credential).length > 0);
    },
    async refreshModels(ctx) {
      if (ctx.signal.aborted) return;
      const credential = identity(ctx.credential);
      if (credential && live && live.credential !== credential) {
        await ctx.publish({ update: () => { live = undefined; } });
      }
      if (!ctx.allowNetwork) {
        // Restore Pi's existing public catalog cache without making a network request.
        await base.refreshModels?.(ctx);
        return;
      }
      if (!ctx.credential || !credential || ctx.signal.aborted) return;
      if (!ctx.force && live?.credential === credential && Date.now() - live.fetchedAt < MAX_AGE_MS) return;
      const auth = ctx.credential.type === "oauth" ? await base.auth.oauth?.toAuth(ctx.credential) : { apiKey: ctx.credential.key };
      const baseUrl = ctx.baseUrl ?? base.baseUrl;
      const endpoint = auth?.baseUrl ?? baseUrl;
      if (!auth?.apiKey || !baseUrl || !endpoint || !isDirectCopilotEndpoint(endpoint)) return;
      const [raw, priced] = await Promise.all([
        fetchCopilotCatalog(endpoint, auth.apiKey, undefined, { defaultTier: true, signal: ctx.signal }),
        source.versionedCatalog(endpoint, auth.apiKey, ctx.force, ctx.signal).catch(() => undefined),
      ]);
      const models = catalogModels(raw, priced, base.getModels(), baseUrl);
      await ctx.publish({ update: () => { live = { fetchedAt: Date.now(), models, credential }; } });
    },
  };
  function clamp(model: Model<Api>): Model<Api> {
    if (model.provider !== COPILOT_PROVIDER || !isDirectCopilotEndpoint(model.baseUrl) ||
      Object.entries(model.headers ?? {}).some(([key, value]) => copilotVersionHeader(key) && value === COPILOT_CONTEXT_API_VERSION)) return model;
    const entry = live?.models.get(model.id);
    if (!entry || model.api !== entry.api) return model;
    const contextWindow = Math.min(model.contextWindow, entry.contextWindow);
    const maxTokens = Math.min(model.maxTokens, entry.maxTokens);
    return contextWindow === model.contextWindow && maxTokens === model.maxTokens ? model : { ...model, contextWindow, maxTokens };
  }
  return { provider, clamp, hasLiveCatalog: () => live !== undefined };
}
