// Page controller: form → locate repo → scan → render. State lives in the URL
// (?repo=owner/name&ref=…&path=…) so every report is a shareable link.

import { CATEGORIES } from './classify.js';
import { GitHub, GitHubError, parseRepoInput } from './github.js';
import { BATCH, CATEGORY, ERROR, REASON, SECTION, STAGE, TOOLCHAIN_SOURCE } from './labels.js';
import { esc, markdown } from './md.js';
import { flutterReleases } from './pub.js';
import { pubspecDirs, scan } from './scan.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } },
};
let sessionToken = store.get('fdw.token') || '';
const state = { report: null, filter: null, query: '', all: false, busy: false };

// ---------- theme ----------
const savedTheme = store.get('fdw.theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$('theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('fdw.theme', next);
});

// ---------- settings ----------
$('settings-btn').addEventListener('click', () => {
  $('token-input').value = sessionToken;
  $('token-remember').checked = !!store.get('fdw.token');
  $('settings').showModal();
});
$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  sessionToken = $('token-input').value.trim();
  store.set('fdw.token', $('token-remember').checked && sessionToken ? sessionToken : null);
  toast(sessionToken ? 'اتحفظ الـ token' : 'اتشال الـ token');
});

// ---------- toolchain picker ----------
flutterReleases().then((releases) => {
  const sel = $('flutter-select');
  for (const r of releases.slice(0, 40)) {
    const o = document.createElement('option');
    o.value = r.version;
    o.textContent = `${r.version} · Dart ${r.dart}`;
    sel.append(o);
  }
  const wanted = new URLSearchParams(location.search).get('flutter');
  if (wanted) sel.value = wanted;
}).catch(() => {});

// ---------- recent ----------
function recent() {
  try { return JSON.parse(store.get('fdw.recent') || '[]'); } catch { return []; }
}
function remember(slug) {
  store.set('fdw.recent', JSON.stringify([slug, ...recent().filter((s) => s !== slug)].slice(0, 8)));
  renderRecent();
}
function renderRecent() {
  const list = recent();
  const box = $('recent');
  box.hidden = !list.length;
  box.innerHTML = `<span class="muted">آخر حاجات:</span>` +
    list.map((s) => `<button type="button" class="chip" data-slug="${esc(s)}">${esc(s)}</button>`).join('');
}
$('recent').addEventListener('click', (e) => {
  const slug = e.target.closest('[data-slug]')?.dataset.slug;
  if (!slug) return;
  $('repo-input').value = slug;
  start(slug);
});

// ---------- flow ----------
$('scan-form').addEventListener('submit', (e) => {
  e.preventDefault();
  start($('repo-input').value);
});

async function start(input, chosenDir) {
  if (state.busy) return;
  hide('error'); hide('picker');
  let target;
  try {
    target = parseRepoInput(input);
  } catch (e) {
    return fail(e);
  }
  setBusy(true);
  progress(STAGE.locate, 0);
  const gh = new GitHub(sessionToken);
  try {
    const info = await gh.repo(target.owner, target.repo);
    const ref = target.ref || info.defaultBranch;
    const { paths, truncated } = await gh.tree(target.owner, target.repo, ref);
    const dirs = pubspecDirs(paths);
    if (!dirs.length) throw Object.assign(new Error(), { code: 'no-flutter' });
    let dir = chosenDir ?? target.path;
    if (dir == null) {
      const apps = dirs.filter((d) => !/(^|\/)example$/.test(d));
      if (apps.length > 1) {
        setBusy(false);
        hide('progress');
        return pick(input, apps);
      }
      dir = apps[0] ?? dirs[0];
    }
    const usage = $('usage-check').checked;
    const report = await scan({
      gh, owner: target.owner, repo: target.repo, ref, dir, paths, usage,
      flutter: $('flutter-select').value || undefined,
      onProgress: (stage, done, total) => progress(
        total > 1 ? `${STAGE[stage]} (${done}/${total})` : STAGE[stage], total ? done / total : 0),
    });
    report.treeTruncated = truncated;
    report.private = info.private;
    report.usageScanned = usage;
    state.report = report;
    state.filter = null;
    const slug = `${target.owner}/${target.repo}`;
    remember(slug);
    const q = new URLSearchParams({ repo: slug });
    if (target.ref) q.set('ref', ref);
    if (dir || dirs.length > 1) q.set('path', dir);
    if ($('flutter-select').value) q.set('flutter', $('flutter-select').value);
    history.replaceState(null, '', `?${q}`);
    document.title = `${report.project || target.repo} · Flutter Deps Watch`;
    render();
  } catch (e) {
    fail(e);
  } finally {
    setBusy(false);
    hide('progress');
  }
}

