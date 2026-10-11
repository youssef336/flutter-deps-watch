// Splits a CHANGELOG slice into what an upgrade brings: breaking / feature / fix / other.
//
// Changelogs follow no single format, so each item is judged by the strongest
// signal it carries, in this order:
//   1. an explicit breaking marker (`**BREAKING**`, `feat!:`, "Breaking change")
//   2. its own tag (`**FIX**(x):`, `feat:`, `Fixed:`, `[fix]`)
//   3. the section it sits under (`### Added`, `**Bugs**`, `### Breaking Changes`)
//   4. its leading verb (Fixes / Adds / Updates …)
//   5. tell-tale words (crash, bug, "now supports" …)
// Anything else is `other` (docs, dependency bumps, refactors). Pure — no I/O.

const VERSION_HEADING = /^#{1,4}\s*\[?v?(\d+\.\d+\.\d+[0-9A-Za-z.+\-]*)/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;

const SECTION_RULES = [
  ['breaking', /breaking|removed|removals|incompatib/i],
  ['fix', /fix|bug|security|patch/i],
  ['feature', /feature|added|new|enhancement|improve|perf/i],
  ['other', /change|chore|docs|documentation|dependenc|internal|refactor|misc|deprecat|upgrade|how to|maintenance|test|build|ci\b/i],
];

const TAGS = {
  fix: 'fix', fixed: 'fix', fixes: 'fix', bugfix: 'fix', bug: 'fix', bugs: 'fix', security: 'fix', hotfix: 'fix',
  feat: 'feature', feature: 'feature', features: 'feature', added: 'feature', add: 'feature', new: 'feature',
  perf: 'feature', enhancement: 'feature', improvement: 'feature', improved: 'feature',
  refactor: 'other', docs: 'other', doc: 'other', chore: 'other', test: 'other', tests: 'other', build: 'other',
  ci: 'other', style: 'other', changed: 'other', change: 'other', deps: 'other', revert: 'other',
  deprecated: 'other', removed: 'other',
};

// `**FIX**(scope):`, `fix(scope)!:`, `Fixed:`, `[fix]` at the start of an item. Only
// an explicit form counts as a tag — a bare "Fixes …" is a verb, judged after the section.
const TAG_PREFIX = /^(?:\*\*|__)?\[?([A-Za-z]+)\]?(?:\*\*|__)?(?:\([^)]*\))?(!)?\s*:?\s+/;
const isExplicit = (text, tag) => /^(\*\*|__|\[)/.test(text) || /[:(!]/.test(tag[0]);

// Uppercase BREAKING anywhere, "Breaking:" / "**Breaking**" / "_Breaking_" at the start,
// "breaking change(s)" anywhere, or a conventional-commit `!`. A lowercase "breaking"
// in prose ("…was breaking any class that…") is not a marker.
const BREAKING = /\bBREAKING\b|^(?:\*\*|_)?breaking(?:\*\*|_)?\s*[:\-]?\s|breaking changes?\b|^\w+(?:\([^)]*\))?!:/i;
const BREAKING_UPPER = /\bBREAKING\b/;

const VERB_FIX = /^(fix(es|ed|ing)?|resolve[sd]?|correct(s|ed)?|prevent(s|ed)?|patch(es|ed)?|repair(s|ed)?|workaround)\b/i;
const VERB_FEATURE = /^(add(s|ed)?|introduce[sd]?|new|implement(s|ed)?|allow(s|ed)?|expose[sd]?|enable[sd]?|provide[sd]?|export(s|ed)?|support(s|ed)?|now (supports?|allows?))\b/i;
const VERB_OTHER = /^(update[sd]?|bump(s|ed)?|require[sd]?|upgrade[sd]?|migrate[sd]?|refactor(s|ed)?|document(s|ed)?|docs?|clarif|remove[sd]?|switch(es|ed)?|replace[sd]?|move[sd]?|rename[sd]?|deprecate[sd]?|chore|internal|ci\b|test)/i;
const WORD_FIX = /\b(fix(es|ed)?|bug|crash(es|ed)?|regression|issue where|memory leak|race condition|exception when|no longer (crash|throw|fail))\b/i;
const WORD_FEATURE = /\b(add(s|ed)? support|new (api|method|option|parameter|property|widget|callback)|now supports?|added)\b/i;

const PLATFORMS = 'android|ios|macos|web|windows|linux|darwin|desktop|mobile';
// "[Android][iOS] fixed …" or "iOS: fix: …" — the platform stays in the text, the
// classification looks past it.
const PLATFORM_TAGS = new RegExp(
  `^(?:(?:\\s*\\[(?:${PLATFORMS}|all)(?:[ /,]+(?:${PLATFORMS}))*\\])+|\\s*(?:${PLATFORMS})\\s*:)\\s*`, 'i');
const COMMIT_LINKS = /\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)\.?/g; // melos "([36414d4c](…))"

