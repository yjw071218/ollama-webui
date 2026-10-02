/**
 * A mathematical expression, evaluated safely.
 *
 * ## Why not `new Function`
 *
 * Because the expression comes from a language model, and a model that has been
 * asked to plot something is one turn away from having been asked to plot
 * something by a person who pasted it from somewhere. `new Function('return ' +
 * text)` on that is arbitrary code in the reader's session, with their chats,
 * their account and their ComfyUI behind it. There is no amount of regex
 * filtering that makes that safe -- the filter is the thing that has to be
 * perfect, and it never is.
 *
 * So this parses. It knows numbers, a variable, the four operators, powers,
 * parentheses and a fixed list of functions, and there is nothing else for it
 * to do. An expression it cannot parse returns null and the block falls back to
 * being shown as the code it is.
 *
 * ## Shunting-yard, then evaluate
 *
 * Parsed once into reverse Polish and evaluated many times -- a curve is a few
 * hundred samples, and re-parsing per sample would be the slow part of drawing
 * one.
 *
 * Pure, and every part of it is checkable with numbers: precedence, the sign of
 * a unary minus, and what `-2^2` means are exactly the things that are wrong in
 * a hand-rolled evaluator and invisible until a graph looks odd.
 */

/* The functions an expression may call. Deliberately a list rather than a
   lookup into `Math`: `Math.random` would make a curve that changes every time
   it is drawn, and `Math.min`/`max` take a variable number of arguments, which
   the parser below does not. */
const FUNCTIONS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign,
};

const CONSTANTS = { pi: Math.PI, π: Math.PI, e: Math.E, tau: Math.PI * 2 };

/* The names that mean "the thing being varied".
 *
 * Anything of one or two letters is taken as the variable anyway; this list is
 * for the ones written out in full, because a model asked for a polar curve in
 * Korean writes `theta` about as often as it writes `θ`, and `4cos3theta` --
 * which is the exact string this was built for -- would otherwise be refused
 * for having a five-letter name in it. */
const VARIABLES = new Set(['theta', 'phi', 'rho', 'alpha', 'beta', 'time', 'angle']);

/* Precedence, and which way equal precedence groups.
 *
 * `^` is right-associative, so `2^3^2` is 2^(3^2) = 512 and not (2^3)^2 = 64 --
 * which is what every mathematician means by it and what a left-associative
 * implementation gets wrong silently. */
const OPERATORS = {
  '+': { prec: 1, right: false, apply: (a, b) => a + b },
  '-': { prec: 1, right: false, apply: (a, b) => a - b },
  '*': { prec: 2, right: false, apply: (a, b) => a * b },
  '/': { prec: 2, right: false, apply: (a, b) => a / b },
  '%': { prec: 2, right: false, apply: (a, b) => a % b },
  '^': { prec: 4, right: true, apply: (a, b) => a ** b },
};

const isDigit = (ch) => ch >= '0' && ch <= '9';
const isNameStart = (ch) => /[A-Za-zπθ_]/.test(ch);

/**
 * The expression as tokens.
 *
 * Implicit multiplication is put in here rather than left to the parser,
 * because it is a question about what was *written*: `4cos3t`, `2x`, `3(x+1)`
 * and `(x+1)(x-1)` all mean a multiplication that nobody typed, and a model
 * asked for "r = 4cos3θ" writes exactly that.
 */
