// A region edit redraws the region.
//
// Reported as: asking to change the outfit came back the same dress, and the
// progress card showed the reference picture the whole time instead of the
// picture being denoised. Hair colour worked. SAM3 had found the dress
// exactly; the model had asked for change 0.3 -- the tool described change in
// whole-picture terms ("0.5 keeps the clothing") -- and the chat let 0.3
// through. At 0.3 the sampler retouches what is there, so the result is the
// original, and so is every preview frame on the way to it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};

const app = read('src/App.jsx');
const expression = /change: \(region \|\| paint\)\s*\n\s*\? (.*)\n/.exec(app)?.[1];
check('region strength is available', !!expression);
if (expression) {
  const strength = new Function('asked', `return ${expression};`);
  check('gentle edits preserve a requested strength of 0.2', strength(0.2) === 0.2);
  check('an explicit full replacement is still allowed', strength(1) === 1);
  check('missing strength defaults to a moderate edit', strength(NaN) === 0.65);
}
check('and the whole-picture edit keeps its own range',
  /: \(Number\.isFinite\(asked\) \? Math\.min\(Math\.max\(asked, 0\.1\), 0\.9\) : 0\.65\),/.test(app));
check('the change reaches the server as the denoise', /\.\.\.\(referenceImage \? \{ referenceImage, denoise: edit\.change \} : \{\}\)/.test(app));

const T = await import(pathToFileURL(path.join(ROOT, 'src/tools.js')).href);
const change = T.TOOL_SCHEMAS.find(s => s.function.name === 'generate_image').function.parameters.properties.change.description;
check('the model is told the numbers are for the whole picture', /Without `region`, for the whole picture/.test(change));
check('identity-preserving edits and replacement use different strengths', /0.4–0.65/.test(change) && /0.85–1.0/.test(change));
check('the model is told lower values are honored', /Lower values are honored/.test(change));

/* Reported: after the fix above the dress changed, and a second teddy bear
   appeared in it. The prompt described the whole picture, bear included, and
   everything a prompt names is drawn inside the region -- where the bear she
   was already holding (outside it, kept) was not. */
const from = T.TOOL_SCHEMAS.find(s => s.function.name === 'generate_image').function.parameters.properties.from.description;
check('with a region, the prompt is the subject and that part only',
  /With `region` it describes the subject and what that part should now look like, and leaves out everything else/.test(from));
check('the tag protocol says the same', /except with \\`region\\`:\s*\n\s*then describe only the subject and what that part should become/.test(app));
check('the tag protocol honors low strengths', /Lower values are honored/.test(app));
check('painted edits default to a moderate strength', /with change 0\.65/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
