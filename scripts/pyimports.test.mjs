// The Python that decides which imports still need installing.
//
// The runner used to find imports with a regular expression over the source,
// against a hand-written list of twenty-two module names. Both halves were
// wrong. The list meant `import pygame` installed nothing and failed at the
// import — the complaint that started this — and a regex over source cannot
// tell an import from the word "import" inside a comment, a string or a
// docstring, all three of which models write constantly.
//
// It is Python's own parser now, run inside Pyodide, and the names it does not
// recognise are checked against `sys.stdlib_module_names` and
// `importlib.util.find_spec` rather than against anything written here. That
// removes the list, and it removes the guessing about what is standard library.
//
// What cannot be checked in Node is whether the snippet is *correct Python*, so
// this file extracts it from the source and runs it through a real interpreter.
// A syntax error or a wrong attribute name would otherwise only show up as a
// silent `catch` in the browser, where the fallback is "install nothing" — the
// exact behaviour being replaced.
//
// The same goes for the other Python the runner sends in: the transform that
// makes a desktop game loop survivable in a browser. That one rewrites the
// user's code before running it, so "it parses, and does the right thing" is
// not optional.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

// Line endings are normalised because this repository checks out with
// `core.autocrlf=true`, so a source file's newlines depend on whether git
// last touched it. A pattern anchored on \n would then pass or fail for a
// reason that has nothing to do with the code it is checking.
const source = fs.readFileSync(path.join(ROOT, 'src/artifacts.jsx'), 'utf8').replace(/\r\n/g, '\n');
const snippet = /export const FIND_MISSING_IMPORTS = `\n([\s\S]*?)`;/.exec(source);
check('the snippet can be found in the source', !!snippet);
if (!snippet) {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(1);
}

