// pub.dev and Flutter-release lookups. Everything here is CORS-enabled upstream,
// so the page needs no server.

import { readFromTarGz } from './tar.js';

const PUB = 'https://pub.dev/api';
const memo = new Map();

function once(key, load) {
  if (!memo.has(key)) memo.set(key, load().catch((e) => { memo.delete(key); throw e; }));
  return memo.get(key);
}

async function json(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** `{latest: {version, pubspec, archive_url, published}, versions[], isDiscontinued?, replacedBy?}` or null. */
export const packageInfo = (name) => once(`p:${name}`, () => json(`${PUB}/packages/${name}`));

/** `{grantedPoints, maxPoints, likeCount, downloadCount30Days, tags}` or null. */
export const packageScore = (name) => once(`s:${name}`, () => json(`${PUB}/packages/${name}/score`));

export const packageAdvisories = (name) =>
  once(`a:${name}`, async () => (await json(`${PUB}/packages/${name}/advisories`))?.advisories ?? []);

/** The CHANGELOG.md shipped inside the archive of `version`, or ''. */
export const packageChangelog = (archiveUrl) =>
  once(`c:${archiveUrl}`, async () => {
    const res = await fetch(archiveUrl);
    if (!res.ok) return '';
    return (await readFromTarGz(await res.arrayBuffer())) ?? '';
  });

/** Stable Flutter releases, newest first: `[{version, dart, date}]`. */
export const flutterReleases = () =>
  once('flutter', async () => {
    const data = await json('https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json');
    const seen = new Set();
    return (data?.releases ?? [])
      .filter((r) => r.channel === 'stable' && r.dart_sdk_version && !seen.has(r.version) && seen.add(r.version))
      .map((r) => ({ version: r.version, dart: r.dart_sdk_version.split(' ')[0], date: r.release_date }));
  });

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
