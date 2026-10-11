// Reads one file out of a pub.dev package archive (.tar.gz) in the browser.

/** Gunzips `bytes` and returns the text of the first root entry whose name matches `wanted`. */
export async function readFromTarGz(bytes, wanted = /^(\.\/)?CHANGELOG\.md$/i) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const tar = new Uint8Array(await new Response(stream).arrayBuffer());
  return readFromTar(tar, wanted);
}

export function readFromTar(tar, wanted) {
  const decoder = new TextDecoder();
  const field = (off, len) => decoder.decode(tar.subarray(off, off + len)).replace(/\0.*$/s, '').trim();
  let longName = null;
  for (let off = 0; off + 512 <= tar.length;) {
    const name = longName ?? field(off, 100);
    longName = null;
    if (!name) break;
    const size = parseInt(field(off + 124, 12) || '0', 8);
    const type = String.fromCharCode(tar[off + 156]);
    const body = off + 512;
    const prefix = field(off + 345, 155);
    const full = prefix && tar[off + 257] === 0x75 /* ustar */ ? `${prefix}/${name}` : name;
    if (type === 'L') {
      longName = field(body, size);
    } else if ((type === '0' || type === '\0') && wanted.test(full)) {
      return decoder.decode(tar.subarray(body, body + size));
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return null;
}
