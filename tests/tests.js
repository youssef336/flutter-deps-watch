// Unit tests for the pure modules. Open tests/index.html (served over http) or
// run `bash tool/test.sh` for headless Chrome.

import { AiError, buildPrompt, codeExcerpts, explain, geminiModels } from '../js/ai.js';
import { classify, families, plan, repoKey, upgradeCommand } from '../js/classify.js';
import { parseRepoInput } from '../js/github.js';
import { esc, markdown } from '../js/md.js';
import { identifiers, markHits, parseNotes } from '../js/notes.js';
import { advisoryAffects, changelogSlice, parseEnvironment, parseLock, parsePubspec } from '../js/pubspec.js';
import { pubspecDirs } from '../js/scan.js';
import { Constraint, Version } from '../js/semver.js';
import { readFromTar } from '../js/tar.js';

const results = [];
// Async tests run one after another: several of them swap globalThis.fetch.
let chain = Promise.resolve();
function testAsync(name, fn) {
  chain = chain.then(fn).then(() => results.push({ name, ok: true }), (e) => results.push({ name, ok: false, error: e.message }));
}
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


// ---------- notes (what an upgrade brings) ----------
const kinds = (n) => Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v.map((i) => i.text)]));
test('notes: melos tags, commit links stripped', () => {
  const n = parseNotes(`## 13.0.0

> Note: This release has breaking changes.

 - **BREAKING** **FEAT**(device_info_plus): Bump win32 to 6.0.0 ([#3791](https://x/3791)). ([abcdef12](https://x/c))
 - **FIX**(device_info_plus): Apply KGP ([#3947](https://x/3947)). ([36414d4c](https://x/c))
 - **FEAT**(device_info_plus): Add build timestamp ([#3969](https://x/3969)).
 - **REFACTOR**(device_info_plus): Change Gradle to Kotlin`);
  eq(n.fix.map((i) => i.text), ['Apply KGP ([#3947](https://x/3947)).']);
  eq(n.feature.map((i) => i.text), ['Add build timestamp ([#3969](https://x/3969)).']);
  eq(n.breaking.length, 2);
  eq(n.other.map((i) => i.text), ['Change Gradle to Kotlin']);
  eq(n.fix[0].version, '13.0.0');
});
test('notes: conventional commits and bang', () => {
  const n = parseNotes(`# 3.0.0
- **BREAKING** refactor!: remove \`EquatableMixin\` (#217)
- feat: add \`MultiBlocObserver\`
- fix: \`isClosed\` should incorporate event controller state
- docs: fix gallery image urls
- refactor!: drop legacy api`);
  eq(kinds(n), {
    breaking: ['**BREAKING** refactor!: remove `EquatableMixin` (#217)', 'Drop legacy api'],
    feature: ['Add `MultiBlocObserver`'], fix: ['`isClosed` should incorporate event controller state'],
    other: ['Fix gallery image urls'],
  });
});
test('notes: keep-a-changelog and bold sections, heading section', () => {
  const n = parseNotes(`## 14.0.0

**Breaking Changes**
- add support for AGP 9

**Features**:
- Add support for scene delegates

**Bugs**
- Fixed scrolling issue for the cardfield in web (#2045)

## [3.0.0] [Breaking Changes]
- \`Bone.button()\` no longer reads Material themes.

## 2.9.0
### Added
- Something new
### Fixed
- Add missing null check
### Changed
- Fixes a crash on resume`);
  eq(kinds(n), {
    breaking: ['add support for AGP 9', '`Bone.button()` no longer reads Material themes.'],
    feature: ['Add support for scene delegates', 'Something new'],
    fix: ['Fixed scrolling issue for the cardfield in web (#2045)', 'Add missing null check', 'Fixes a crash on resume'],
    other: [],
  });
});
test('notes: verbs, prose "breaking", wrapped lines, paragraphs', () => {
  const n = parseNotes(`## 5.11.1

- Fix response stream not propagating backpressure.
  When a consumer paused the stream, the source was never paused.
- Fix \`NoSuchMethodError\` when a class \`implements Interceptor\`, breaking any class using it.
- Add \`query\` convenience methods.
- Updates minimum supported SDK version to Flutter 3.44/Dart 3.12.

## 18.0.1

Clarifies \`onEnter\` documentation.`);
  eq(n.breaking.length, 0);
  eq(n.fix.length, 2);
  eq(n.fix[0].text, 'Fix response stream not propagating backpressure. When a consumer paused the stream, the source was never paused.');
  eq(n.feature.map((i) => i.text), ['Add `query` convenience methods.']);
  eq(n.other.length, 2);
});
test('notes: platform groups, PR refs, pre-release dedupe', () => {
  const n = parseNotes(`## 7.0.0
- Android:
  - chore: **Breaking change** Remove background recording service.
  - chore: Move to AGP 9.x.
- iOS:
  - fix: Respect \`shouldResume\` flag.
- web:
  - feat: JS assets are now platform-specific.
* [#147](https://x/147): fix(ios): raise SPM platform to iOS 13.0.
* [Android][iOS] added \`openAppNotificationSettings()\` method.

## 7.0.0-rc.1
- Fix something only in the rc`);
  eq(kinds(n), {
    breaking: ['Android: **Breaking change** Remove background recording service.'],
    feature: ['web: JS assets are now platform-specific.', '[Android][iOS] added `openAppNotificationSettings()` method.'],
    fix: ['iOS: Respect `shouldResume` flag.', 'Raise SPM platform to iOS 13.0.'],
    other: ['Android: Move to AGP 9.x.'],
  });
});
test('notes: identifiers and hits in project code', () => {
  eq(identifiers('remove `EquatableMixin` and `SkeletonizerConfigData.light()` in `String`', 'equatable'),
    ['EquatableMixin', 'SkeletonizerConfigData', 'light']);
  eq(identifiers('migrated from `package:flutter/material.dart` to `material_ui`; see ```dart\nclass Foo with Equatable\n```', 'p'),
    ['material_ui']);
  const n = parseNotes('## 3.0.0\n- **BREAKING** remove `EquatableMixin`\n- **BREAKING** remove `Other`\n- fix: `props` order');
  markHits(n, 'equatable', new Set(['EquatableMixin', 'props', 'User']));
  eq(n.breaking.map((i) => i.hits ?? null), [['EquatableMixin'], null]);
  eq(n.fix[0].hits, ['props']);
  const f = parseNotes('## 2.1.0\n- feat: deprecate `EquatableMixin`\n  ```dart\n  class Foo with EquatableMixin {} // OLD\n  ```\n- fix: other');
  eq(f.feature[0].text, 'Deprecate `EquatableMixin`\n```dart\nclass Foo with EquatableMixin {} // OLD\n```');
  markHits(f, 'equatable', new Set(['EquatableMixin']));
  eq(f.feature[0].hits, undefined);
  eq(f.fix.map((i) => i.text), ['Other']);
});
test('classify: parsed notes override the loose "breaking" text match', () => {
  const prose = '## 1.1.0\n- Fix X, which was breaking any class using it.';
  eq(classify(base({ changelog: prose })).category, 'breaking'); // old text heuristic
  eq(classify(base({ changelog: prose, changelogBreaking: false })).category, 'safe');
});