function pick(input, dirs) {
  $('picker-list').innerHTML = dirs
    .map((d) => `<button type="button" class="chip" data-dir="${esc(d)}">${esc(d || '/ (الجذر)')}</button>`).join('');
  show('picker');
  $('picker-list').onclick = (e) => {
    const b = e.target.closest('[data-dir]');
    if (b) start(input, b.dataset.dir);
  };
}

function fail(e) {
  const code = e instanceof GitHubError || e?.code ? e.code : 'unknown';
  console.error(e);
  $('error').textContent = ERROR[code] || ERROR.unknown;
  show('error');
}

function setBusy(on) {
  state.busy = on;
  $('scan-btn').disabled = on;
  $('scan-btn').textContent = on ? 'بيفحص…' : 'افحص';
}

function progress(text, frac) {
  show('progress');
  $('progress-text').textContent = text;
  $('progress-fill').style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
}

// ---------- render ----------
function render() {
  const r = state.report;
  show('report');
  $('hero').hidden = true;
  renderProject(r);
  renderStrip(r);
  renderSecurity(r);
  renderPlan(r);
  renderLedger();
}

function renderProject(r) {
  const tc = r.toolchain;
  const where = `${r.owner}/${r.repo}` + (r.dir ? `/${r.dir}` : '');
  const ghUrl = `https://github.com/${r.owner}/${r.repo}/tree/${encodeURIComponent(r.ref)}${r.dir ? `/${r.dir}` : ''}`;
  $('project').innerHTML = `
    <div>
      <h2>${esc(r.project || r.repo)}</h2>
      <div class="project-meta">
        <span dir="ltr"><a href="${esc(ghUrl)}" target="_blank" rel="noopener">${esc(where)}</a> @ ${esc(r.ref)}</span>
        <span>Flutter <b dir="ltr">${esc(tc.version || '—')}</b>${tc.dart ? ` · Dart <b dir="ltr">${esc(tc.dart)}</b>` : ''} — ${esc(TOOLCHAIN_SOURCE[tc.source] || '')}</span>
        <span>${r.rows.length} باكدج · اتفحص ${esc(new Date(r.scannedAt).toLocaleString('ar-EG'))}</span>
        ${r.hasLock ? '' : '<span class="warn">مفيش pubspec.lock في الـ repo — النسخ الحالية متقدّرة من الـ constraints</span>'}
        ${r.treeTruncated || r.usageTruncated ? '<span class="warn">الـ repo كبير؛ عدّ الاستخدام ناقص</span>' : ''}
      </div>
    </div>
    <div class="project-actions">
      <button type="button" class="btn sm" id="copy-link">انسخ لينك التقرير</button>
      <button type="button" class="btn sm" id="copy-md">انسخ التقرير Markdown</button>
      <button type="button" class="btn sm" id="rescan">افحص تاني</button>
    </div>`;
  $('copy-link').onclick = () => copy(location.href, 'اتنسخ اللينك');
  $('copy-md').onclick = () => copy(toMarkdown(r), 'اتنسخ التقرير — حطه في PR أو issue');
  $('rescan').onclick = () => start(`https://github.com/${r.owner}/${r.repo}/tree/${r.ref}`, r.dir);
}

