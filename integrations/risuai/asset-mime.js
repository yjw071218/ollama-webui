// Asset names may be hashes without extensions. Preserve binary signatures.
export function assetMime(input, name = '') {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const ascii = (at, count) => String.fromCharCode(...bytes.subarray(at, at + count));
  if (bytes[0] === 137 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216) return 'image/jpeg';
  if (ascii(0, 3) === 'GIF') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 4) === 'wOFF') return 'font/woff';
  if (ascii(0, 4) === 'wOF2') return 'font/woff2';
  if (ascii(0, 4) === 'OTTO') return 'font/otf';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (ascii(4, 4) === 'ftyp') return /avif|avis/.test(ascii(8, 16)) ? 'image/avif' : /M4A|M4B/.test(ascii(8, 4)) ? 'audio/mp4' : 'video/mp4';
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return 'video/webm';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)?<svg[\s>]/i.test(new TextDecoder().decode(bytes.subarray(0, 4096)))) return 'image/svg+xml';
  const ext = name.split('.').pop().toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm' })[ext] || 'application/octet-stream';
}
