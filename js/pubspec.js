// Text parsers for pubspec.yaml, pubspec.lock, CHANGELOG slices and OSV advisories.
//
// The pubspec parser is line-based on purpose: it keeps the COMMENTS above each
// dependency, because that is where projects document pins and forks
// ("DO NOT bump", "pinned because …") — and those notes decide whether a package
// may be touched at all.

import { Version } from './semver.js';

const SECTIONS = { dependencies: 'main', dev_dependencies: 'dev', dependency_overrides: 'override' };
const TOP_LEVEL = /^([A-Za-z_][\w-]*):/;
const ENTRY = /^  ([a-z0-9_]+):\s*(.*)$/;
const CHILD = /^    (path|git|sdk|hosted|version):\s*(.*)$/;

function splitComment(value) {
  const hash = value.indexOf(' #');
  const strip = (s) => s.trim().replace(/["']/g, '');
  if (hash < 0) return [strip(value), ''];
  return [strip(value.slice(0, hash)), value.slice(hash + 2).trim()];
}

/** @returns {{name, section, source, constraint, note}[]} */
export function parsePubspec(text) {
  const deps = [];
  const comments = [];
  let section = null;
  let cur = null;

  const flush = () => {
    if (cur && section) {
      deps.push({
        name: cur.name,
        section,
        source: cur.source,
        constraint: cur.source === 'hosted' ? cur.constraint : null,
        note: [cur.note, cur.inline].filter(Boolean).join('\n'),
      });
    }
    cur = null;
  };

  for (const line of text.replace(/\r/g, '').split('\n')) {
    const top = TOP_LEVEL.exec(line);
    if (top) {
      flush();
      comments.length = 0;
      section = SECTIONS[top[1]] || null;
      continue;
    }
    if (!section) continue;
    const trimmed = line.trim();
    if (!trimmed) {
      comments.length = 0;
      continue;
    }
    if (line.startsWith('  #')) {
      flush();
      comments.push(trimmed.slice(1).trim());
      continue;
    }
    const entry = ENTRY.exec(line);
    if (entry) {
      flush();
      const [constraint, inline] = splitComment(entry[2]);
      cur = { name: entry[1], constraint: constraint || null, inline, source: 'hosted', note: comments.join('\n') };
      comments.length = 0;
      continue;
    }
    const child = CHILD.exec(line);
    if (child && cur) {
      if (child[1] === 'version') cur.constraint = splitComment(child[2])[0];
      else if (child[1] !== 'hosted') cur.source = child[1];
    }
  }
  flush();
  return deps;
}

/** The `environment:` block — `{sdk, flutter}` constraint strings when present. */
export function parseEnvironment(text) {
  const env = {};
  let inEnv = false;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (TOP_LEVEL.test(line)) {
      inEnv = line.startsWith('environment:');
      continue;
    }
    const m = inEnv && /^  (sdk|flutter):\s*(.*)$/.exec(line);
    if (m) env[m[1]] = splitComment(m[2])[0];
  }
  return env;
}

/** The `name:` of the pubspec. */
export function parseName(text) {
  return /^name:\s*([\w-]+)/m.exec(text)?.[1] ?? null;
}

const LOCK_NAME = /^  ([a-z0-9_]+):$/;
const LOCK_FIELD = /^    (dependency|source|version): "?([^"]*)"?$/;

/** @returns {Object<string, {version, dependency, source}>} */
export function parseLock(text) {
  const result = {};
  let name = null;
  let fields = {};
  const flush = () => {
    if (name && fields.version) {
      result[name] = {
        version: fields.version,
        dependency: fields.dependency || 'transitive',
        source: fields.source || 'hosted',
      };
    }
    fields = {};
  };
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const start = LOCK_NAME.exec(line);
    if (start) {
      flush();
      name = start[1];
      continue;
    }
    const field = LOCK_FIELD.exec(line);
    if (field && name) fields[field[1]] = field[2];
  }
  flush();
  return result;
}

const HEADING_VERSION = /^#{1,4}\s*\[?v?(\d+\.\d+\.\d+[0-9A-Za-z.+\-]*)/;

/** The CHANGELOG sections for versions in (from, to], trimmed to maxChars. '' when none. */
export function changelogSlice(changelog, from, to, maxChars = 12000) {
  const out = [];
  let size = 0;
  let keep = false;
  for (const line of changelog.replace(/\r/g, '').split('\n')) {
    const m = HEADING_VERSION.exec(line.trim());
    if (m) {
      const v = Version.parse(m[1].replace(/[\]\s].*$/, ''));
      keep = !!v && (!from || v.gt(from)) && v.lte(to);
    }
    if (keep) {
      out.push(line);
      size += line.length + 1;
      if (size > maxChars) return out.join('\n').slice(0, maxChars) + '\n…';
    }
  }
  return out.join('\n').trim();
}

/** Whether an OSV advisory (pub.dev `/advisories` shape) affects `current`. */
export function advisoryAffects(advisory, pkg, current) {
  for (const a of advisory.affected || []) {
    if (a.package && a.package.name !== pkg) continue;
    if ((a.versions || []).includes(current.toString())) return true;
    for (const range of a.ranges || []) {
      if (inRange(range.events || [], current)) return true;
    }
  }
  return false;
}

function inRange(events, current) {
  let affected = false;
  for (const e of events) {
    if (e.introduced != null) {
      const v = e.introduced === '0' ? new Version(0, 0, 0) : Version.parse(e.introduced);
      if (v && current.gte(v)) affected = true;
    }
    const fixed = Version.parse(e.fixed);
    if (fixed && current.gte(fixed)) affected = false;
    const last = Version.parse(e.last_affected);
    if (last && current.gt(last)) affected = false;
  }
  return affected;
}
