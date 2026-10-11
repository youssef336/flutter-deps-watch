// GitHub access from the browser. Public repos need no token: two REST calls per
// scan (repo + tree) and every file through raw.githubusercontent.com, which is
// not rate-limited like the API. With a token (private repos, or to lift the
// 60 calls/hour limit) files go through the contents API instead.

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code; // not-found | rate-limit | unauthorized | network | bad-url
    this.status = status;
  }
}

/**
 * Accepts `owner/repo`, `https://github.com/owner/repo`, `…/tree/<ref>/<path>`,
 * `…/blob/<ref>/<path>/pubspec.yaml`, with or without `.git`.
 * @returns {{owner, repo, ref: string|null, path: string|null}}
 */
export function parseRepoInput(input) {
  const text = String(input || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (short) return { owner: short[1], repo: short[2], ref: null, path: null };
  const m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob)\/([^/]+)(?:\/(.+))?)?$/.exec(text);
  if (!m) throw new GitHubError('bad-url');
  let path = m[4] || null;
  if (path && /(^|\/)pubspec\.(yaml|lock)$/.test(path)) path = path.replace(/\/?pubspec\.(yaml|lock)$/, '') || null;
  return { owner: m[1], repo: m[2], ref: m[3] || null, path };
}

export class GitHub {
  constructor(token = '') {
    this.token = token.trim();
  }

  async api(path, accept = 'application/vnd.github+json') {
    const headers = { Accept: accept };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let res;
    try {
      res = await fetch(`${API}${path}`, { headers });
    } catch {
      throw new GitHubError('network');
    }
    if (res.status === 401) throw new GitHubError('unauthorized', 401);
    if (res.status === 403 || res.status === 429) {
      const left = res.headers.get('x-ratelimit-remaining');
      throw new GitHubError(left === '0' || res.status === 429 ? 'rate-limit' : 'unauthorized', res.status);
    }
    if (res.status === 404) throw new GitHubError('not-found', 404);
    if (!res.ok) throw new GitHubError('network', res.status);
    return accept.includes('raw') ? res.text() : res.json();
  }

  /** @returns {{defaultBranch, private, fullName, description, htmlUrl}} */
  async repo(owner, repo) {
    const r = await this.api(`/repos/${owner}/${repo}`);
    return {
      defaultBranch: r.default_branch,
      private: r.private,
      fullName: r.full_name,
      description: r.description || '',
      htmlUrl: r.html_url,
    };
  }

  /** Every blob path in the repo at `ref`, plus whether GitHub truncated the list. */
  async tree(owner, repo, ref) {
    const t = await this.api(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    return { paths: t.tree.filter((e) => e.type === 'blob').map((e) => e.path), truncated: !!t.truncated };
  }

  /** File text, or null when it does not exist. */
  async file(owner, repo, ref, path) {
    if (this.token) {
      try {
        return await this.api(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`,
          'application/vnd.github.raw');
      } catch (e) {
        if (e.code === 'not-found') return null;
        throw e;
      }
    }
    let res;
    try {
      res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref)}/${encodePath(path)}`);
    } catch {
      throw new GitHubError('network');
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError('network', res.status);
    return res.text();
  }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
