// A character, designed rather than defaulted to.
//
// Two faults reported together, and they are the same fault: "여캐 그려줘" came
// back as `1girl, solo` with nothing about how she looks, and asking twice gave
// the identical character twice. A picture model told nothing draws its own
// default person, and a language model asked the same question twice answers it
// the same way -- neither is going to be argued out of that, so the variety is
// picked here and handed over.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const D = await import(pathToFileURL(path.join(ROOT, 'src/characterDesign.js')).href);
const B = await import(pathToFileURL(path.join(ROOT, 'server/booruTags.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ================================================================ the cue */

{
  const cue = D.designCue();
  check('a cue exposes every design axis', D.AXES.every(axis => cue.includes(`${axis}:`)), cue);
  check('  the candidate guide is stable', cue === D.designCue());
  check('  and it is a candidate guide, not a chosen character',
    cue.includes('hair:') && cue.includes('eyes:'));
  check('  hair colours include uncommon variants', D.DESIGN_AXES.hair.length >= 20);
  check('  hairstyles include uncommon variants', D.DESIGN_AXES.cut.length >= 60);
  check('  hair choices include multicolour designs',
    D.DESIGN_AXES.hair.some(value => /two-tone|multicolored|gradient|rainbow/.test(value)));
  check('  hairstyles include textured and braided designs',
    D.DESIGN_AXES.cut.some(value => /curly|spiked|braided|crown braid/.test(value)));

  const tags = new Set(B.loadTags(path.join(ROOT, 'assets', 'danbooru-tags.csv')).names);
  const missing = D.AXES.flatMap(axis => D.DESIGN_AXES[axis]
    .filter(value => !tags.has(value))
    .map(value => `${axis}: ${value}`));
  check('  every design cue is an actual CSV tag', missing.length === 0, missing.join(' | '));
}

/* The LLM can choose from a large combinatorial space rather than receiving a
   single application-selected character. */
{
  const total = D.AXES.reduce((n, axis) => n * D.DESIGN_AXES[axis].length, 1);
  check('there are many designs for the LLM to choose from', total > 1e12, `${total.toExponential(2)}`);
}

/* ============================================================== when it runs

   Every turn's system prompt sits in front of the whole conversation in the
   model's cache, so a line that changes every turn is not free. It goes on the
   turns that ask for a picture and nowhere else. */

check('a request for a picture gets a cue', D.asksForPicture('여캐 한 명 그려줘'));
check('  in English too', D.asksForPicture('draw me a character'));
check('  and for an illustration', D.asksForPicture('일러스트 하나 만들어줘'));
check('an ordinary question does not', !D.asksForPicture('오늘 서울 날씨 어때?'));
/* "그려줘" about an equation is a graph, drawn in the message itself -- a
   character design cue on that turn is noise. */
check('and neither does an equation', !D.asksForPicture('r = 4cos3theta를 그려줘'));
check('nor a graph', !D.asksForPicture('매출 그래프 그려줘'));

/* ================================================================ the wiring */

{
  const app = read('src/App.jsx');
  const tools = read('src/tools.js');

  check('the candidate guide is loaded per picture turn', /await fetchJson\('\/studio\/design-tags'/.test(app));
  check('  only when a picture was asked for', /asksForPicture\(thisTurn\[0\]\?\.content\)/.test(app));
  check('  and the request still wins over it',
    /user actually asked for overrides it/.test(app));
  check('  with the candidate list kept out of the answer', /Do not mention/.test(app));
  check('  and unusual hair is preserved', /preserve verbatim/.test(app));
  check('  Anima puts tags before natural-language sentences',
    /two parts: first a comma-separated list of/.test(app)
    && /exactly one or two complete, natural/.test(app));
  check('  other image models keep natural-language prompting',
    /Krea 2 and MiniMax keep their existing all-natural-language prompting rules/.test(app));
  check('  changing workflow refreshes the model-specific prompt rules',
    /if \(wantsSystem\)/.test(app)
    && /filter\(m => m\.role !== 'system'\)/.test(app));
  check('  the LLM chooses from the CSV-backed candidates',
    /full CSV-backed Danbooru candidate vocabulary below/.test(app)
    && /Choose suitable tags directly from this vocabulary/.test(app));

  check('the appearance rule is in the written guidance', /Always say what they look like/.test(app));
  check('  and in the tool schema for models that read those',
    /say how they look even if the request did not/.test(tools));
  check('  naming what "nothing" gets you', /1girl, solo" is not a description of anybody/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
