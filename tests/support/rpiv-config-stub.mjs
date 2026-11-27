/**
 * Stand-in for `@juicesharp/rpiv-config` when running the plugin's source under
 * bare Node.
 *
 * The real package ships TypeScript sources, and Node refuses to strip types for
 * files under `node_modules` — while the plugin's loader (`jiti`) has no such
 * limit. Mapping the specifier to this stub keeps the tests pointed at the real
 * `config.ts` logic without an actual Pi host or config file on disk: `setConfig`
 * is the whole config file, so each test decides what the user's file says.
 */

export const state = { config: /** @type {Record<string, unknown>} */ ({}) };

/** Replace what `loadConfig()` will read for the next assertion. */
export function setConfig(next) {
  state.config = next ?? {};
}

/** The plugin's only runtime import from the real package. */
export function loadJsonConfigWithLegacyFallback() {
  return state.config;
}

/** Guidance validation is the real package's job, not the code under test. */
export function validateGuidanceFields(fields) {
  return fields ?? {};
}
