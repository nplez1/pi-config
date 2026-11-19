// The single discovery entry for this extension, on every Pi version.
//
// Pi 1.4 and 1.5.0 discover a symlinked extension *file* but skip a symlinked
// extension *directory*; Pi 1.5.1 and later discover both. With the entry inside
// the directory, 1.5.1+ evaluated the extension twice (two session_start
// handlers, two tool registrations). The directory therefore has no `index.js`,
// `index.ts` or `pi.extensions` manifest entry, so directory discovery finds
// nothing there and only this file loads. `tests/discovery.test.mjs` holds that.
export { default } from './fast-search/index.mjs';
