// Minimal pub-flavoured semver: `^x.y.z`, exact pins, `>=a <b` ranges, `any`,
// pre-release (`1.0.0-dev.8`) and build (`4.0.0+1`) suffixes. Pure — no I/O.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.\-]+))?(?:\+([0-9A-Za-z.\-]+))?$/;

const clean = (raw) => String(raw).trim().replace(/["']/g, '');

export class Version {
  constructor(major, minor, patch, pre = '', build = '') {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.pre = pre;
    this.build = build;
  }

  static parse(raw) {
    if (raw == null) return null;
    const m = VERSION.exec(clean(raw));
    if (!m) return null;
    return new Version(+m[1], +m[2], +m[3], m[4] || '', m[5] || '');
  }

  get isPreRelease() {
    return this.pre !== '';
  }

  /** First version a caret constraint on this version excludes. */
  get caretCeiling() {
    if (this.major > 0) return new Version(this.major + 1, 0, 0);
    if (this.minor > 0) return new Version(0, this.minor + 1, 0);
    return new Version(0, 0, this.patch + 1);
  }

  /** Whether `other` crosses this version's caret boundary — pub's meaning of "breaking". */
  isBreakingTo(other) {
    return other.compareTo(this.caretCeiling) >= 0;
  }

  compareTo(o) {
    for (const [a, b] of [[this.major, o.major], [this.minor, o.minor], [this.patch, o.patch]]) {
      if (a !== b) return a < b ? -1 : 1;
    }
    // A pre-release sorts before its release; a build suffix sorts after it.
    const pre = compareSuffix(this.pre, o.pre, false);
    return pre !== 0 ? pre : compareSuffix(this.build, o.build, true);
  }

  lt(o) { return this.compareTo(o) < 0; }
  gt(o) { return this.compareTo(o) > 0; }
  lte(o) { return this.compareTo(o) <= 0; }
  gte(o) { return this.compareTo(o) >= 0; }
  eq(o) { return this.compareTo(o) === 0; }

  toString() {
    return `${this.major}.${this.minor}.${this.patch}` +
      (this.pre ? `-${this.pre}` : '') + (this.build ? `+${this.build}` : '');
  }
}

function compareSuffix(a, b, emptyFirst) {
  if (a === b) return 0;
  if (a === '') return emptyFirst ? -1 : 1;
  if (b === '') return emptyFirst ? 1 : -1;
  const as = a.split('.');
  const bs = b.split('.');
  for (let i = 0; i < as.length && i < bs.length; i++) {
    const an = /^\d+$/.test(as[i]) ? +as[i] : null;
    const bn = /^\d+$/.test(bs[i]) ? +bs[i] : null;
    let cmp;
    if (an != null && bn != null) cmp = Math.sign(an - bn);
    else if (an != null) cmp = -1;
    else if (bn != null) cmp = 1;
    else cmp = as[i] < bs[i] ? -1 : as[i] > bs[i] ? 1 : 0;
    if (cmp !== 0) return cmp;
  }
  return Math.sign(as.length - bs.length);
}

/** A pubspec version constraint reduced to an optional half-open interval. */
export class Constraint {
  constructor({ min = null, max = null, includeMin = true, includeMax = false } = {}) {
    this.min = min;
    this.max = max;
    this.includeMin = includeMin;
    this.includeMax = includeMax;
  }

  /** Null for anything it does not understand (path/git/sdk deps carry no constraint). */
  static parse(raw) {
    if (raw == null) return null;
    const text = clean(raw);
    if (!text) return null;
    if (text === 'any') return new Constraint();
    if (text.startsWith('^')) {
      const v = Version.parse(text.slice(1));
      return v && new Constraint({ min: v, max: v.caretCeiling });
    }
    const exact = Version.parse(text);
    if (exact) return new Constraint({ min: exact, max: exact, includeMax: true });
    const c = new Constraint();
    let any = false;
    for (const m of text.matchAll(/(>=|<=|>|<)\s*([^\s<>=]+)/g)) {
      const v = Version.parse(m[2]);
      if (!v) return null;
      any = true;
      if (m[1] === '>=') Object.assign(c, { min: v, includeMin: true });
      if (m[1] === '>') Object.assign(c, { min: v, includeMin: false });
      if (m[1] === '<=') Object.assign(c, { max: v, includeMax: true });
      if (m[1] === '<') Object.assign(c, { max: v, includeMax: false });
    }
    return any ? c : null;
  }

  allows(v) {
    if (this.min && (this.includeMin ? v.lt(this.min) : v.lte(this.min))) return false;
    if (this.max && (this.includeMax ? v.gt(this.max) : v.gte(this.max))) return false;
    return true;
  }
}
