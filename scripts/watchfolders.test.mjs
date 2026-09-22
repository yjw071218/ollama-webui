// The plan: what a directory listing means for a library that already holds
// some of it. All pure, which is the reason it is a module rather than a loop
// inside a component -- every case below is one somebody's library depends on
// being got right, and none of them are reachable from a UI test.
//
// The walk itself is exercised against a real directory tree at the bottom.
import { rolldown } from 'rolldown';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '../node_modules/.watch-test-bundle.mjs');

const bundle = await rolldown({
  input: path.resolve(HERE, '../src/watchFolders.js'),
  platform: 'neutral',
});
await bundle.write({ file: OUT, format: 'esm' });
await bundle.close();

const { planSync, isEmptyPlan, parseFolders, serialiseFolders } =
  await import(pathToFileURL(OUT).href);
const { scanFolder, isIndexable } = await import('../server/folderWatch.js');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// ---------------------------------------------------------------- the plan
const FOLDER = 'D:/notes';
const watched = (p, size, mtime, id = p) => ({
  id, name: path.basename(p), source: { folder: FOLDER, path: p, size, mtime },
});

const docs = [
  watched('D:/notes/a.md', 100, 1000),
  watched('D:/notes/b.pdf', 200, 2000),
  // Added by hand in the panel. It has no source and is nobody's to delete.
  { id: 'manual', name: 'manual.pdf' },
  // From a different watched folder. Also not this scan's business.
  { id: 'other', name: 'c.md', source: { folder: 'D:/other', path: 'D:/other/c.md', size: 1, mtime: 1 } },
];

const unchanged = planSync(FOLDER, [
  { path: 'D:/notes/a.md', size: 100, mtime: 1000 },
  { path: 'D:/notes/b.pdf', size: 200, mtime: 2000 },
], docs);
check('a folder that has not changed is no work', isEmptyPlan(unchanged), JSON.stringify(unchanged));

const added = planSync(FOLDER, [
  { path: 'D:/notes/a.md', size: 100, mtime: 1000 },
  { path: 'D:/notes/b.pdf', size: 200, mtime: 2000 },
  { path: 'D:/notes/new.txt', size: 50, mtime: 3000 },
], docs);
check('a new file is added', added.add.length === 1 && added.add[0].path === 'D:/notes/new.txt');
check('and nothing else is touched', added.update.length === 0 && added.remove.length === 0);

// Size and time both, because each alone is wrong in a way that happens often.
const touched = planSync(FOLDER, [
  { path: 'D:/notes/a.md', size: 100, mtime: 9999 },
  { path: 'D:/notes/b.pdf', size: 200, mtime: 2000 },
], docs);
check('a file whose time moved is re-indexed', touched.update.length === 1);
check('and the update says which document it replaces', touched.update[0].replaces === 'D:/notes/a.md');

const resized = planSync(FOLDER, [
  { path: 'D:/notes/a.md', size: 101, mtime: 1000 },
  { path: 'D:/notes/b.pdf', size: 200, mtime: 2000 },
], docs);
check('an edit that kept the timestamp is caught by the size', resized.update.length === 1);

const deleted = planSync(FOLDER, [{ path: 'D:/notes/a.md', size: 100, mtime: 1000 }], docs);
check('a file that is gone is removed', deleted.remove.length === 1
  && deleted.remove[0].source.path === 'D:/notes/b.pdf', JSON.stringify(deleted.remove));

// The rule the whole thing hangs on.
check('a document added by hand is never removed',
  !deleted.remove.some(doc => doc.id === 'manual'));
check('and neither is one from another folder',
  !deleted.remove.some(doc => doc.id === 'other'));

const emptied = planSync(FOLDER, [], docs);
check('an empty folder removes its own documents and no others',
  emptied.remove.length === 2 && emptied.remove.every(doc => doc.source.folder === FOLDER));

// A rename is a delete and an add, and has to be: nothing in a directory
// listing says the two are the same file.
const renamed = planSync(FOLDER, [
  { path: 'D:/notes/a.md', size: 100, mtime: 1000 },
  { path: 'D:/notes/renamed.pdf', size: 200, mtime: 2000 },
], docs);
check('a rename is one add and one remove',
  renamed.add.length === 1 && renamed.remove.length === 1, JSON.stringify(renamed));

check('a library with nothing in it is all additions',
  planSync(FOLDER, [{ path: 'D:/notes/x.md', size: 1, mtime: 1 }], []).add.length === 1);
check('an empty scan of an empty library is no work',
  isEmptyPlan(planSync(FOLDER, [], [])));
check('a document with a source but no path is ignored rather than crashed on',
  isEmptyPlan(planSync(FOLDER, [], [{ id: 'x', source: { folder: FOLDER } }])));

// ------------------------------------------------------------- the setting
check('folders are one per line', parseFolders('D:/a\nD:/b').length === 2);
check('blank lines are dropped', parseFolders('D:/a\n\n  \nD:/b').length === 2);
check('surrounding space is trimmed', parseFolders('  D:/a  ')[0] === 'D:/a');
check('a folder listed twice is scanned once', parseFolders('D:/a\nD:/a').length === 1);
check('nothing is an empty list', parseFolders('').length === 0 && parseFolders(null).length === 0);
check('it round-trips', serialiseFolders(parseFolders('D:/a\nD:/b')) === 'D:/a\nD:/b');

// -------------------------------------------------------------- the walk
check('a document extension is indexable', isIndexable('report.pdf') && isIndexable('notes.MD'));
check('a binary one is not', !isIndexable('app.exe') && !isIndexable('photo.png'));
check('a file with no extension is not', !isIndexable('Makefile'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
fs.writeFileSync(path.join(root, 'a.md'), '# hello');
fs.writeFileSync(path.join(root, 'picture.png'), Buffer.alloc(10));
fs.writeFileSync(path.join(root, 'empty.txt'), '');
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'nested');
// The case that matters: a repository under a watched folder. node_modules
// alone is tens of thousands of files nobody wants to ask a question about.
fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
fs.mkdirSync(path.join(root, '.git'));
fs.writeFileSync(path.join(root, '.git', 'config.txt'), 'x');
fs.writeFileSync(path.join(root, '.hidden.md'), 'x');

const scan = scanFolder(root);
const names = scan.files.map(f => f.name).sort();

check('a document in the folder is found', names.includes('a.md'));
check('and one in a subfolder', names.includes('b.txt'));
check('a binary file is skipped', !names.includes('picture.png'));
check('an empty file is skipped', !names.includes('empty.txt'));
check('node_modules is not walked', !names.includes('index.js'), JSON.stringify(names));
check('nor is .git', !names.includes('config.txt'));
check('a hidden file is skipped', !names.includes('.hidden.md'));
check('every file carries what a later scan compares',
  scan.files.every(f => f.path && typeof f.size === 'number' && typeof f.mtime === 'number'));
// Windows and network shares report sub-millisecond drift for a file nothing
// touched, and re-embedding on that is minutes of GPU time for no change.
check('the modification time is whole seconds',
  scan.files.every(f => Number.isInteger(f.mtime)));
check('what was skipped is counted', scan.skipped >= 2, String(scan.skipped));

let missing = null;
try { scanFolder(path.join(root, 'nope')); } catch (e) { missing = e; }
check('a folder that is not there is a 404', missing?.statusCode === 404);

let notADir = null;
try { scanFolder(path.join(root, 'a.md')); } catch (e) { notADir = e; }
check('a file where a folder was expected says so', notADir?.statusCode === 400);

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