function renderStrip(r) {
  $('strip').innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="tile${r.counts[c] ? '' : ' zero'}" style="--c: var(--${c})" data-cat="${c}"
            aria-pressed="${state.filter === c}" title="${esc(CATEGORY[c].hint)}">
      <b>${r.counts[c]}</b><span>${esc(CATEGORY[c].label)}</span>
    </button>`).join('');
  $('strip').onclick = (e) => {
    const c = e.target.closest('[data-cat]')?.dataset.cat;
    if (!c) return;
    state.filter = state.filter === c ? null : c;
    if (c === 'upToDate') state.all = $('show-all').checked = true;
    renderStrip(r);
    renderLedger();
    $('ledger').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
}

function renderSecurity(r) {
  const hits = r.rows.filter((p) => p.advisories?.length);
  $('security').innerHTML = !hits.length ? '' : `
    <div class="alert sec" role="alert">
      <h3>${hits.length === 1 ? 'باكدج عليه ثغرة أمنية' : `${hits.length} باكدجات عليهم ثغرات أمنية`}</h3>
      <ul>${hits.flatMap((p) => p.advisories.map((a) => `
        <li><span class="pkg-chip">${esc(p.name)} ${esc(p.current)}</span>
          <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.id)}</a>
          ${a.severity ? `<b>${esc(a.severity)}</b>` : ''} — <span dir="ltr">${esc(a.summary)}</span>
          ${a.fixed ? ` · اتصلحت في <b dir="ltr">${esc(a.fixed)}</b>` : ''}</li>`)).join('')}
      </ul>
    </div>`;
}

function renderPlan(r) {
  $('plan-section').hidden = !r.batches.length;
  $('plan').innerHTML = r.batches.map((b, i) => `
    <article class="batch">
      <div class="batch-n">${i + 1}</div>
      <div>
        <h3>${esc(BATCH[b.id].title)}
          <span class="badge ${b.store ? 'store' : 'ota'}">${b.store ? 'store release' : 'Dart بس · OTA'}</span>
        </h3>
        <p class="muted">${esc(BATCH[b.id].why)}</p>
        <div class="pkgs">${b.rows.map((p) => `<span class="pkg-chip" title="${esc(CATEGORY[p.category].label)}">${esc(p.name)} ${esc(p.current)} → ${esc(p.latest)}</span>`).join('')}</div>
        <div class="cmd"><code>${esc(b.command)}</code><button type="button" class="btn sm" data-copy="${esc(b.command)}">انسخ</button></div>
      </div>
    </article>`).join('');
}
$('plan').addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copy(b.dataset.copy, 'اتنسخ الأمر');
});

$('filter-input').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderLedger(); });
$('show-all').addEventListener('change', (e) => { state.all = e.target.checked; renderLedger(); });

function renderLedger() {
  const r = state.report;
  if (!r) return;
  const rows = r.rows.filter((p) =>
    (state.filter ? p.category === state.filter : state.all || p.category !== 'upToDate') &&
    (!state.query || p.name.includes(state.query)));
  $('ledger').innerHTML = rows.length ? rows.map(pkgCard).join('') :
    `<div class="empty muted">${state.query ? 'مفيش باكدج بالاسم ده.' : 'كله محدّث هنا 👌'}</div>`;
}

const date = (iso) => (iso ? new Date(iso).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const num = (n) => (n == null ? '—' : Intl.NumberFormat('en', { notation: 'compact' }).format(n));

function pkgCard(p) {
  const r = state.report;
  const update = p.latest && p.current !== p.latest;
  const otaBadge = p.ota === true ? '<span class="badge ota">OTA</span>' :
    p.ota === false ? '<span class="badge store">native</span>' : '';
  const usage = !r.usageScanned ? '' : `${p.usage?.length ?? 0} فايل`;
  const pubUrl = `https://pub.dev/packages/${encodeURIComponent(p.name)}`;
  const command = update && !p.locked ? (p.reasons.includes('outside-constraint') || p.reasons.includes('major-bump')
    ? `flutter pub add ${p.section === 'dev' ? '--dev ' : ''}${p.name}:^${p.latest}` : `flutter pub upgrade ${p.name}`) : '';
  return `
  <details class="pkg" style="--c: var(--${p.category})">
    <summary>
      <div>
        <div class="pkg-name">${esc(p.name)}</div>
        <div class="pkg-ver">${esc(p.current ?? '?')}${update ? ` → <b>${esc(p.latest)}</b>` : ''}${p.constraint ? ` · ${esc(p.constraint)}` : ''}</div>
      </div>
      <div class="pkg-badges">
        <span class="badge cat">${esc(CATEGORY[p.category].label)}</span>${otaBadge}
        ${p.section !== 'main' ? `<span class="badge neutral">${esc(p.section === 'dev' ? 'dev' : 'override')}</span>` : ''}
      </div>
      ${p.reasons.length || usage ? `<div class="pkg-sub">${p.reasons.map((x) => esc(REASON[x] || x)).join(' · ')}${p.reasons.length && usage ? ' · ' : ''}${usage}</div>` : ''}
    </summary>
    <div class="pkg-body">
      ${p.note ? `<div class="block-title">التعليق اللي فوقه في pubspec</div><div class="note">${esc(p.note)}</div>` : ''}
      <dl class="facts">
        <div><dt>القسم</dt><dd>${esc(SECTION[p.section])}${p.source !== 'hosted' ? ` (${esc(p.source)})` : ''}</dd></div>
        <div><dt>النسخة الحالية</dt><dd>${esc(p.current ?? '—')}${p.fromLock ? '' : ' *'}</dd></div>
        <div><dt>آخر نسخة</dt><dd>${esc(p.latest ?? '—')} · ${esc(date(p.latestPublished))}</dd></div>
        <div><dt>محتاج</dt><dd>${esc(p.requires?.sdk ? `Dart ${p.requires.sdk}` : '—')}${p.requires?.flutter ? `<br>Flutter ${esc(p.requires.flutter)}` : ''}</dd></div>
        <div><dt>pub points · likes · تحميلات/شهر</dt><dd>${p.score ? `${p.score.points}/${p.score.maxPoints} · ${num(p.score.likes)} · ${num(p.score.downloads)}` : '—'}</dd></div>
        ${p.family ? `<div><dt>عيلة (بتتحدّث مع بعض)</dt><dd>${esc(r.families[p.family].join(', '))}</dd></div>` : ''}
        ${p.replacedBy ? `<div><dt>البديل الرسمي</dt><dd><a href="https://pub.dev/packages/${esc(p.replacedBy)}" target="_blank" rel="noopener">${esc(p.replacedBy)}</a></dd></div>` : ''}
      </dl>
      ${p.advisories?.length ? `<div class="block-title">ثغرات</div><ul>${p.advisories.map((a) => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.id)}</a> <span dir="ltr">${esc(a.summary)}</span>${a.fixed ? ` — اتصلحت في ${esc(a.fixed)}` : ''}</li>`).join('')}</ul>` : ''}
      ${command ? `<div class="block-title">أمر التحديث</div><div class="cmd"><code>${esc(command)}</code><button type="button" class="btn sm" data-copy="${esc(command)}">انسخ</button></div>` : ''}
      ${update ? `<div class="block-title">الجديد من ${esc(p.current)} لـ ${esc(p.latest)}</div>${p.changelog ? `<div class="changelog">${markdown(p.changelog)}</div>` : '<p class="muted small">الباكدج مفيهوش CHANGELOG.md بنسخ واضحة — شوفه على pub.dev.</p>'}` : ''}
      ${p.usage?.length ? `<div class="block-title">مستخدم في</div><ul class="files">${p.usage.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
      <div class="links">
        ${p.onPub ? `<a href="${pubUrl}" target="_blank" rel="noopener">pub.dev</a><a href="${pubUrl}/changelog" target="_blank" rel="noopener">الـ changelog كله</a>` : ''}
        ${p.repository ? `<a href="${esc(p.repository)}" target="_blank" rel="noopener">الكود</a>` : ''}
      </div>
    </div>
  </details>`;
}
$('ledger').addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copy(b.dataset.copy, 'اتنسخ الأمر');
});

