// Orchestrates one scan: repo → pubspec/lock → pub.dev facts → verdicts → plan.

import { classify, families, plan, CATEGORIES } from './classify.js';
import { markHits, parseNotes } from './notes.js';
import { advisoryAffects, changelogSlice, parseEnvironment, parseLock, parseName, parsePubspec } from './pubspec.js';
import { flutterReleases, packageAdvisories, packageChangelog, packageInfo, packageScore, pool } from './pub.js';
import { Constraint, Version } from './semver.js';

const IGNORED_DIRS = /(^|\/)(build|\.dart_tool|\.symlinks|ephemeral|Pods|node_modules)\//;

/** Directories ('' = root) holding a pubspec.yaml, root first. */
export function pubspecDirs(paths) {
  return paths
    .filter((p) => /(^|\/)pubspec\.yaml$/.test(p) && !IGNORED_DIRS.test(p))
    .map((p) => p.replace(/\/?pubspec\.yaml$/, ''))
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

const join = (dir, file) => (dir ? `${dir}/${file}` : file);

/** The Flutter the project pins (.fvmrc / .fvm/fvm_config.json / .tool-versions), else latest stable. */
async function toolchain(gh, owner, repo, ref, dir, override) {
  const releases = await flutterReleases().catch(() => []);
  const find = (v) => releases.find((r) => r.version === v);
  if (override && find(override)) return { ...find(override), source: 'manual' };
  for (const base of new Set([dir, ''])) {
    const fvmrc = await gh.file(owner, repo, ref, join(base, '.fvmrc'));
    const legacy = !fvmrc && (await gh.file(owner, repo, ref, join(base, '.fvm/fvm_config.json')));
    const tools = !fvmrc && !legacy && (await gh.file(owner, repo, ref, join(base, '.tool-versions')));
    let v = null;
    try {
      if (fvmrc) v = JSON.parse(fvmrc).flutter;
      else if (legacy) v = JSON.parse(legacy).flutterSdkVersion;
      else if (tools) v = /^flutter\s+([\d.]+)/m.exec(tools)?.[1];
    } catch { /* malformed file: fall through */ }
    if (v && find(v)) return { ...find(v), source: fvmrc ? '.fvmrc' : legacy ? 'fvm_config.json' : '.tool-versions' };
    if (v) return { version: v, dart: null, source: 'unknown-version' };
  }
  const latest = releases[0];
  return latest ? { ...latest, source: 'latest' } : { version: null, dart: null, source: 'none' };
}

/**
 * @param o {{gh, owner, repo, ref, dir, paths: string[], usage: boolean, flutter?: string,
 *   onProgress: (stage: string, done: number, total: number) => void}}
 */
export async function scan(o) {
  const { gh, owner, repo, ref, dir, onProgress = () => {} } = o;
  onProgress('files', 0, 1);
  const pubspecText = await gh.file(owner, repo, ref, join(dir, 'pubspec.yaml'));
  if (pubspecText == null) throw Object.assign(new Error('no-pubspec'), { code: 'no-pubspec' });
  const lockText = await gh.file(owner, repo, ref, join(dir, 'pubspec.lock'));
  const lock = lockText ? parseLock(lockText) : {};
  const tc = await toolchain(gh, owner, repo, ref, dir, o.flutter);
  const dart = Version.parse(tc.dart);
  const flutter = Version.parse(tc.version);
  const now = new Date();

  const deps = parsePubspec(pubspecText).filter((d) => d.source !== 'sdk');
  let done = 0;
  const rows = await pool(deps, 8, async (dep) => {
    const row = await facts(dep, lock[dep.name], { dart, flutter, now });
    onProgress('packages', ++done, deps.length);
    return row;
  });

  if (o.usage) await usage(o, rows, onProgress);

  const repoBy = Object.fromEntries(rows.filter((r) => r.repository).map((r) => [r.name, r.repository]));
  const fams = families(repoBy);
  for (const [key, members] of Object.entries(fams)) for (const m of members) rows.find((r) => r.name === m).family = key;
  rows.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.name.localeCompare(b.name));
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, rows.filter((r) => r.category === c).length]));

  return {
    owner, repo, ref, dir,
    project: parseName(pubspecText),
    environment: parseEnvironment(pubspecText),
    hasLock: !!lockText,
    toolchain: tc,
    scannedAt: now.toISOString(),
    rows,
    counts,
    families: fams,
    batches: plan(rows, fams),
    usageTruncated: !!rows.usageTruncated,
  };
}

