// Deterministic rendering of the existing sidebar mark, not generated artwork.
import { Resvg } from '@resvg/resvg-js';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const svg = readFileSync(new URL('../../public/favicon.svg', import.meta.url), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
const header = Buffer.alloc(6); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + sizes.length * 16;
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16); e[0] = e[1] = size === 256 ? 0 : size;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length; return e;
});
mkdirSync(new URL('icons/', import.meta.url), {recursive:true});
writeFileSync(new URL('icons/app.ico', import.meta.url), Buffer.concat([header, ...entries, ...pngs]));
writeFileSync(new URL('icons/app.png', import.meta.url), pngs.at(-1));
