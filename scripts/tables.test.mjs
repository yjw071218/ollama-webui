// Wide tables in an answer.
//
// There were no rules for these at all, which means the browser's defaults: no
// borders, no padding, and — the one that matters — nowhere to scroll. A model
// asked to compare things produces eight columns, and eight columns of real
// text is wider than the conversation column on a desktop and far wider than a
// phone.
//
// Measured before the fix, on a 390px phone: the table's content is 600px and
// there was nothing to keep it inside the 366px column, so it pushed the row,
// the column and the page sideways — the same failure the composer footer had.
//
// The subtle half is that `.message-row` is `display: flex`, so `.markdown-body`
// is a flex item, and a flex item's automatic minimum size is its *content*.
// `max-width: 100%` on the table cannot save it, because 100% of a
// content-sized parent is the content. `min-width: 0` on the item is the rule
// that actually does the work, and it is the same one that once broke the
// settings tab strip.
//
// Measured after, on the same phone: table box 366 inside a 366 column,
// content 600, scrolling inside itself, page not moving. At every stage of the
// table arriving — header alone, header plus separator, one row, a half-written
// row, complete.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const css = ['../src/index.css', '../src/extras.css']
  .map(f => fs.readFileSync(path.resolve(HERE, f), 'utf8'))
  .join('\n')
  .replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

/** The body of a rule, or '' if there is no such rule. */
const ruleFor = (selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(^|[,}\\s])${escaped}\\s*(,[^{]*)?\\{([^}]*)\\}`, 'm'));
  return match ? match[3] : '';
};

/* ------------------------------------------------- the flex item can shrink */

// This is the load-bearing one. Without it nothing else matters, because the
// table's container will simply grow to fit it.
check('the message body may shrink below its content',
  /\.message-row > \.markdown-body[\s\S]{0,140}?min-width:\s*0/.test(css));
check('and so may the other message wrappers',
  /\.message-content[\s\S]{0,80}?min-width:\s*0/.test(css));

/* --------------------------------------------------- the table has a scroller */

const table = ruleFor('.markdown-body table');
check('there is a rule for tables at all', table.length > 0);
// A table is not a block box by default, and `overflow` does not apply to
// `display: table`.
check('it is a block box, so overflow applies', /display:\s*block/.test(table), table.slice(0, 120));
check('it scrolls sideways rather than pushing the page', /overflow-x:\s*auto/.test(table), table.slice(0, 160));
check('and it is capped at the column width', /max-width:\s*100%/.test(table));
// Reaching the end of a table on a phone should not fling the conversation
// sideways behind it.
check('and it does not chain its scroll to the page', /overscroll-behavior-x:\s*contain/.test(table));

/* ---------------------------------------------------------- and is legible */

// `ruleFor` returns the first rule whose selector list mentions this one, and
// `th` appears first in the shared `th, td` rule — so the header's own rule is
// found by name here rather than through that helper.
const cells = css.match(/\.markdown-body th,\s*\n\.markdown-body td\s*\{([^}]*)\}/)?.[1] || '';
const header = css.match(/\n\.markdown-body th\s*\{([^}]*)\}/)?.[1] || '';
check('cells have borders', /border:/.test(cells), cells.slice(0, 80));
check('and padding', /padding:/.test(cells), cells.slice(0, 80));
check('the header stands out', /background:/.test(header), header.slice(0, 100));
check('and rows are banded, so the eye can follow one across eight columns',
  /\.markdown-body tbody tr:nth-child\(even\)/.test(css));

/* ------------------------------------------------------------ on a phone */

check('a phone gets smaller cells rather than a smaller table',
  /@media \(max-width: 860px\)[\s\S]{0,400}?\.markdown-body th,[\s\S]{0,80}?padding:/.test(css));

/* ------------------------------------------ the reasoning panel too */

// The same markdown renders inside the collapsed thought process, where a
// table that pushes sideways is just as unwelcome.
check('the thinking panel scrolls its tables too',
  /\.think-body table[\s\S]{0,200}?overflow-x:\s*auto/.test(css)
  || /\.markdown-body table,\s*\n\.think-body table/.test(css));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
