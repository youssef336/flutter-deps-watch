// A tiny, safe markdown renderer for CHANGELOG slices. Input is untrusted:
// everything is escaped first and only http(s) links survive.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function inline(text) {
  const codes = [];
  let s = esc(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function markdown(src) {
  const out = [];
  let list = false;
  let fence = null;
  const closeList = () => {
    if (list) out.push('</ul>');
    list = false;
  };
  for (const raw of String(src || '').split('\n')) {
    if (fence !== null) {
      if (/^\s*```/.test(raw)) {
        out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
        fence = null;
      } else fence.push(raw);
      continue;
    }
    if (/^\s*```/.test(raw)) {
      closeList();
      fence = [];
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      closeList();
      const level = h[1].length <= 2 ? 4 : 5;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(raw);
    if (li) {
      if (!list) out.push('<ul>');
      list = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (!raw.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(raw)}</p>`);
  }
  if (fence !== null) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
  closeList();
  return out.join('');
}
