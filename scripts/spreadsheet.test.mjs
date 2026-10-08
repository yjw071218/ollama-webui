import assert from 'node:assert/strict';
import { utils, write } from 'xlsx';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { spreadsheetPages } from '../src/spreadsheetCore.js';

const book = utils.book_new();
const sheet = utils.aoa_to_sheet([['상품', '금액', '비고'], ['사과', 1200, '줄1\n줄2'], ['배', 0, false]]);
sheet.D2 = { t: 'n', v: .25, z: '0%' };
sheet.E2 = { t: 'n', v: 2400, f: 'B2*2' };
sheet['!ref'] = 'A1:E3';
utils.book_append_sheet(book, sheet, '매출');
utils.book_append_sheet(book, utils.aoa_to_sheet([['별도 시트'], ['안녕하세요']]), '메모');
utils.book_append_sheet(book, utils.aoa_to_sheet([]), '빈 시트');
for (const bookType of ['xlsx', 'xls', 'xlsm', 'xlsb', 'ods']) {
  const buffer = write(book, { type: 'array', bookType });
  const pages = spreadsheetPages(buffer);
  assert.equal(pages.length, 2, bookType + ' skips empty sheets');
  assert.equal(pages[0].sheet, '매출');
  assert.match(pages[0].text, /사과/);
  assert.match(pages[0].text, /B2="1200"/);
  assert.match(pages[0].text, /B3="0"/);
  // SheetJS's ODS writer stores this cell as a raw fraction without a style.
  assert.match(pages[0].text, bookType === 'ods' ? /D2="0.25"/ : /D2="25%"/);
  assert.match(pages[0].text, /E2="2400"/);
  assert.match(pages[1].text, /안녕하세요/);
  console.log(`PASS ${bookType}: Korean, multiple sheets, zero, formatting, saved formulas`);
}
const sparse = utils.book_new();
utils.book_append_sheet(sparse, { A1048576: { t: 's', v: '마지막 행' }, '!ref': 'A1048576:A1048576' }, 'Sparse');
const zip = unzipSync(new Uint8Array(write(sparse, { type: 'array', bookType: 'xlsx' })));
zip['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(zip['xl/worksheets/sheet1.xml']).replace(/<dimension[^>]*\/>/, '<dimension ref="A1:XFD1048576"/>'));
const sparsePages = spreadsheetPages(zipSync(zip).buffer);
assert.match(sparsePages[0].text, /A1048576="마지막 행"/);
assert.ok(sparsePages[0].text.length < 300);
const long = utils.book_new();
utils.book_append_sheet(long, utils.aoa_to_sheet(Array.from({ length: 450 }, (_, i) => [i])), 'Long');
const longPages = spreadsheetPages(write(long, { type: 'array', bookType: 'xlsx' }));
assert.equal(longPages.length, 3);
assert.ok(longPages.every(p => p.text.includes('Worksheet: "Long"')));
assert.match(longPages[2].text, /A450="449"/);
assert.throws(() => spreadsheetPages(new Uint8Array([0x50, 0x4b, 3, 4]).buffer));
console.log('PASS sparse ranges, all rows retained, chunk provenance and corrupt file errors');
