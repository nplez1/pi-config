import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruneStalePackages, staleReason } from '../scripts/prune-stale.mjs';

const script = fileURLToPath(new URL('../scripts/prune-stale.mjs', import.meta.url));

// A clone and a home, both disposable. `files` are repo-relative; `live` are
// home-relative. Directories are enough unless a test needs a package.json.
function fixture(t, { files = [], live = [], liveDirs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-prune-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const [base, entries] of [[repo, files], [home, live]]) {
    for (const rel of entries) {
      fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
      fs.writeFileSync(path.join(base, rel), '{}\n');
    }
  }
  for (const rel of liveDirs) fs.mkdirSync(path.join(home, rel), { recursive: true });
  return { root, repo, home };
}

// `git` answers by command line, exactly as the real runner would, and anything
// unlisted is a command it cannot answer (null).
const gitAnswering = (answers) => (...args) => answers[args.join(' ')] ?? null;
const submoduleList = (...paths) => paths.map(p => `submodule.${p}.path ${p}\n`).join('');
const submodulesKey = 'config -f .gitmodules --get-regexp \\.path$';

test('an entry that names nothing local is left alone', t => {
  const f = fixture(t);
  const settings = {
    packages: ['npm:pi-web-access', 'plugins/pi-todo', '-plugins/pi-todo'],
    piBolt: { packages: [{ source: 'plugins/pi-codex-goal', prompts: [] }], packagesOverlay: true },
  };
  const { settings: out, pruned } = pruneStalePackages(settings, {
    ...f,
    git: gitAnswering({
      [submodulesKey]: submoduleList('plugins/pi-todo', 'plugins/pi-codex-goal'),
    }),
  });
  assert.deepEqual(pruned, []);
  assert.deepEqual(out, settings);
});

test('prunes a plugin whose directory is gone from the clone and the home', t => {
  const f = fixture(t, { files: ['plugins/pi-todo/package.json'] });
  const settings = { packages: ['plugins/pi-todo', 'plugins/pi-advisor-subagent'] };
  const { settings: out, pruned } = pruneStalePackages(settings, {
    ...f,
    git: gitAnswering({ [submodulesKey]: submoduleList('plugins/pi-todo') }),
  });
  assert.deepEqual(pruned, [
    { where: 'packages', source: 'plugins/pi-advisor-subagent', reason: 'the directory is gone' },
  ]);
  assert.deepEqual(out.packages, ['plugins/pi-todo']);
});

test('keeps a registered submodule that has not been fetched yet', t => {
  // `git clone` without --recurse-submodules leaves the directory empty, and
  // install.sh fetches submodules later; pruning here would drop the entry for
  // good on a fresh machine.
  const f = fixture(t, { files: ['plugins/pi-codex-goal/.gitkeep'] });
  const { pruned } = pruneStalePackages({ packages: ['plugins/pi-codex-goal'] }, {
    ...f,
    git: gitAnswering({ [submodulesKey]: submoduleList('plugins/pi-codex-goal') }),
  });
  assert.deepEqual(pruned, []);
});

test('keeps a plugin this clone tracks without a submodule', t => {
  const f = fixture(t, { files: ['plugins/local/package.json'] });
  const { pruned } = pruneStalePackages({ packages: ['plugins/local'] }, {
    ...f,
    git: gitAnswering({ [submodulesKey]: '', 'ls-files -- plugins/local': 'plugins/local/package.json\n' }),
  });
  assert.deepEqual(pruned, []);
});

test('prunes a leftover checkout git no longer carries', t => {
  // A deleted submodule's directory survives `git submodule update`, which cannot
  // rmdir it over the node_modules inside: unregistered and untracked, with a
  // package.json, so only git can tell it apart from a real plugin.
  const f = fixture(t, { files: ['plugins/pi-advisor-subagent/package.json'] });
  const { pruned } = pruneStalePackages({ packages: ['plugins/pi-advisor-subagent'] }, {
    ...f,
    git: gitAnswering({ [submodulesKey]: submoduleList('plugins/pi-todo'), 'ls-files -- plugins/pi-advisor-subagent': '' }),
  });
  assert.deepEqual(pruned, [
    { where: 'packages', source: 'plugins/pi-advisor-subagent', reason: 'not part of this clone any more' },
  ]);
});