export const tokenize = (source) => {
  const text = String(source || '').replace(/\s+/g, '');
  if (!text) return null;
  const out = [];
  let i = 0;

  /* Whether a `*` belongs before whatever comes next: true after a value --
     a number, a name, or a closing bracket -- and false after an operator or
     an opening one. */
  const afterValue = () => {
    const last = out[out.length - 1];
    return !!last && (last.type === 'num' || last.type === 'var' || last.type === 'const' || last.value === ')');
  };

  /* A function written without brackets takes everything juxtaposed to it.
   *
   * `4cos3θ` is the string a model writes for 4cos(3θ), and treating the
   * bracketless `cos` as applying only to the `3` gives 4·cos(3)·θ -- a
   * straight line where a three-petalled rose was asked for, and nothing on
   * screen to say which of the two it drew. So a bare function opens a bracket
   * that stays open across the implicit multiplications and closes at the first
   * operator anybody actually typed. */
  let implicit = 0;
  const closeImplicit = () => {
    while (implicit > 0) { out.push({ type: 'paren', value: ')' }); implicit -= 1; }
  };

  while (i < text.length) {
    const ch = text[i];

    if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1]))) {
      if (afterValue()) out.push({ type: 'op', value: '*' });
      let j = i;
      while (j < text.length && (isDigit(text[j]) || text[j] === '.')) j += 1;
      // An exponent, as `1e-3` is written. Only where a digit follows it.
      if ((text[j] === 'e' || text[j] === 'E')
        && (isDigit(text[j + 1]) || ((text[j + 1] === '-' || text[j + 1] === '+') && isDigit(text[j + 2])))) {
        j += 2;
        while (j < text.length && isDigit(text[j])) j += 1;
      }
      const value = Number(text.slice(i, j));
      if (!Number.isFinite(value)) return null;
      out.push({ type: 'num', value });
      i = j;
      continue;
    }

    if (isNameStart(ch)) {
      /* Letters first, then any digits that are part of the name -- `log2` is a
         function and `3` in `cos3θ` is not part of one. */
      let j = i;
      while (j < text.length && isNameStart(text[j])) j += 1;
      let end = j;
      while (end < text.length && isDigit(text[end])) end += 1;
      if (FUNCTIONS[text.slice(i, end).toLowerCase()]) j = end;

      let name = text.slice(i, j);
      let lower = name.toLowerCase();

      /* A run of letters that is not a name on its own is a name with another
         one stuck to it: `cosx`, `costheta`, `sinhx`. The longest function that
         starts it wins, so `sinh` is not read as `sin` with an `h` after it. */
      if (!FUNCTIONS[lower] && CONSTANTS[name] === undefined && CONSTANTS[lower] === undefined
        && name.length > 2 && !VARIABLES.has(lower)) {
        let cut = 0;
        for (let n = name.length - 1; n >= 2; n -= 1) {
          if (FUNCTIONS[lower.slice(0, n)]) { cut = n; break; }
        }
        if (!cut) return null;
        j = i + cut;
        name = text.slice(i, j);
        lower = name.toLowerCase();
      }
      if (afterValue()) out.push({ type: 'op', value: '*' });
      if (FUNCTIONS[lower]) {
        out.push({ type: 'fn', value: lower });
        if (text[j] !== '(') { out.push({ type: 'paren', value: '(' }); implicit += 1; }
      } else if (CONSTANTS[name] !== undefined) out.push({ type: 'const', value: CONSTANTS[name] });
      else if (CONSTANTS[lower] !== undefined) out.push({ type: 'const', value: CONSTANTS[lower] });
      // Anything else of one or two letters, or a name spelled out, is the
      // variable: x, t, θ, n, theta.
      else if (name.length <= 2 || VARIABLES.has(lower)) out.push({ type: 'var', value: lower });
      else return null;
      i = j;
      continue;
    }

    if (ch === '(' || ch === ')') {
      if (ch === ')') closeImplicit();
      if (ch === '(' && afterValue()) out.push({ type: 'op', value: '*' });
      out.push({ type: 'paren', value: ch });
      i += 1;
      continue;
    }

    if (ch === ',') { closeImplicit(); out.push({ type: 'paren', value: ',' }); i += 1; continue; }

    // `**` as a power, which is how it is written in code. Before the
    // single-character operators, or it reads as two multiplications.
    if (ch === '*' && text[i + 1] === '*') { closeImplicit(); out.push({ type: 'op', value: '^' }); i += 2; continue; }

    if (OPERATORS[ch]) { closeImplicit(); out.push({ type: 'op', value: ch }); i += 1; continue; }

    return null;
  }
  closeImplicit();
  return out;
};

/**
 * Tokens as reverse Polish, or null if they do not make an expression.
 *
 * A unary minus becomes its own operation rather than a subtraction from
 * nothing, and it binds tighter than `*` and looser than `^` -- so `-x^2` is
 * `-(x^2)` and `-2*3` is `(-2)*3`. That is the convention every calculator and
 * every mathematician uses, and getting it wrong turns a parabola upside down
 * without any other sign that something is amiss.
 */