/**
 * @param slice CHANGELOG text for the versions in (current, latest] (see changelogSlice).
 * @returns {{breaking: Item[], feature: Item[], fix: Item[], other: Item[]}} where
 *   Item = {version: string|null, text: string}
 */
export function parseNotes(slice) {
  const notes = { breaking: [], feature: [], fix: [], other: [] };
  const items = [];
  let version = null;
  let section = null;
  let current = null;
  let baseIndent = null;
  let group = '';
  let groupIndent = -1; // a bullet back at this indent (or less) closes the group

  const push = (text, kind = 'item') => {
    current = { version, section, text: text.trim(), kind };
    items.push(current);
  };

  for (const raw of String(slice || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    const vh = VERSION_HEADING.exec(trimmed);
    if (vh) {
      version = vh[1].replace(/[\]\s].*$/, '');
      // "## [3.0.0] [Breaking Changes]" carries its section in the heading.
      section = sectionOf(trimmed.slice(vh[0].length).replace(/[\[\]()\-–—]/g, ' ').trim());
      group = '';
      groupIndent = -1;
      current = null;
      baseIndent = null;
      continue;
    }
    if (!trimmed) {
      if (current?.kind === 'para') current = null;
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const bullet = BULLET.exec(line);
    const body = bullet ? bullet[2].trim() : trimmed;
    const label = heading?.[1] ?? labelOf(body);
    if (label != null) {
      // A heading, a bold line ("**Bugs**"), or a short "Something:" line opens a group;
      // a platform label ("Android:") prefixes its items instead of setting a section.
      const kind = sectionOf(label);
      if (kind) section = kind;
      group = PLATFORM_LABEL.test(label) ? `${label.replace(/[:*_\s]+$/g, '')}: ` : heading ? '' : group;
      groupIndent = bullet ? bullet[1].length : -1;
      current = null;
      baseIndent = null;
      continue;
    }
    if (bullet) {
      const indent = bullet[1].length;
      if (groupIndent >= 0 && indent <= groupIndent) {
        group = '';
        groupIndent = -1;
      }
      if (baseIndent == null || indent < baseIndent) baseIndent = indent;
      if (current?.fence) current.text += `\n${line.trim()}`;
      else if (indent >= baseIndent + 2 && current) current.text += `\n- ${body}`;
      else push(group + body);
      continue;
    }
    if (current && (/^\s/.test(line) || current.kind === 'para' || current.fence)) {
      // Wrapped prose joins with a space; a code block keeps its lines.
      const fenceEdge = trimmed.startsWith('```');
      current.text += current.fence || fenceEdge ? `\n${trimmed}` : ` ${trimmed}`;
      if (fenceEdge) current.fence = !current.fence;
      continue;
    }
    push(group + trimmed, 'para');
  }

  // Pre-release notes repeat what the release itself lists; keep them only
  // when the slice has no stable release at all.
  const stable = items.some((it) => it.version && !it.version.includes('-'));
  const seen = new Set();
  for (const it of items) {
    if (stable && it.version?.includes('-')) continue;
    const text = clean(it.text);
    if (!text || /^\*?none\.?\*?$/i.test(text) || seen.has(`${it.version}|${text}`)) continue;
    seen.add(`${it.version}|${text}`);
    notes[kindOf(it.text, it.section)].push({ version: it.version, text: display(text) });
  }
  return notes;
}

const PLATFORM_LABEL = /^(?:\*\*|_)?(android|ios|macos|web|windows|linux|darwin|desktop|mobile|dart|flutter)(?:\*\*|_)?\s*:?\s*$/i;

/** The label text when `text` is a group title ("**Bugs**", "**BREAKING CHANGES**:", "Android:"), else null. */
function labelOf(text) {
  const bold = /^(?:\*\*|__)([^*_]+?)(?:\*\*|__)\s*:?\s*$/.exec(text) || /^_([^_]+)_\s*:?\s*$/.exec(text);
  if (bold) return bold[1];
  const colon = /^([A-Za-z][\w /&.-]{1,30}):$/.exec(text);
  return colon ? colon[1] : null;
}

function sectionOf(title) {
  if (!title) return null;
  for (const [kind, re] of SECTION_RULES) if (re.test(title)) return kind;
  return null;
}

function kindOf(rawText, section) {
  const text = clean(rawText).replace(PLATFORM_TAGS, '');
  if (BREAKING_UPPER.test(text) || BREAKING.test(text.slice(0, 24)) || /breaking changes?\b/i.test(text)) return 'breaking';
  const tag = TAG_PREFIX.exec(text);
  if (tag?.[2]) return 'breaking';
  const tagged = tag && isExplicit(text, tag) && TAGS[tag[1].toLowerCase()];
  if (tagged) return tagged === 'other' && section === 'breaking' ? 'breaking' : tagged;
  if (section && section !== 'other') return section;
  if (VERB_FIX.test(text)) return 'fix';
  if (VERB_FEATURE.test(text)) return 'feature';
  if (VERB_OTHER.test(text) || section === 'other') return 'other';
  if (WORD_FIX.test(text)) return 'fix';
  if (WORD_FEATURE.test(text)) return 'feature';
  return 'other';
}

// melos commit links, and a leading PR/issue reference ("[#147](…): fix(ios): …").
const clean = (t) => t.replace(COMMIT_LINKS, '').replace(/^\[#?\d+\]\([^)]*\)\s*:?\s*/, '').trim();

/** Drops an explicit machine tag so the list reads as prose: "**FIX**(x): Apply …" → "Apply …". */
function display(text) {
  const platforms = (PLATFORM_TAGS.exec(text) || [''])[0];
  const body = text.slice(platforms.length);
  const tag = TAG_PREFIX.exec(body);
  if (!tag || !isExplicit(body, tag) || !TAGS[tag[1].toLowerCase()]) return text;
  const rest = body.slice(tag[0].length);
  return `${platforms}${rest.charAt(0).toUpperCase()}${rest.slice(1)}`.trim();
}

export const noteCounts = (n) => ({
  breaking: n?.breaking.length ?? 0, feature: n?.feature.length ?? 0, fix: n?.fix.length ?? 0, other: n?.other.length ?? 0,
});

const COMMON = new Set(['String', 'int', 'double', 'bool', 'num', 'List', 'Map', 'Set', 'Future', 'Stream', 'void',
  'dynamic', 'Object', 'null', 'true', 'false', 'const', 'final', 'var', 'late', 'required', 'Widget', 'BuildContext',
  'State', 'Flutter', 'Dart', 'README', 'CHANGELOG', 'pubspec', 'yaml', 'example', 'test', 'iOS', 'Android', 'macOS',
  'web', 'Windows', 'Linux', 'Kotlin', 'Swift', 'Gradle', 'AGP', 'SDK', 'API', 'the', 'and', 'for', 'with',
  'flutter', 'material', 'cupertino', 'dart', 'widgets', 'class', 'extends', 'implements', 'mixin', 'import',
  'export', 'return', 'this', 'super', 'new', 'async', 'await', 'static', 'get', 'set', 'override', 'Function']);

/** Identifiers an item names in `code` spans — what to look for in the project's code. */
export function identifiers(text, pkg) {
  const out = new Set();
  const spans = String(text).replace(/```[\s\S]*?(```|$)/g, ' ').matchAll(/`([^`]+)`/g);
  for (const m of spans) {
    // `package:flutter/material.dart`, `pubspec.yaml`, `lib/foo.dart` are paths, not APIs.
    if (/package:|\/|\.(dart|yaml|json|md|gradle|kts)\b/.test(m[1])) continue;
    for (const id of m[1].matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
      if (!COMMON.has(id[0]) && id[0] !== pkg && !/^package$/.test(id[0])) out.add(id[0]);
    }
  }
  return [...out];
}

/**
 * Marks items whose code-spanned identifiers occur in the project's files that
 * import the package. `words` = Set of identifiers found in those files.
 */
export function markHits(notes, pkg, words) {
  if (!notes || !words?.size) return;
  for (const kind of ['breaking', 'fix']) { // a new feature naming your API is no warning
    for (const it of notes[kind]) {
      const hits = identifiers(it.text, pkg).filter((id) => words.has(id));
      if (hits.length) it.hits = hits;
    }
  }
}