test('without git, only a missing directory is evidence', t => {
  const f = fixture(t, { files: ['plugins/pi-advisor-subagent/package.json'] });
  // `config` fails when there is no .gitmodules, and the runner then answers null
  // for everything: a directory that exists is kept rather than guessed at.
  const { pruned } = pruneStalePackages({ packages: ['plugins/pi-advisor-subagent', 'plugins/gone'] }, {
    ...f,
    git: () => null,
  });
  assert.deepEqual(pruned, [{ where: 'packages', source: 'plugins/gone', reason: 'the directory is gone' }]);
});

test('prunes a bundle whose package.json this clone dropped, and keeps a real one', t => {
  const f = fixture(t, {
    files: [
      'pi-bolt/pi-bolt-subagents/package.json',
      // Only ignored build output is left, which is what a removed bundle's
      // directory looks like after a pull.
      'pi-bolt/pi-bolt-advisor-subagent/dist-bun/index.js',
      'pi-bolt/pi-bolt-negative/.gitkeep',
    ],
  });
  const { settings: out, pruned } = pruneStalePackages({
    piBolt: {
      packages: [
        'pi-bolt-bundles/pi-bolt-subagents',
        'pi-bolt-bundles/pi-bolt-advisor-subagent',
        'pi-bolt-bundles/pi-bolt-negative',
        'pi-bolt-bundles/pi-bolt-gone',
        '-plugins/pi-todo',
        'npm:pi-web-access',
      ],
    },
  }, { ...f, git: () => null });

  assert.deepEqual(pruned.map(p => [p.source, p.reason]), [
    ['pi-bolt-bundles/pi-bolt-advisor-subagent', 'no package.json in it'],
    ['pi-bolt-bundles/pi-bolt-negative', 'no package.json in it'],
    ['pi-bolt-bundles/pi-bolt-gone', 'the directory is gone'],
  ]);
  assert.deepEqual(out.piBolt.packages, ['pi-bolt-bundles/pi-bolt-subagents', '-plugins/pi-todo', 'npm:pi-web-access']);
});

test('resolves an entry under the home first, so a linked bundle counts', t => {
  const f = fixture(t, { live: ['.pi/agent/pi-bolt-bundles/pi-bolt-subagents/package.json'] });
  const { pruned } = pruneStalePackages({ piBolt: { packages: ['pi-bolt-bundles/pi-bolt-subagents'] } },
    { ...f, git: () => null });
  assert.deepEqual(pruned, []);
});

test('staleReason is null for anything it cannot judge', t => {
  const f = fixture(t);
  for (const source of ['npm:@juicesharp/rpiv-ask-user-question', '-plugins/pi-todo', 'https://example.com/x']) {
    assert.equal(staleReason(source, { ...f, git: () => null, submodules: null }), null, source);
  }
});

test('the CLI prunes, is idempotent, and --dry-run changes nothing', t => {
  const f = fixture(t, { liveDirs: ['.pi/agent/plugins/pi-advisor-subagent'] });
  const live = path.join(f.home, '.pi/agent/settings.json');
  const original = { packages: ['plugins/pi-advisor-subagent', 'plugins/does-not-exist'] };
  fs.writeFileSync(live, JSON.stringify(original, null, 2) + '\n');

  const dry = execFileSync(process.execPath, [script, '--repo', f.repo, '--home', f.home, '--dry-run'],
    { encoding: 'utf8' });
  assert.match(dry, /would prune\s+packages: plugins\/does-not-exist \(the directory is gone\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')), original);

  const out = execFileSync(process.execPath, [script, '--repo', f.repo, '--home', f.home, '--mode', 'install'],
    { encoding: 'utf8' });
  assert.match(out, /prune\s+packages: plugins\/does-not-exist/);
  // The advisor directory still exists in the home, and with no git to ask, a
  // directory that is there is not evidence of anything.
  assert.deepEqual(JSON.parse(fs.readFileSync(live, 'utf8')).packages, ['plugins/pi-advisor-subagent']);

  const again = execFileSync(process.execPath, [script, '--repo', f.repo, '--home', f.home], { encoding: 'utf8' });
  assert.match(again, /ok\s+every entry resolves/);
});
