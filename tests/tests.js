// Unit tests for the pure modules. Open tests/index.html (served over http) or
// run `bash tool/test.sh` for headless Chrome.

import { classify, families, plan, repoKey, upgradeCommand } from '../js/classify.js';
import { parseRepoInput } from '../js/github.js';
import { esc, markdown } from '../js/md.js';
import { advisoryAffects, changelogSlice, parseEnvironment, parseLock, parsePubspec } from '../js/pubspec.js';
import { pubspecDirs } from '../js/scan.js';
import { Constraint, Version } from '../js/semver.js';
import { readFromTar } from '../js/tar.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
  }
}
function eq(actual, expected, msg = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg} expected ${b}, got ${a}`);
}
const v = (s) => Version.parse(s);

// ---------- semver ----------
test('version ordering incl. pre-release and build', () => {
  eq(v('1.0.0-dev.1').lt(v('1.0.0')), true);
  eq(v('1.0.0+1').gt(v('1.0.0')), true);
  eq(v('1.0.0-dev.2').gt(v('1.0.0-dev.10')), false);
  eq(v('2.10.0').gt(v('2.9.9')), true);
  eq(v('x'), null);
});
test('caret ceiling and breaking boundary', () => {
  eq(v('1.2.3').caretCeiling.toString(), '2.0.0');
  eq(v('0.4.1').caretCeiling.toString(), '0.5.0');
  eq(v('0.0.3').caretCeiling.toString(), '0.0.4');
  eq(v('0.4.0').isBreakingTo(v('0.5.0')), true);
  eq(v('1.4.0').isBreakingTo(v('1.9.0')), false);
});
test('constraints', () => {
  eq(Constraint.parse('^1.2.0').allows(v('1.9.9')), true);
  eq(Constraint.parse('^1.2.0').allows(v('2.0.0')), false);
  eq(Constraint.parse('>=3.0.0 <4.0.0').allows(v('3.12.2')), true);
  eq(Constraint.parse('>=3.13.0 <4.0.0').allows(v('3.12.2')), false);
  eq(Constraint.parse('2.8.1').allows(v('2.8.2')), false);
  eq(Constraint.parse('any').allows(v('9.0.0')), true);
  eq(Constraint.parse('"^3.9.0"').min.toString(), '3.9.0');
  eq(Constraint.parse(null), null);
});

// ---------- pubspec ----------
const PUBSPEC = `name: demo_app
environment:
  sdk: ^3.9.0
  flutter: ">=3.35.0"
dependencies:
  flutter:
    sdk: flutter
  dio: ^5.4.0 # http client
  # DO NOT bump: v3 breaks our cache store
  hive: 2.2.3

  my_fork:
    git:
      url: https://github.com/me/fork
  local_pkg:
    path: ../local_pkg
  hosted_ver:
    hosted: https://pub.dev
    version: ^1.0.0
dev_dependencies:
  lints: ^5.0.0
dependency_overrides:
  intl: 0.20.2
flutter:
  uses-material-design: true
`;
test('pubspec: sections, sources, notes', () => {
  const deps = parsePubspec(PUBSPEC);
  const by = Object.fromEntries(deps.map((d) => [d.name, d]));
  eq(Object.keys(by), ['flutter', 'dio', 'hive', 'my_fork', 'local_pkg', 'hosted_ver', 'lints', 'intl']);
  eq(by.flutter.source, 'sdk');
  eq(by.dio.constraint, '^5.4.0');
  eq(by.dio.note, 'http client');
  eq(by.hive.note, 'DO NOT bump: v3 breaks our cache store');
  eq(by.my_fork.source, 'git');
  eq(by.my_fork.constraint, null);
  eq(by.local_pkg.source, 'path');
  eq(by.hosted_ver.constraint, '^1.0.0');
  eq(by.lints.section, 'dev');
  eq(by.intl.section, 'override');
});
test('pubspec: environment', () => {
  eq(parseEnvironment(PUBSPEC), { sdk: '^3.9.0', flutter: '>=3.35.0' });
});
test('pubspec.lock', () => {
  const lock = parseLock(`packages:
  dio:
    dependency: "direct main"
    description:
      name: dio
      url: "https://pub.dev"
    source: hosted
    version: "5.7.0"
  meta:
    dependency: transitive
    source: hosted
    version: "1.16.0"
sdks:
  dart: ">=3.9.0 <4.0.0"