async function facts(dep, lockEntry, { dart, flutter, now }) {
  const constraintMin = Constraint.parse(dep.constraint)?.min;
  const current = Version.parse(lockEntry?.version) ?? constraintMin ?? null;
  const row = {
    name: dep.name, section: dep.section, source: dep.source, constraint: dep.constraint, note: dep.note,
    current: current?.toString() ?? null, fromLock: !!lockEntry,
  };
  let info = null;
  try {
    info = await packageInfo(dep.name);
  } catch {
    row.error = 'pub';
  }
  if (!info) {
    Object.assign(row, classify({ dep, now, current }), { latest: null, onPub: false });
    return row;
  }
  const [score, advisories] = await Promise.all([
    packageScore(dep.name).catch(() => null),
    packageAdvisories(dep.name).catch(() => []),
  ]);
  const latest = Version.parse(info.latest.version);
  const spec = info.latest.pubspec || {};
  const hasUpdate = !!(current && latest && latest.gt(current));
  const affecting = current ? advisories.filter((a) => advisoryAffects(a, dep.name, current)) : [];
  let changelog = '';
  if (hasUpdate && info.latest.archive_url) {
    changelog = changelogSlice(await packageChangelog(info.latest.archive_url).catch(() => ''), current, latest);
  }
  const notes = changelog ? parseNotes(changelog) : null;
  const sdkOk = !dart || !Constraint.parse(spec.environment?.sdk) || Constraint.parse(spec.environment.sdk).allows(dart);
  const flutterOk = !flutter || !Constraint.parse(spec.environment?.flutter) ||
    Constraint.parse(spec.environment.flutter).allows(flutter);
  const native = !!spec.flutter?.plugin;
  const published = info.latest.published ? new Date(info.latest.published) : null;
  const currentRelease = info.versions?.find((v) => v.version === row.current);

  Object.assign(row, classify({
    dep, now, current, latest, latestPublished: published, changelog,
    changelogBreaking: notes ? notes.breaking.length > 0 : undefined,
    advisories: affecting.length, native, sdkCompatible: sdkOk && flutterOk,
    discontinued: !!info.isDiscontinued,
  }), {
    onPub: true,
    latest: info.latest.version,
    latestPublished: info.latest.published ?? null,
    currentPublished: currentRelease?.published ?? null,
    discontinued: !!info.isDiscontinued,
    replacedBy: info.replacedBy ?? null,
    native,
    requires: { sdk: spec.environment?.sdk ?? null, flutter: spec.environment?.flutter ?? null },
    repository: spec.repository || spec.homepage || null,
    changelog,
    notes,
    advisories: affecting.map((a) => ({
      id: a.id,
      summary: a.summary || '',
      severity: a.database_specific?.severity || null,
      url: a.database_specific?.pub_display_url || `https://osv.dev/vulnerability/${a.id}`,
      fixed: fixedVersion(a, dep.name),
    })),
    score: score && {
      points: score.grantedPoints, maxPoints: score.maxPoints, likes: score.likeCount,
      downloads: score.downloadCount30Days,
    },
  });
  return row;
}

function fixedVersion(advisory, name) {
  for (const a of advisory.affected || []) {
    if (a.package?.name !== name) continue;
    for (const r of a.ranges || []) for (const e of r.events || []) if (e.fixed) return e.fixed;
  }
  return null;
}

/** Which lib/ and bin/ files import each package (`package:<name>/`). */
async function usage(o, rows, onProgress) {
  const prefix = o.dir ? `${o.dir}/` : '';
  const files = o.paths.filter((p) => p.startsWith(prefix) && /^(lib|bin)\/.*\.dart$/.test(p.slice(prefix.length)) &&
    !/\.(g|freezed|gr|config|mocks)\.dart$/.test(p));
  const limit = 3000;
  const picked = files.slice(0, limit);
  const byPkg = {};
  const words = {}; // identifiers in the files importing each package
  let done = 0;
  await pool(picked, 12, async (path) => {
    const text = await o.gh.file(o.owner, o.repo, o.ref, path).catch(() => null);
    const imported = new Set([...(text || '').matchAll(/['"]package:([a-z0-9_]+)\//g)].map((m) => m[1]));
    if (!imported.size) return onProgress('usage', ++done, picked.length);
    const ids = new Set((text.match(/[A-Za-z_$][\w$]{2,}/g)) || []);
    for (const pkg of imported) {
      (byPkg[pkg] ||= new Set()).add(path.slice(prefix.length));
      const set = (words[pkg] ||= new Set());
      for (const id of ids) set.add(id);
    }
    onProgress('usage', ++done, picked.length);
  });
  for (const r of rows) {
    r.usage = [...(byPkg[r.name] || [])].sort();
    markHits(r.notes, r.name, words[r.name]);
  }
  rows.usageTruncated = files.length > limit;
}