// ---------- markdown export ----------
function toMarkdown(r) {
  const lines = [
    `## Dependency report — \`${r.owner}/${r.repo}${r.dir ? `/${r.dir}` : ''}\` @ \`${r.ref}\``,
    '',
    `Flutter ${r.toolchain.version ?? '?'} (Dart ${r.toolchain.dart ?? '?'}) · ${r.rows.length} packages · ${r.scannedAt.slice(0, 10)}`,
    '',
    CATEGORIES.map((c) => `**${c}** ${r.counts[c]}`).join(' · '),
    '',
  ];
  if (r.batches.length) {
    lines.push('### Upgrade order', '');
    r.batches.forEach((b, i) => {
      lines.push(`${i + 1}. **${b.id}**${b.store ? ' (store release)' : ''}: ${b.rows.map((p) => `\`${p.name}\` ${p.current} → ${p.latest}`).join(', ')}`);
      lines.push(`   \`${b.command}\``);
    });
    lines.push('');
  }
  const flagged = r.rows.filter((p) => p.category !== 'upToDate');
  if (flagged.length) {
    lines.push('| package | current | latest | verdict | why |', '|---|---|---|---|---|');
    for (const p of flagged) lines.push(`| \`${p.name}\` | ${p.current ?? ''} | ${p.latest ?? ''} | ${p.category} | ${p.reasons.join(', ')} |`);
  }
  lines.push('', `_Generated by [Flutter Deps Watch](${location.href})_`);
  return lines.join('\n');
}

// ---------- helpers ----------
function show(id) { $(id).hidden = false; }
function hide(id) { $(id).hidden = true; }
async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast('مقدرتش أنسخ — انسخه بإيدك');
  }
}
let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  show('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide('toast'), 2200);
}

// ---------- boot ----------
renderRecent();
const params = new URLSearchParams(location.search);
if (params.get('repo')) {
  const ref = params.get('ref');
  const path = params.get('path');
  const input = `https://github.com/${params.get('repo')}${ref ? `/tree/${ref}${path ? `/${path}` : ''}` : ''}`;
  $('repo-input').value = params.get('repo');
  start(input, path ?? undefined);
}
