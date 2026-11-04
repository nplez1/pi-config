# pi-config customization

This is the MIT-licensed `pi-codex-goal` npm package, version **0.7.7**,
vendored from <https://github.com/fitchmultz/pi-codex-goal>. Its license is in
`LICENSE`. The only source change is in `src/goal-runtime-status.ts`: the
objective is combined with the live status in the footer, rather than occupying
a separate widget below the editor. `/goal` still shows the full objective. The
package's development scripts and dependencies were removed because the npm
release does not include its upstream test suite.

To update, compare the upstream package with this copy, carry the status change
forward, and run the goal footer and installer tests. `install.sh` migrates the
old npm package entry to this local copy while retaining its resource filters.
