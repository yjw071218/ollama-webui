// An equation, read.
//
// This is the file where a mistake is invisible: `-2^2` evaluated as 4 draws a
// parabola the right way up, `2^3^2` as 64 draws a curve that is simply wrong,
// and `4cos3θ` read as 4·cos(3)·θ draws a straight line where a three-petalled
// rose was asked for. None of those look like a bug on screen -- they look like
// a graph. So every one of them is a number here.
//
// And the other half: this evaluates text a language model wrote, so the list
// of things it can do has to be exactly the list of things it is meant to do.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const M = await import(pathToFileURL(path.join(ROOT, 'src/mathExpr.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* Every expression is checked by evaluating it, because that is the only form
   in which these mistakes are visible. */
const at = (source, x) => {
  const fn = M.compile(M.rightHandSide(source));
  return fn ? fn(x) : 'REFUSED';
};
const near = (name, source, x, want) => {
  const got = at(source, x);
  check(name, typeof got === 'number' && Math.abs(got - want) < 1e-9, `${source} at ${x} -> ${got}, want ${want}`);
};

/* ============================================================== arithmetic */

near('the operators do what they say', '1+2*3', 0, 7);
near('  brackets before them', '(1+2)*3', 0, 9);
near('  and division binds as tightly as multiplication', '8/2*2', 0, 8);

/* `-2^2` is -4. A unary minus that binds tighter than the power turns every
   parabola in the app upside down, and nothing on screen says so. */
near('a minus sign is not part of the power', '-2^2', 0, -4);
near('  but it is tighter than a multiplication', '-2*3', 0, -6);
near('  and it applies to a bracket', '-(3-5)', 0, 2);
near('a plus sign in front of a value is nothing at all', '+x', 3, 3);

// Right-associative, as everybody writes it: 2^(3^2), not (2^3)^2.
near('a tower of powers is read from the top', '2^3^2', 0, 512);
near('  and `**` means the same thing', '2**3', 0, 8);

/* ================================================== what the model writes */

near('a number in front of a name multiplies', '2x', 4, 8);
near('a bracket after a value does too', '2(x+1)', 3, 8);
near('and two brackets side by side', '(x+1)(x-1)', 3, 8);

/* The exact string this was built for. `4cos3θ` is 4cos(3θ): a bare function
   takes the whole juxtaposed product after it, not just the first number. Read
   the other way it is 4·cos(3)·θ -- a straight line, drawn without complaint. */
near('a bare function takes what is juxtaposed to it', '4cos3θ', 0, 4);
near('  so it is a rose and not a line', '4cos3θ', Math.PI / 6, 0);
near('  written as theta as well', 'r = 4cos3theta', Math.PI / 3, -4);
near('  and with no number in front', 'cos3t', 0, 1);
near('  or no brackets at all', 'costheta', 0, 1);
// The longest function wins, or `sinh` is `sin` with an `h` stuck to it.
near('a function whose name contains another', 'sinhx', 0, 0);
near('  and one whose name contains a digit', 'log2(8)', 0, 3);
near('an explicit bracket still ends it', 'cos(3t)+1', 0, 2);
near('and an operator closes it', 'cos3t+1', 0, 2);

near('pi is known', '2pi', 0, Math.PI * 2);
near('and so is e', 'ln(e)', 0, 1);

/* ==================================================== holes in the domain */

check('a value the curve does not have is a gap', at('sqrt(x)', -1) === null);
check('  and so is a division by zero', at('1/x', 0) === null);
check('  and a logarithm of zero', at('ln(x)', 0) === null);
/* Null for a hole, not null for the whole expression: probing at one value
   would refuse `sqrt(x-2)`, which is undefined at every x the probe uses and
   perfectly drawable past 2. */
check('an expression undefined near the origin still compiles',
  typeof at('sqrt(x-2)', 6) === 'number');
check('  and is a gap below it', at('sqrt(x-2)', 1) === null);

/* ========================================================== what it refuses

   The reason this file exists rather than `new Function`: an expression comes
   from a model, which got it from a person, who got it from somewhere. Every
   one of these is text that parses as JavaScript and does something. */

for (const hostile of [
  'process.exit(1)',
  'fetch("http://x")',
  'globalThis.x=1',
  'x;alert(1)',
  'this.constructor',
  '(()=>1)()',
  'x`y`',
  'localStorage.clear()',
]) check(`refused: ${hostile}`, M.compile(hostile) === null);

check('and prose is refused', M.compile('draw me a rose') === null);
check('as is an empty expression', M.compile('') === null);
check('and an unclosed bracket', M.compile('2*(x+1') === null);

/* Belt and braces: the evaluator must have no way to reach the host at all,
   whatever the parser lets through. */
{
  /* The comments in that file discuss both `new Function` and `Math.random` at
     length -- that is the whole argument for its existence -- so they are taken
     out before looking for either. */
  const source = read('src/mathExpr.js')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  check('nothing is compiled from text',
    !/new Function|\beval\(/.test(source));
  check('  and the function list is a list, not a reach into Math',
    !/Math\[/.test(source));
  /* `Math.random` would make a curve that is different every time the message
     is re-rendered, which is not a plot of anything. */
  check('  with nothing random in it', !/Math\.random/.test(source));
}

/* ============================================================ the equation */

check('an equation is reduced to its right-hand side', M.rightHandSide('y = x^2 - 3') === 'x^2 - 3');
check('  including a polar one', M.rightHandSide('r = 4cos3θ') === '4cos3θ');
check('  and an expression with no equals sign is left alone', M.rightHandSide('x^2') === 'x^2');
check('a comparison is not an equation to plot', M.rightHandSide('x >= 2') === 'x >= 2');

check('`r =` means polar', M.looksPolar('r = 4cos3θ'));
check('  and `y =` does not', !M.looksPolar('y = sin(x)'));
check('  nor does a bare expression', !M.looksPolar('4cos3θ'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
