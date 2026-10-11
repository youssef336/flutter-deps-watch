// Deterministic risk classification for one declared dependency, plus the
// upgrade plan built from those verdicts. Pure — no I/O.

import { Constraint, Version } from './semver.js';

/** Ordered most-urgent first; the page sorts by this order. */
export const CATEGORIES = ['security', 'locked', 'breaking', 'attention', 'abandoned', 'safe', 'upToDate'];

export const STALE_DAYS = 548; // ~18 months

const PINNED_NOTE = /do not bump|don't bump|do not upgrade|do not re-add|pinned|lockstep|capped by|move both together|keep at/i;
const BREAKING_TEXT = /breaking/i;
const DEPRECATION_TEXT = /deprecat/i;
const PLATFORM_FLOOR_TEXT = /minSdk|min sdk|compileSdk|deployment target|iOS 1[3-9]|AGP|Gradle [89]|Kotlin 2/i;

export function lockReasons(dep) {
  return [
    ...(dep.section === 'override' ? ['override'] : []),
    ...(dep.source !== 'hosted' ? ['non-hosted'] : []),
    ...(PINNED_NOTE.test(dep.note || '') ? ['pinned-note'] : []),
    ...(Version.parse(dep.constraint) ? ['exact-pin'] : []),
  ];
}

/**
 * @param f {{dep, now: Date, current?: Version, latest?: Version, latestPublished?: Date,
 *   changelog?: string, advisories?: number, native?: boolean|null, sdkCompatible?: boolean,
 *   discontinued?: boolean}}
 * @returns {{category: string, reasons: string[], locked: boolean, ota: boolean|null}}
 */
export function classify(f) {
  const locks = lockReasons(f.dep);
  const locked = locks.length > 0;
  const { current, latest } = f;
  const hasUpdate = !!(current && latest && latest.gt(current));
  const ota = !hasUpdate || f.native == null ? null : !f.native;
  const changelog = f.changelog || '';

  if (f.advisories > 0) return { category: 'security', reasons: ['advisory', ...locks], locked, ota };
  if (!hasUpdate) {
    const stale = staleReasons(f);
    return { category: stale.length ? 'abandoned' : 'upToDate', reasons: [...stale, ...locks], locked, ota: null };
  }
  if (locked) return { category: 'locked', reasons: locks, locked: true, ota };

  const constraint = Constraint.parse(f.dep.constraint);
  const breaking = [
    ...(current.isBreakingTo(latest) ? ['major-bump'] : []),
    ...(BREAKING_TEXT.test(changelog) ? ['changelog-breaking'] : []),
    ...(f.sdkCompatible === false ? ['needs-newer-sdk'] : []),
    ...(constraint && !constraint.allows(latest) ? ['outside-constraint'] : []),
  ];
  if (breaking.some((r) => r !== 'outside-constraint')) {
    return { category: 'breaking', reasons: breaking, locked: false, ota };
  }

  const attention = [
    ...(f.native === true ? ['native-plugin'] : []),
    ...(DEPRECATION_TEXT.test(changelog) ? ['changelog-deprecation'] : []),
    ...(PLATFORM_FLOOR_TEXT.test(changelog) ? ['platform-floor-raised'] : []),
    ...breaking,
  ];
  const stale = staleReasons(f);
  if (stale.length) return { category: 'abandoned', reasons: [...stale, ...attention], locked: false, ota };
  if (attention.length) return { category: 'attention', reasons: attention, locked: false, ota };
  return { category: 'safe', reasons: [], locked: false, ota };
}

function staleReasons(f) {
  const days = f.latestPublished ? (f.now - f.latestPublished) / 86400000 : 0;
  return [...(f.discontinued ? ['discontinued'] : []), ...(days > STALE_DAYS ? ['stale'] : [])];
}

/** Monorepos whose packages release independently — sharing one is no reason to move together. */
const INDEPENDENT = new Set(['flutter/packages', 'flutter/flutter']);

export function repoKey(url) {
  const m = /github\.com\/([^/\s]+)\/([^/\s#?]+)/.exec(url || '');
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}`.toLowerCase() : null;
}

/** Packages released from the same repository (firebase_*, riverpod + generator, *_plus …). */
export function families(repoByPackage) {
  const groups = {};
  for (const [pkg, url] of Object.entries(repoByPackage)) {
    const key = repoKey(url);
    if (key && !INDEPENDENT.has(key) && !key.startsWith('dart-lang/')) (groups[key] ||= []).push(pkg);
  }
  for (const k of Object.keys(groups)) {
    if (groups[k].length < 2) delete groups[k];
    else groups[k].sort();
  }
  return groups;
}

/** The command that moves `names` to their latest, given each package row. */
export function upgradeCommand(rows) {
  const inside = rows.filter((r) => !r.reasons.includes('outside-constraint') && !r.reasons.includes('major-bump'));
  const outside = rows.filter((r) => !inside.includes(r));
  const cmds = [];
  if (inside.length) cmds.push(`flutter pub upgrade ${inside.map((r) => r.name).join(' ')}`);
  if (outside.length) {
    const dev = outside.filter((r) => r.section === 'dev');
    const main = outside.filter((r) => r.section !== 'dev');
    if (main.length) cmds.push(`flutter pub add ${main.map((r) => `${r.name}:^${r.latest}`).join(' ')}`);
    if (dev.length) cmds.push(`flutter pub add --dev ${dev.map((r) => `${r.name}:^${r.latest}`).join(' ')}`);
  }
  return cmds.join(' && ');
}

/**
 * Ordered upgrade batches. A family never splits: it travels with its most
 * urgent member. Locked and abandoned packages are not batched.
 */
export function plan(rows, fams) {
  const rank = (r) => {
    if (r.category === 'security') return 0;
    if (r.category === 'safe') return r.ota === false ? 2 : 1;
    if (r.category === 'attention') return 3;
    if (r.category === 'breaking') return 4;
    return -1;
  };
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  const slot = {};
  for (const r of rows) slot[r.name] = rank(r);
  for (const members of Object.values(fams)) {
    const movable = members.map((m) => byName[m]).filter((r) => r && slot[r.name] >= 0);
    if (movable.length < 2) continue;
    const worst = movable.some((r) => slot[r.name] === 0) ? 0 : Math.max(...movable.map((r) => slot[r.name]));
    for (const r of movable) slot[r.name] = worst;
  }
  const batches = [
    { id: 'security', rows: [] },
    { id: 'safe-ota', rows: [] },
    { id: 'safe-native', rows: [] },
    { id: 'attention', rows: [] },
    { id: 'breaking', rows: [] },
  ];
  for (const r of rows) if (slot[r.name] >= 0) batches[slot[r.name]].rows.push(r);
  return batches
    .filter((b) => b.rows.length)
    .map((b) => ({ ...b, store: b.rows.some((r) => r.ota === false), command: upgradeCommand(b.rows) }));
}