// ---------- AI explanation (fetch is mocked; the real Anthropic SDK runs) ----------
function sse(events) {
  const body = events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const req = new Request(input, init);
    const call = { url: req.url, headers: Object.fromEntries(req.headers), body: init.body ? JSON.parse(await req.clone().text()) : null };
    calls.push(call);
    return handler(call);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}
const claudeStream = (texts, stop = 'end_turn') => sse([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  ...texts.map((t) => ({ event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } })),
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

testAsync('ai: Claude request shape and streamed text (real SDK)', () => withFetch(() => claudeStream(['## الخلاصة\n', 'حدّث دلوقتي.']), async (calls) => {
  const seen = [];
  const text = await explain({ provider: 'claude', key: 'sk-ant-test', model: 'claude-opus-5-5', prompt: 'P', onText: (t) => seen.push(t) });
  eq(text, '## الخلاصة\nحدّث دلوقتي.');
  eq(seen.at(-1), text);
  const c = calls[0];
  eq(new URL(c.url).pathname, '/v1/messages');
  eq(c.headers['x-api-key'], 'sk-ant-test');
  eq(c.headers['anthropic-dangerous-direct-browser-access'], 'true');
  eq(c.headers['anthropic-beta'].includes('server-side-fallback-2026-07-01'), true);
  eq([c.body.model, c.body.fallbacks, c.body.output_config, c.body.stream, c.body.messages], ['claude-opus-5-5', 'default', { effort: 'medium' }, true, [{ role: 'user', content: 'P' }]]);
  eq(c.body.system.includes('Egyptian Arabic'), true);
}));
testAsync('ai: Haiku sends neither effort nor fallbacks', () => withFetch(() => claudeStream(['ok']), async (calls) => {
  await explain({ provider: 'claude', key: 'k', model: 'claude-haiku-4-5', prompt: 'P', onText: () => {} });
  eq([calls[0].body.fallbacks, calls[0].body.output_config, calls[0].headers['anthropic-beta'] ?? null], [undefined, undefined, null]);
}));
testAsync('ai: Claude refusal and bad key map to typed errors', async () => {
  const code = (p) => p.then(() => 'none', (e) => (e instanceof AiError ? e.code : `raw ${e}`));
  eq(await withFetch(() => claudeStream([], 'refusal'), () => code(explain({ provider: 'claude', key: 'k', model: 'claude-opus-5-5', prompt: 'P', onText: () => {} }))), 'refusal');
  const unauthorized = () => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  eq(await withFetch(unauthorized, () => code(explain({ provider: 'claude', key: 'bad', model: 'claude-opus-5-5', prompt: 'P', onText: () => {} }))), 'auth');
});
testAsync('ai: Gemini streams SSE text and skips thoughts', () => withFetch(() => sse([
  { data: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: '## الخلاصة\n' }] } }] } },
  { data: { candidates: [{ content: { parts: [{ text: 'استنى.' }] }, finishReason: 'STOP' }] } },
]), async (calls) => {
  const text = await explain({ provider: 'gemini', key: 'AIza-test', model: 'gemini-x-flash', prompt: 'P', onText: () => {} });
  eq(text, '## الخلاصة\nاستنى.');
  eq(calls[0].url.endsWith('/models/gemini-x-flash:streamGenerateContent?alt=sse'), true);
  eq(calls[0].headers['x-goog-api-key'], 'AIza-test');
  eq(calls[0].body.contents, [{ role: 'user', parts: [{ text: 'P' }] }]);
}));
testAsync('ai: Gemini model list prefers the newest stable flash', () => withFetch(() => new Response(JSON.stringify({ models: [
  { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.0-flash', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.0-flash-lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.0-pro', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  { name: 'models/gemini-3.0-flash-tts', supportedGenerationMethods: ['generateContent'] },
] }), { status: 200 }), async () => {
  eq(await geminiModels('k'), ['gemini-3.0-flash', 'gemini-2.0-flash', 'gemini-3.0-pro', 'gemini-3.0-flash-lite', 'gemini-3.5-flash-preview']);
}));
testAsync('ai: prompt carries facts, changelog and the project lines that use the API', async () => {
  const p = {
    name: 'equatable', current: '2.0.8', latest: '3.0.0', constraint: '^2.0.5', section: 'main', category: 'breaking',
    reasons: ['major-bump'], native: false, requires: { sdk: '^3.12.0' }, note: '', usage: ['lib/a.dart', 'lib/b.dart'],
    changelog: '## 3.0.0\n- **BREAKING** remove `EquatableMixin`',
  };
  const files = {
    'lib/a.dart': "import 'package:equatable/equatable.dart';\nclass A with EquatableMixin {\n  int x = 1;\n}",
    'lib/b.dart': "import 'package:equatable/equatable.dart';\nclass B extends Equatable {}",
  };
  const excerpts = await codeExcerpts(p, async (path) => files[path]);
  eq(excerpts, "lib/a.dart:1: import 'package:equatable/equatable.dart';\nlib/a.dart:2: class A with EquatableMixin {\nlib/b.dart:1: import 'package:equatable/equatable.dart';");
  const prompt = buildPrompt(p, { toolchain: { version: '3.47.7', dart: '3.13.5' }, families: {} }, excerpts);
  eq(prompt.includes('upgrade: 2.0.8 -> 3.0.0'), true);
  eq(prompt.includes('<changelog from="2.0.8" to="3.0.0">'), true);
  eq(prompt.includes('lib/a.dart:2: class A with EquatableMixin {'), true);
  eq(prompt.includes('project toolchain: Flutter 3.47.7 (Dart 3.13.5)'), true);
});

// ---------- report ----------
await chain;
const failed = results.filter((r) => !r.ok);
document.getElementById('out').textContent = results
  .map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`).join('\n');
document.getElementById('summary').textContent = `${results.length - failed.length}/${results.length} passed`;
document.body.dataset.status = failed.length ? 'fail' : 'pass';
