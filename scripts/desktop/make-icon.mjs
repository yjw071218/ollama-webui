#!/usr/bin/env node
/* Turns public/favicon.svg (the app's logo) into installer/app.ico.
   Needs @resvg/resvg-js, which the release workflow installs with --no-save:
     npm i --no-save @resvg/resvg-js && node scripts/desktop/make-icon.mjs
   The .ico holds PNG images, which Windows Vista and later read directly. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const root = new URL('../../', import.meta.url);
const svg = readFileSync(new URL('public/favicon.svg', root), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(size => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const entries = sizes.map((size, i) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  return e;
});
mkdirSync(new URL('installer/', root), { recursive: true });
writeFileSync(new URL('installer/app.ico', root), Buffer.concat([header, ...entries, ...pngs]));
console.log(`installer/app.ico: ${sizes.join(', ')} px`);