`);
  eq(lock.dio, { version: '5.7.0', dependency: 'direct main', source: 'hosted' });
  eq(lock.meta.dependency, 'transitive');
  eq(Object.keys(lock), ['dio', 'meta']);
});
test('changelog slice is (from, to]', () => {
  const log = '# Changelog\n## 2.1.0\n- c\n## [2.0.0] - 2024-01-01\n- b\n## 1.0.0\n- a\n';
  eq(changelogSlice(log, v('1.0.0'), v('2.1.0')), '## 2.1.0\n- c\n## [2.0.0] - 2024-01-01\n- b');
  eq(changelogSlice(log, v('2.0.0'), v('2.1.0')), '## 2.1.0\n- c');
  eq(changelogSlice(log, v('2.1.0'), v('2.1.0')), '');
});
test('advisory ranges', () => {
  const adv = { affected: [{ package: { name: 'dio' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '5.0.0' }] }] }] };
  eq(advisoryAffects(adv, 'dio', v('4.0.6')), true);
  eq(advisoryAffects(adv, 'dio', v('5.0.0')), false);
  eq(advisoryAffects(adv, 'http', v('4.0.0')), false);
  eq(advisoryAffects({ affected: [{ package: { name: 'x' }, versions: ['1.0.0'] }] }, 'x', v('1.0.0')), true);
});

// ---------- classify ----------
const now = new Date('2026-10-01');
const recent = new Date('2026-09-01');
const dep = (o = {}) => ({ name: 'p', section: 'main', source: 'hosted', constraint: '^1.0.0', note: '', ...o });
const base = (o = {}) => ({ dep: dep(), now, current: v('1.0.0'), latest: v('1.1.0'), latestPublished: recent, native: false, ...o });
test('classify: safe / upToDate / security', () => {
  eq(classify(base()).category, 'safe');
  eq(classify(base()).ota, true);
  eq(classify(base({ latest: v('1.0.0') })).category, 'upToDate');
  eq(classify(base({ advisories: 1 })).category, 'security');
});
test('classify: locked beats breaking, security beats locked', () => {
  eq(classify(base({ dep: dep({ section: 'override' }), latest: v('2.0.0') })).category, 'locked');
  eq(classify(base({ dep: dep({ note: 'Pinned until upstream fix' }) })).reasons, ['pinned-note']);
  eq(classify(base({ dep: dep({ constraint: '1.0.0' }) })).category, 'attention');
  eq(classify(base({ dep: dep({ constraint: '1.0.0' }) })).reasons, ['exact-pin']);
  eq(classify(base({ dep: dep({ section: 'override' }), advisories: 2 })).category, 'security');
});
test('classify: breaking signals', () => {
  eq(classify(base({ latest: v('2.0.0') })).reasons, ['major-bump', 'outside-constraint']);
  eq(classify(base({ changelog: '## 1.1.0\n- **BREAKING** renamed foo' })).category, 'breaking');
  eq(classify(base({ sdkCompatible: false })).category, 'breaking');
});
test('classify: attention and abandoned', () => {
  const nat = classify(base({ native: true }));
  eq([nat.category, nat.ota, nat.reasons], ['attention', false, ['native-plugin']]);
  eq(classify(base({ changelog: 'Deprecated `foo`' })).reasons, ['changelog-deprecation']);
  eq(classify(base({ changelog: 'Raised minSdk to 23' })).reasons, ['platform-floor-raised']);
  eq(classify(base({ latest: v('1.0.0'), discontinued: true })).category, 'abandoned');
  eq(classify(base({ latest: v('1.0.0'), latestPublished: new Date('2024-01-01') })).reasons, ['stale']);
});
test('families group by repo, skip independent monorepos', () => {
  eq(repoKey('https://github.com/firebase/flutterfire/tree/main/packages/x'), 'firebase/flutterfire');
  eq(families({
    firebase_core: 'https://github.com/firebase/flutterfire/tree/main/packages/firebase_core',
    firebase_auth: 'https://github.com/firebase/flutterfire',
    path_provider: 'https://github.com/flutter/packages/tree/main/packages/path_provider',
    shared_preferences: 'https://github.com/flutter/packages',
    dio: 'https://github.com/cfug/dio',
  }), { 'firebase/flutterfire': ['firebase_auth', 'firebase_core'] });
});
test('plan: order, family travels with its worst member, commands', () => {
  const row = (name, category, extra = {}) => ({
    name, category, section: 'main', current: '1.0.0', latest: '1.1.0', ota: true, reasons: [], ...extra,
  });
  const rows = [
    row('a', 'safe'),
    row('b', 'safe', { ota: false }),
    row('c', 'breaking', { latest: '2.0.0', reasons: ['major-bump', 'outside-constraint'] }),
    row('fam1', 'safe'),
    row('fam2', 'attention', { ota: false, reasons: ['native-plugin'] }),
    row('l', 'locked'),
    row('s', 'security'),
    row('d', 'safe', { section: 'dev', latest: '3.0.0', reasons: ['outside-constraint'] }),
  ];
  const batches = plan(rows, { 'x/fam': ['fam1', 'fam2'] });
  eq(batches.map((b) => [b.id, b.rows.map((r) => r.name)]), [
    ['security', ['s']], ['safe-ota', ['a', 'd']], ['safe-native', ['b']], ['attention', ['fam1', 'fam2']], ['breaking', ['c']],
  ]);
  eq(batches[1].command, 'flutter pub upgrade a && flutter pub add --dev d:^3.0.0');
  eq(batches[3].store, true);
  eq(upgradeCommand([rows[2]]), 'flutter pub add c:^2.0.0');
  eq(upgradeCommand([row('e', 'attention', { latest: '1.4.0', reasons: ['exact-pin'] })]), 'flutter pub add e:1.4.0');
});

// ---------- github / scan helpers ----------
test('repo input forms', () => {
  eq(parseRepoInput('owner/repo'), { owner: 'owner', repo: 'repo', ref: null, path: null });
  eq(parseRepoInput('https://github.com/o/r.git'), { owner: 'o', repo: 'r', ref: null, path: null });
  eq(parseRepoInput('github.com/o/r/tree/dev/apps/mobile'), { owner: 'o', repo: 'r', ref: 'dev', path: 'apps/mobile' });
  eq(parseRepoInput('https://github.com/o/r/blob/main/pubspec.yaml'), { owner: 'o', repo: 'r', ref: 'main', path: null });
  let code = null;
  try { parseRepoInput('https://gitlab.com/o/r'); } catch (e) { code = e.code; }
  eq(code, 'bad-url');
});
test('pubspec dirs: root first, generated dirs skipped', () => {
  eq(pubspecDirs(['packages/a/pubspec.yaml', 'pubspec.yaml', 'build/x/pubspec.yaml', 'ios/.symlinks/plugins/y/pubspec.yaml', 'example/pubspec.yaml']),
    ['', 'example', 'packages/a']);
});

// ---------- tar / md ----------
test('tar: finds CHANGELOG.md', () => {
  const enc = new TextEncoder();
  const entry = (name, body) => {
    const h = new Uint8Array(512);
    h.set(enc.encode(name), 0);
    h.set(enc.encode(body.length.toString(8).padStart(11, '0')), 124);
    h[156] = '0'.charCodeAt(0);
    const data = new Uint8Array(Math.ceil(body.length / 512) * 512);
    data.set(enc.encode(body));
    return [h, data];
  };
  const parts = [...entry('README.md', 'x'.repeat(700)), ...entry('CHANGELOG.md', '## 1.0.0\n- hi'), new Uint8Array(1024)];
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { tar.set(p, off); off += p.length; }
  eq(readFromTar(tar, /^(\.\/)?CHANGELOG\.md$/i), '## 1.0.0\n- hi');
  eq(readFromTar(tar, /^LICENSE$/), null);
});
test('markdown escapes html and keeps only http links', () => {
  eq(esc('<b>"&'), '&lt;b&gt;&quot;&amp;');
  const html = markdown('## 1.0.0\n- <script>x</script> `a<b`\n- [ok](https://x.dev) [bad](javascript:alert(1))');
  eq(html.includes('<script>'), false);
  eq(html.includes('<code>a&lt;b</code>'), true);
  eq(html.includes('href="https://x.dev"'), true);
  eq(html.includes('javascript:alert'), true); // left as escaped text, not a link
  eq(html.includes('href="javascript'), false);
});

// ---------- report ----------
const failed = results.filter((r) => !r.ok);
document.getElementById('out').textContent = results
  .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`).join('\n');
document.getElementById('summary').textContent = `${results.length - failed.length}/${results.length} passed`;
document.body.dataset.status = failed.length ? 'fail' : 'pass';