export const toRpn = (tokens) => {
  if (!tokens || !tokens.length) return null;
  const out = [];
  const stack = [];

  const prevIsValue = (i) => {
    const p = tokens[i - 1];
    return !!p && (p.type === 'num' || p.type === 'var' || p.type === 'const' || p.value === ')');
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    if (token.type === 'num' || token.type === 'const' || token.type === 'var') { out.push(token); continue; }
    if (token.type === 'fn') { stack.push(token); continue; }

    if (token.type === 'op') {
      if ((token.value === '-' || token.value === '+') && !prevIsValue(i)) {
        // Unary. `+x` is x and needs no operation at all.
        if (token.value === '-') stack.push({ type: 'neg', prec: 3, right: true });
        continue;
      }
      const op = OPERATORS[token.value];
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.type === 'paren') break;
        const topPrec = top.type === 'fn' ? 5 : (top.type === 'neg' ? top.prec : OPERATORS[top.value].prec);
        if (topPrec > op.prec || (topPrec === op.prec && !op.right)) out.push(stack.pop());
        else break;
      }
      stack.push(token);
      continue;
    }

    if (token.value === '(') { stack.push(token); continue; }
    if (token.value === ',') {
      while (stack.length && stack[stack.length - 1].value !== '(') out.push(stack.pop());
      if (!stack.length) return null;
      continue;
    }
    if (token.value === ')') {
      while (stack.length && stack[stack.length - 1].value !== '(') out.push(stack.pop());
      if (!stack.length) return null;
      stack.pop();
      if (stack.length && stack[stack.length - 1].type === 'fn') out.push(stack.pop());
      continue;
    }
  }

  while (stack.length) {
    const top = stack.pop();
    if (top.type === 'paren') return null;   // an unclosed bracket
    out.push(top);
  }
  return out.length ? out : null;
};

/**
 * An expression, ready to be evaluated many times.
 *
 * `null` for anything that does not parse, which the caller treats as "this
 * block is not a chart" rather than as an error to report: a fenced block that
 * fails here is shown as the code it is, which is the most useful thing that
 * can be done with it.
 */
export const compile = (source) => {
  const rpn = toRpn(tokenize(source));
  if (!rpn) return null;

  /* Checked by running it: an expression whose stack does not balance is one
     that would return nonsense for every sample rather than fail.

     Several values rather than one, because `null` means two things here -- a
     malformed expression and a hole in the domain -- and probing `ln(x-1)` or
     `sqrt(x-2)` at a single x would refuse a perfectly good curve for being
     undefined at the one place it was asked about. */
  const lands = [1, 0.5, 2, -1, 3.7, 0.1].some((x) => {
    try { return evaluateRpn(rpn, x) !== null; } catch (e) { return false; }
  });
  if (!lands) return null;

  return (value) => {
    try { return evaluateRpn(rpn, value); } catch (e) { return null; }
  };
};

/** The stack machine. Null where the expression is not a number here. */
export const evaluateRpn = (rpn, variable) => {
  const stack = [];
  for (const token of rpn) {
    if (token.type === 'num' || token.type === 'const') { stack.push(token.value); continue; }
    if (token.type === 'var') { stack.push(variable); continue; }
    if (token.type === 'neg') {
      if (!stack.length) return null;
      stack.push(-stack.pop());
      continue;
    }
    if (token.type === 'fn') {
      if (!stack.length) return null;
      stack.push(FUNCTIONS[token.value](stack.pop()));
      continue;
    }
    if (token.type === 'op') {
      if (stack.length < 2) return null;
      const b = stack.pop();
      const a = stack.pop();
      stack.push(OPERATORS[token.value].apply(a, b));
      continue;
    }
    return null;
  }
  if (stack.length !== 1) return null;
  const result = stack[0];
  // A hole in the domain -- `sqrt(-1)`, `1/0`, `ln(0)` -- is a gap in the
  // curve, not a failure of the expression.
  return Number.isFinite(result) ? result : null;
};

/**
 * An equation as written, reduced to the side that is a function of something.
 *
 * Models write "r = 4cos3θ" and "y = x^2 - 3", because that is how the request
 * was phrased. Taking the right-hand side is what anybody means by plotting it.
 */
export const rightHandSide = (source) => {
  const text = String(source || '').trim();
  const at = text.indexOf('=');
  if (at < 0) return text;
  // Not `<=`, `>=` or `==`: those are not equations this can plot, and the
  // expression parser will refuse what is left anyway.
  if (/[<>=!]/.test(text[at - 1] || '') || text[at + 1] === '=') return text;
  return text.slice(at + 1).trim();
};

/** Whether the left of an equation names a polar radius: `r = …`. */
export const looksPolar = (source) => /^\s*r\s*=/i.test(String(source || ''));
