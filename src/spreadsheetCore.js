import { read, utils } from 'xlsx';

// Sparse sheets may claim a million rows while containing only a few cells.
// Walk actual cells, not the rectangular !ref range, and never silently truncate.
export const MAX_SPREADSHEET_CELLS = 200_000;
export const spreadsheetPages = (buffer) => {
  const workbook = read(buffer, { type: 'array', cellFormula: true, cellText: true, cellDates: false, bookVBA: false });
  if (!workbook.SheetNames?.length) throw new Error('No worksheets found in this spreadsheet.');
  const pages = [];
  let count = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows = new Map();
    for (const address of Object.keys(sheet || {})) {
      if (!/^[A-Z]+[1-9]\d*$/.test(address)) continue;
      const cell = sheet[address];
      if (!cell || (cell.v == null && !cell.f)) continue;
      if (++count > MAX_SPREADSHEET_CELLS) throw new Error('Spreadsheet exceeds 200,000 populated cells. Split it into smaller files.');
      const { r, c } = utils.decode_cell(address);
      const value = cell.v == null ? `=${cell.f} [no saved result]` : (cell.w ?? utils.format_cell(cell));
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push({ c, address, value });
    }
    const lines = [...rows.entries()].sort(([a], [b]) => a - b).map(([r, cells]) =>
      `${r + 1}\t${cells.sort((a, b) => a.c - b.c).map(cell => `${cell.address}=${JSON.stringify(String(cell.value))}`).join('\t')}`);
    // Repeat the sheet name in every page so retrieval keeps its provenance.
    for (let start = 0; start < lines.length; start += 200) {
      pages.push({ page: pages.length + 1, sheet: name,
        text: `Worksheet: ${JSON.stringify(name)}\nCell addresses and displayed values (formulas use saved results; not recalculated).\n${lines.slice(start, start + 200).join('\n')}` });
    }
  }
  return pages;
};