// `sys.stdlib_module_names` arrived in 3.10. Pyodide is well past that; a build
// machine might not be, and an old interpreter would fail this file for a
// reason that has nothing to do with the code.
const python = ['python', 'python3', 'py'].find((exe) => {
  try {
    const version = execFileSync(exe, ['-c', 'import sys; print(sys.version_info >= (3, 10))'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return version.trim() === 'True';
  } catch (err) {
    return false;
  }
});

if (!python) {
  console.log('SKIP  no Python 3.10+ on this machine; the snippet was not executed');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

// A name no interpreter has, so the result does not depend on what happens to
// be installed on the machine running the test.
const ABSENT = 'zzz_definitely_not_installed';

const CASES = [
  // what it must find
  [`import ${ABSENT}`, [ABSENT], 'a plain import'],
  [`from ${ABSENT} import thing`, [ABSENT], 'a from-import'],
  [`import ${ABSENT}.sub.module`, [ABSENT], 'only the top-level name of a dotted import'],
  [`if True:\n    import ${ABSENT}`, [ABSENT], 'an import inside a block'],
  [`def go():\n    import ${ABSENT}`, [ABSENT], 'an import inside a function'],
  [`import ${ABSENT}\nimport ${ABSENT}`, [ABSENT], 'the same import twice, once'],
  [`import ${ABSENT}_b\nimport ${ABSENT}_a`, [`${ABSENT}_a`, `${ABSENT}_b`], 'names in sorted order'],

  // what it must not find — every one of these fools a regex
  [`# import ${ABSENT}\nprint(1)`, [], 'nothing in a comment'],
  [`s = "import ${ABSENT}"`, [], 'nothing in a string'],
  [`"""\nimport ${ABSENT}\n"""\nprint(1)`, [], 'nothing in a docstring'],
  ['import os, sys, json, asyncio', [], 'nothing from the standard library'],
  ['from collections.abc import Mapping', [], 'nothing from a standard-library package'],
  ['from . import sibling', [], 'nothing for a relative import'],
  ['from .helpers import thing', [], 'nothing for a relative from-import'],

  // and a file it cannot parse is the run's problem, not this function's:
  // reporting a syntax error with its line number is what running it does.
  ['def f(:', [], 'nothing when the code does not parse'],
];

const program = `${snippet[1]}
import json, sys
cases = json.loads(sys.argv[1])
print(json.dumps([json.loads(_webui_missing(c) or '[]') for c in cases]))
`;

const file = path.join(os.tmpdir(), `webui-pyimports-${process.pid}.py`);
fs.writeFileSync(file, program);

let results;
try {
  const stdout = execFileSync(python, [file, JSON.stringify(CASES.map(c => c[0]))], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  results = JSON.parse(stdout);
  check('the snippet is valid Python and runs', true);
} catch (err) {
  check('the snippet is valid Python and runs', false,
    String(err.stderr || err.message).split('\n').slice(-4).join(' '));
  results = null;
} finally {
  try { fs.unlinkSync(file); } catch (err) { /* windows lock */ }
}

if (results) {
  CASES.forEach(([, want, name], i) => {
    const got = results[i];
    check(`it finds ${name}`, JSON.stringify(got) === JSON.stringify(want),
      `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
  });
}

/* ------------------------------------------------- the loop transform */

// A game loop written for a desktop never returns, and here the thread it
// never returns from is the one that draws the page. Refusing to run it is
// honest and useless — the code is fine, the environment is different — so the
// runner rewrites it instead: a pause and a stop-check on every pass.
//
// It rewrites the user's code, so "it parses, and does the right thing" is not
// optional, and neither is running it through a real parser before shipping it.
const transform = /export const ASYNCIFY_SOURCE = `\n([\s\S]*?)`;/.exec(source);
check('the transform can be found in the source', !!transform);

if (transform && python) {
  // The source is a JS template literal, so the escapes have already been
  // resolved once by the time Pyodide sees it. Doing the same here is what
  // makes this test check the Python that actually runs, rather than the
  // Python as it appears in the file — a distinction that was itself a bug:
  // `\n` inside the template became a real newline and broke the Python
  // string it was supposed to be part of.
  const asPythonSees = transform[1].replace(/\\n/g, '\\n').replace(/\\\\/g, '\\');

  const LOOP_CASES = [
    // The loop from every pygame tutorial, and the one that was freezing the
    // page: `running` is never set false in a browser, because the QUIT event
    // comes from closing a window and there is no window to close.
    ['running = True\nwhile running:\n    tick()\n', true, 'the tutorial game loop'],
    ['while True:\n    tick()\n', true, 'a bare forever loop'],
    ['while True:\n    while inner:\n        tick()\n', true, 'nested loops'],
    ['import asyncio\nwhile True:\n    await asyncio.sleep(0)\n', false, 'a loop that already awaits'],
    ['def go():\n    while True:\n        tick()\n', false, 'a loop inside a function'],
    ['for i in range(3):\n    print(i)\n', false, 'a for loop'],
    ['print(1)\n', false, 'code with no loop'],
    ['def f(:\n', false, 'code that does not parse'],
  ];

  const loopProgram = [
    asPythonSees,
    'import ast, json, sys',
    'out = []',
    'for src in json.loads(sys.argv[1]):',
    '    result = _webui_asyncify(src)',
    '    if result is None:',
    '        out.append({"changed": False})',
    '    else:',
    '        try:',
    '            ast.parse(result)',
    '            parses = True',
    '        except SyntaxError:',
    '            parses = False',
    '        out.append({',
    '            "changed": True, "parses": parses,',
    '            "yields": "await asyncio.sleep(0)" in result,',
    '            "checksStop": "_webui_should_stop()" in result,',
    '            "importsAsyncio": result.startswith("import asyncio"),',
    '        })',
    'print(json.dumps(out))',
  ].join('\n');

  const loopFile = path.join(os.tmpdir(), `webui-pyloop-${process.pid}.py`);
  fs.writeFileSync(loopFile, loopProgram);
  let loops = null;
  try {
    loops = JSON.parse(execFileSync(python, [loopFile, JSON.stringify(LOOP_CASES.map(c => c[0]))], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }));
    check('the transform is valid Python and runs', true);
  } catch (err) {
    check('the transform is valid Python and runs', false,
      String(err.stderr || err.message).split('\n').slice(-4).join(' '));
  } finally {
    try { fs.unlinkSync(loopFile); } catch (err) { /* windows lock */ }
  }

  if (loops) {
    LOOP_CASES.forEach(([, shouldChange, label], i) => {
      const got = loops[i];
      check(`${shouldChange ? 'it rewrites' : 'it leaves alone'} ${label}`,
        got.changed === shouldChange, JSON.stringify(got));
      if (!shouldChange || !got.changed) return;
      // Handing the runner code that does not parse would be worse than
      // refusing to run at all.
      check(`  and ${label} still parses`, got.parses === true);
      check(`  and ${label} yields to the browser`, got.yields === true);
      // Without the stop check an infinite loop is still infinite; it merely
      // stops freezing things, which is not the same as being stoppable.
      check(`  and ${label} can be stopped`, got.checksStop === true);
      check(`  and ${label} imports asyncio`, got.importsAsyncio === true);
    });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
