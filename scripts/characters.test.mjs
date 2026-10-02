// Teaching this install a character, or a style.
//
// Almost everything here is checked because it cannot be checked by running
// it. A training run is tens of minutes of one graphics card, and a bad
// caption scheme does not fail -- it succeeds at learning the wrong thing, and
// the only symptom is that the result is disappointing an hour later. So the
// captions, the trigger, the graph and the folder names are pinned one by one.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// characters.js stamps its list into storage when it saves one.
const store = new Map();
globalThis.localStorage = {
  get length() { return store.size; },
  key: (i) => [...store.keys()][i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const C = await import(pathToFileURL(path.join(ROOT, 'src/characters.js')).href);
const T = await import(pathToFileURL(path.join(ROOT, 'server/training.js')).href);

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
};
const eq = (name, got, want) => check(name, JSON.stringify(got) === JSON.stringify(want),
  `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

/* ================================================================ captions

   The one decision in this feature that a test can catch and a person cannot.

   A LoRA learns whatever the captions leave unexplained. So for a character
   the captions must NOT name the character -- what recurs in every picture is
   the likeness, and writing it down is how it ends up attached to "white hair"
   instead of to the trigger. For a style it is the exact opposite: every
   subject is described in full, so the only thing left unaccounted for is how
   they are drawn. Getting these two the wrong way round produces a file that
   loads, runs, and does nothing anybody asked for. */

const SET = [
  ['1girl', 'solo', 'wolf girl', 'white hair', 'red eyes', 'school uniform', 'standing', 'outdoors', 'highres'],
  ['1girl', 'solo', 'wolf girl', 'white hair', 'red eyes', 'dress', 'sitting', 'indoors', 'signature'],
  ['1girl', 'solo', 'wolf girl', 'white hair', 'red eyes', 'swimsuit', 'lying', 'beach'],
];

eq('what every picture shares is the likeness',
  C.sharedTags(SET), ['1girl', 'solo', 'wolf girl', 'white hair', 'red eyes']);

{
  const caps = C.captionsFor({ kind: 'character', trigger: 'lunachr', tags: SET });
  check('a character\'s captions do not describe the character',
    caps.every(cap => !cap.includes('wolf girl') && !cap.includes('white hair') && !cap.includes('red eyes')),
    caps.join(' | '));
  check('  they describe everything else', caps[0].includes('school uniform') && caps[2].includes('beach'));
  check('  and every one of them says the trigger', caps.every(cap => cap.startsWith('lunachr, ')));
  /* "1girl" and "solo" are shared too, and are kept anyway: they are the frame
     a likeness sits in, not part of it. Dropped, the trigger comes to mean
     "one girl, alone" as well, and asking for two of her produces one. */
  check('  the tags that are the frame rather than the face are kept',
    caps.every(cap => cap.includes('1girl') && cap.includes('solo')));
}

{
  const caps = C.captionsFor({ kind: 'style', trigger: 'nytechr', tags: SET });
  check('a style\'s captions describe everything, so only the drawing is left unsaid',
    caps.every(cap => cap.includes('wolf girl') && cap.includes('white hair')));
  check('  and they still say the trigger', caps.every(cap => cap.startsWith('nytechr, ')));
}

check('tags about the file rather than the picture never reach a caption',
  C.captionsFor({ kind: 'style', trigger: 'x', tags: SET })
    .every(cap => !cap.includes('highres') && !cap.includes('signature')));

// One picture has nothing to share with, so nothing is held back -- otherwise
// a set of one would train on a caption of just the trigger.
eq('a set of one keeps its whole caption',
  C.captionsFor({ kind: 'character', trigger: 'x', tags: [['1girl', 'red eyes', 'standing']] }),
  ['x, 1girl, red eyes, standing']);

eq('there is one caption per picture, in order',
  C.captionsFor({ kind: 'character', trigger: 'x', tags: SET }).length, 3);

/* ================================================================= triggers

   A word the base model has no opinion about. "luna" is a word it has seen a
   great deal of, and training then fights that instead of filling an empty
   slot. */

check('a trigger is not the name', C.triggerFor('Luna') !== 'luna');
eq('it is stable for the same name', C.triggerFor('Luna'), C.triggerFor('Luna'));
check('accents do not survive into it', /^[a-z0-9]+$/.test(C.triggerFor('Ångström')));

/* A name with no Latin letters is the normal case here, and used to produce
   the same trigger every time -- so two characters shared one word and the
   second one trained over the first's meaning. */
check('a name with no Latin letters still gets a trigger of its own',
  C.triggerFor('루나') !== C.triggerFor('아리스'), `${C.triggerFor('루나')} / ${C.triggerFor('아리스')}`);
eq('and the same one every time', C.triggerFor('루나'), C.triggerFor('루나'));
check('  which is still a plain word', /^[a-z0-9]+$/.test(C.triggerFor('루나')));

/* ================================================================== using it */

eq('the trigger goes to the front of the prompt, where the weight is',
  C.promptWith({ trigger: 'lunachr' }, '1girl, smiling'), 'lunachr, 1girl, smiling');
eq('a prompt that already says it is left alone',
  C.promptWith({ trigger: 'lunachr' }, 'lunachr, smiling'), 'lunachr, smiling');
eq('and one with no character at all is untouched',
  C.promptWith(null, '1girl, smiling'), '1girl, smiling');

{
  const luna = { lora: 'a.safetensors', strength: 0.8, trigger: 'lunachr' };
  eq('applying a character adds its LoRA',
    C.stackWith([{ name: 'b', weight: 1 }], luna),
    [{ name: 'b', weight: 1 }, { name: 'a.safetensors', weight: 0.8 }]);
  // Switched off and on again, which is a thing anybody does while comparing.
  eq('applying it twice does not fill the slots with copies of it',
    C.stackWith(C.stackWith([], luna), luna), [{ name: 'a.safetensors', weight: 0.8 }]);
  eq('and it can be taken back out', C.stackWithout(C.stackWith([], luna), luna), []);
  check('a strength that is not a number falls back rather than loading at zero',
    C.stackWith([], { lora: 'a', strength: null })[0].weight === C.STRENGTH.default);
}

/* ================================================================ the swap

   Redrawing whoever is in a picture as somebody else. What makes it a swap and
   not a redraw is that the old character's word comes out as the new one goes
   in -- a prompt naming both is a prompt asking for a blend of them. */

const LIB = [{ id: 'a', name: 'Luna', trigger: 'lunachr', lora: 'new.safetensors', strength: 0.85 }];
const PIC = { prompt: 'oldchr, 1girl, school uniform, outdoors' };

{
  const from = { trigger: 'oldchr', character: { lora: 'old.safetensors', trigger: 'oldchr' } };
  const plan = C.swapRequest({ picture: PIC, into: C.swapTarget(LIB, 'Luna'), from });
  eq('the old character is out of the prompt and the new one is in',
    plan.prompt, 'lunachr, 1girl, school uniform, outdoors');
  eq('only the new character\'s LoRA is loaded', plan.loras, [{ name: 'new.safetensors', weight: 0.85 }]);
  check('everything that is not the person is kept',
    plan.prompt.includes('school uniform') && plan.prompt.includes('outdoors'));
  check('the region is the person and not the picture', /girl|person/.test(plan.region));
  /* Below about 0.8 the old likeness bleeds through and the result is neither
     character, which is the failure this number exists to avoid. */
  check('and it redraws the region outright rather than retouching it', plan.denoise >= 0.85);
  check('a swap with nobody to swap to is not a request',
    C.swapRequest({ picture: {}, into: null }) === null);
}

/* ------------------------------------------- and anyone danbooru already knows

   A trained LoRA is how you get a likeness the base model has never seen. It is
   not how you get Hoshino: these models were trained on danbooru, where
   `hoshino (blue archive)` is a tag they already draw. Requiring a LoRA for
   those meant forty minutes of training to reproduce something already there. */

{
  const target = C.swapTarget(LIB, 'hoshino (blue archive)');
  eq('a name nobody trained is taken as tags, not refused', target.kind, 'tags');
  eq('  and a name that was trained is taken as the character',
    C.swapTarget(LIB, 'Luna').kind, 'trained');
  eq('  matched loosely, as the model will have written it',
    C.swapTarget(LIB, '"luna"').kind, 'trained');
  check('  while nothing at all is nobody', C.swapTarget(LIB, '   ') === null);

  const plan = C.swapRequest({ picture: PIC, into: target, from: { trigger: 'oldchr' } });
  eq('the tags go to the front, where a booru prompt carries its subject',
    plan.prompt, 'hoshino (blue archive), 1girl, school uniform, outdoors');
  /* The LoRA that drew the character being replaced must not stay loaded: it
     is a trained likeness of somebody who is no longer in the picture. */
  eq('and no LoRA is loaded for a character made of tags', plan.loras, []);
}

{
  /* "루나로 바꾸되 수채화풍으로" is one request. A style rides along with either
     kind of target, and goes last -- where a modifier belongs. */
  const plan = C.swapRequest({
    picture: PIC,
    into: C.swapTarget(LIB, 'hoshino (blue archive)'),
    from: { trigger: 'oldchr' },
    style: 'watercolor, soft lighting',
  });
  eq('a style asked for alongside goes on the end',
    plan.prompt, 'hoshino (blue archive), 1girl, school uniform, outdoors, watercolor, soft lighting');
}

{
  /* A tag-only swap leaves no LoRA in the settings, so the next swap cannot
     tell from the picture who is in it. What went in is remembered instead --
     without that, the old character's tags stay and the redraw is a blend. */
  const plan = C.swapRequest({
    picture: { prompt: 'hoshino (blue archive), 1girl, outdoors' },
    into: C.swapTarget(LIB, 'ganyu (genshin impact)'),
    from: { tags: 'hoshino (blue archive)' },
  });
  eq('swapping away from a tagged character takes those tags back out',
    plan.prompt, 'ganyu (genshin impact), 1girl, outdoors');
  const app2 = read('src/App.jsx');
  check('  and the app remembers them on the picture it made',
    /swapTags: into\.tags/.test(app2) && /picture\.swapTags \|\| ''/.test(app2));
}

/* ================================================================= the shelf */

{
  const one = C.characterRecord({ id: 'a', name: 'Luna', lora: 'x.safetensors', trigger: 'lunachr' });
  store.clear();
  C.saveCharacters('me', [one]);
  eq('a character survives being stored', C.loadCharacters('me').length, 1);
  check('and the list is stamped, or it uploads as older than the account',
    [...store.keys()].some(key => key.startsWith('settingStamps')));
  eq('a repeat of the same one replaces it rather than doubling it',
    C.withCharacter([one], { ...one, name: 'Luna 2' }).length, 1);
  eq('and it can be forgotten', C.withoutCharacter([one], 'a'), []);

  /* Which character a finished picture was drawn with, read off the LoRA it
     recorded -- `anima\x` and `anima/x` are the same file spelt two ways. */
  check('a picture says who is in it',
    C.characterOf([{ ...one, lora: 'anima/x.safetensors' }],
      { loras: [{ name: 'anima\\x.safetensors' }] })?.id === 'a');
  check('and a picture drawn with nobody says so',
    C.characterOf([one], { loras: [] }) === null);
}

/* ============================================================== the dataset

   The browser uploads into a folder and the server names that folder in the
   graph. They have to be the same folder, which is why only the server names
   it -- `/studio/train/prepare`. */

eq('a name becomes a folder', T.datasetFolder('Luna'), 'webui-lora-luna');
eq('slugging is idempotent, so the id can be sent back and re-slugged',
  T.slugify(T.slugify('Luna v2!!')), T.slugify('Luna v2!!'));
eq('a name with nothing usable in it slugs to nothing, and the caller supplies one',
  T.slugify('루나'), '');

{
  const files = T.datasetFiles([{ image: 'a', caption: 'x' }, { image: 'b', caption: 'y' }]);
  eq('every picture gets a caption beside it', files.length, 4);
  check('paired by stem, which is what the trainer matches on',
    files[0].name === 'img_0001.png' && files[1].name === 'img_0001.txt'
    && files[2].name === 'img_0002.png' && files[3].name === 'img_0002.txt');
  check('and the captions end in a newline, as a text file does',
    files[1].text.endsWith('\n'));
}

/* ================================================================ the graph */

const OBJECT_INFO = {
  PreviewAny: { input: { required: { source: ['*', {}] } } },
  AnimaLoRATrainerFolder: {
    input: {
      required: {
        anima_model: [['anima_aestheticV11.safetensors', 'other.safetensors'], {}],
        dataset_dir: [['webui-lora-luna', 'pony'], {}],
        save_as: ['STRING', {}],
        rank: ['INT', {}],
        epochs: ['INT', {}],
        lr: ['FLOAT', {}],
        gpu: [['8GB', '16GB', 'high'], {}],
      },
      optional: { mask_dir: [['(none)', 'pony'], {}] },
    },
  },
};

{
  const built = T.trainGraph({ dataset: 'webui-lora-luna', saveAs: 'webui-luna', objectInfo: OBJECT_INFO });
  const trainer = built.prompt['1'];
  eq('the run is the trainer and an output', Object.keys(built.prompt).length, 2);
  eq('it reads the folder the pictures went into', trainer.inputs.dataset_dir, 'webui-lora-luna');
  eq('and saves under the name the server chose', trainer.inputs.save_as, 'webui-luna');
  /* The trainer returns a MODEL and writes its file itself. ComfyUI runs only
     what an output node depends on, so a graph of just the trainer is accepted
     and then executes nothing at all -- which looks exactly like a run that
     finished instantly. */
  eq('the MODEL goes somewhere, or nothing in the graph runs',
    built.prompt['2'].inputs.source, ['1', 0]);
  eq('  and that somewhere is an output node', built.prompt['2'].class_type, 'PreviewAny');
  /* A LoRA belongs to the base it was trained against. Defaulting to whatever
     is first in the list is a slow way to make every later picture worse. */
  eq('it trains against the base the Anima workflow actually draws with',
    trainer.inputs.anima_model, 'anima_aestheticV11.safetensors');
  eq('masked loss is off, because nothing here paints a mask',
    trainer.inputs.mask_dir, '(none)');
}

eq('a base this ComfyUI has not got falls back to one it has',
  T.trainGraph({ dataset: 'webui-lora-luna', saveAs: 'x', base: 'gone.safetensors', objectInfo: OBJECT_INFO })
    .prompt['1'].inputs.anima_model,
  'anima_aestheticV11.safetensors');

eq('a hardware tier it does not offer falls back too',
  T.trainGraph({ dataset: 'webui-lora-luna', saveAs: 'x', gpu: '4GB', objectInfo: OBJECT_INFO })
    .prompt['1'].inputs.gpu,
  '8GB');

eq('without the pack it says which nodes are missing, rather than failing later',
  T.trainGraph({ dataset: 'webui-lora-luna', saveAs: 'x', objectInfo: {} }).missing,
  T.TRAIN_NODES);

/* The node picks its dataset from a dropdown of the folders under ComfyUI's
   `input/`, and ComfyUI refuses a graph naming one that is not in it. A folder
   that is absent means the uploads did not land, and saying *that* is the
   difference between a fixable report and a validation error about a dropdown
   the reader has never seen. */
eq('a folder ComfyUI has never heard of is reported as the upload it was',
  T.trainGraph({ dataset: 'webui-lora-nope', saveAs: 'x', objectInfo: OBJECT_INFO }).noDataset,
  'webui-lora-nope');

/* ============================================================== afterwards */

eq('the finished file is found however the list spells it',
  T.findLora(['anima\\other.safetensors', 'webui-luna.safetensors'], 'webui-luna'),
  'webui-luna.safetensors');
check('and a run that left nothing says so', T.findLora(['anima\\other.safetensors'], 'webui-luna') === null);

/* ================================================================ the wiring */

{
  const studio = read('server/studio.js');
  check('the daemon is asked before anything is uploaded',
    /route\('\/studio\/train\/state'/.test(studio) && /daemonState\(daemonBase\(env\)/.test(studio));
  check('the folder is named in one place and handed out',
    /route\('\/studio\/train\/prepare'/.test(studio));
  check('a run that cannot work is refused before it is queued',
    /if \(!daemon\.running\)[\s\S]{0,400}503/.test(studio));
  check('and the finished file is looked up rather than guessed at',
    /route\('\/studio\/train\/result'/.test(studio));

  /* `Number(null)` is 0, and a learning rate of zero is a run that learns
     nothing over forty minutes. It has bitten this codebase twice. */
  check('the dials refuse to read an unset value as zero',
    /const clampDial = \(value, range, fallback\) => \{[\s\S]{0,200}=== ''\) return fallback;/.test(studio));
}

{
  const engine = read('src/syncEngine.js');
  const records = read('server/records.js');
  check('the library syncs', /characters: `characters:\$\{scope\}`/.test(engine)
    && /WHOLE_LISTS = \[[^\]]*'characters'/.test(engine));
  /* The server has to know the kind or the record is refused -- and a kind the
     browser sends and the server rejects is a list that uploads and never
     comes back. */
  check('  and the server knows the kind it will be sent', /'characters',/.test(records));
  /* An ordinary list change reloads the page. A character trained here would
     then reload the page it was trained on. */
  check('  without reloading the page each time one changes',
    /STUDIO_LISTS = new Set\(\[[^\]]*'characters'/.test(engine));
  /* And not swept up as a plain setting on top of that. The key carries its
     own `:scope` suffix, so the settings sweep would otherwise collect it a
     second time -- which is how `userProfile` came to be uploaded once per
     account by the guest. */
  check('  and not uploaded twice, as a list and as a setting',
    /'characters',/.test(read('src/settingsStore.js')));
  /* A run in progress is not a preference either. Synced, another device would
     watch a job it cannot see and then write a character it did not train. */
  check('  and a run in progress stays on the machine running it',
    /MACHINE_LOCAL = new Set\(\[[^\]]*'characterRun'/.test(read('src/settingsStore.js'))
    && /const RUN_KEY = 'characterRun';/.test(read('src/CharacterLab.jsx')));
}

{
  const app = read('src/App.jsx');
  check('a swap sends its own LoRA stack rather than the Studio\'s',
    /\.\.\.\(opts\.loras \? \{ loras: opts\.loras \} : \{\}\),/.test(app));
  check('and it is written into the transcript as the edit it is',
    /request: t\('picture\.req\.swap'/.test(app));
}

/* A LoRA belongs to the base it was trained on, and this trains against the
   Anima DiT. Offered under Krea 2 Turbo, it would spend forty minutes of a
   graphics card on a file that loads into that workflow and does nothing. */
{
  const panel = read('src/StudioPanel.jsx');
  check('the lab is offered only where what it makes can be used',
    /\{has\.lora && model\?\.id === 'anima-base' && \(/.test(panel));
  /* Pressing a card is one press for both halves of a character: the file into
     a slot, the word into the prompt. Half of it is a prompt naming somebody
     the model was never given, or a LoRA with nothing to trigger it. */
  check('and a card applies the LoRA and the word together',
    /loras: stackWith\(f\.loras \|\| \[\], character\)[\s\S]{0,120}prompt: promptWith\(character/.test(panel)
    && /loras: stackWithout\(f\.loras \|\| \[\], character\)[\s\S]{0,140}prompt: withoutTrigger\(/.test(panel));
}

{
  const i18n = read('src/i18n.jsx');
  // Twelve locales; a key added to one is a key the other eleven fall back for.
  for (const key of ['charlab.title', 'charlab.noDaemon', 'picture.req.swap']) {
    const n = i18n.split(`  '${key}': `).length - 1;
    check(`"${key}" is written in every language`, n === 12, `${n}/12`);
  }
}

/* ======================================= the swap, decided rather than pressed

   It was a button on every picture. The request is already in the sentence --
   "이 그림 루나로 바꿔줘" -- and reading that sentence is what the model is for,
   so the button is gone and the model has the tool.

   What the model cannot do is know who exists, so the names go in the system
   message and the tool refuses anything that is not one of them. A swap into a
   character nobody trained is a redraw of the picture into a stranger. */

eq('a name matches the character it names',
  C.findCharacter([{ id: 'a', name: 'Luna', trigger: 'lunachr' }], 'Luna')?.id, 'a');
eq('  whatever case the model wrote it in',
  C.findCharacter([{ id: 'a', name: 'Luna' }], 'luna')?.id, 'a');
eq('  with the quotes it sometimes leaves on',
  C.findCharacter([{ id: 'a', name: 'Luna' }], '"Luna"')?.id, 'a');
eq('  or by the trigger, which is also in front of it',
  C.findCharacter([{ id: 'a', name: 'Luna', trigger: 'lunachr' }], 'lunachr')?.id, 'a');
eq('  and a fuller name still finds it',
  C.findCharacter([{ id: 'a', name: '루나 (교복)' }], '루나')?.id, 'a');
check('but a name nobody has is nobody',
  C.findCharacter([{ id: 'a', name: 'Luna' }], 'Aris') === null);
check('and an empty name is not a match for the first one on the shelf',
  C.findCharacter([{ id: 'a', name: 'Luna' }], '') === null);

{
  const tools = read('src/tools.js');
  const app = read('src/App.jsx');

  check('the model has a tool for it', /name: 'swap_character'/.test(tools));
  check('  which needs no permission, since it draws nothing new',
    /'swap_character',/.test(tools));
  check('  and a tag form for models with no native calls',
    /swap_character: 'TOOL_SWAP_CHARACTER'/.test(tools)
    && /TOOL_SWAP_CHARACTER: 'into'/.test(tools));

  check('the app runs it', /name: 'TOOL_SWAP_CHARACTER'/.test(app));
  /* Which picture is resolved here rather than asked of the model: a model
     asked to re-describe an image describes a different one. */
  check('  on the picture in the conversation, not one the model describes',
    /TOOL_SWAP_CHARACTER[\s\S]{0,1400}latestPictureInChat\(\)/.test(app));
  check('  taking a name nobody trained as danbooru tags rather than refusing it',
    /const into = swapTarget\(charactersRef\.current, asked\);/.test(app));
  check('  and a style, when one was asked for alongside',
    /swapCharacter\(picture, into, \(attrs\.style \|\| ''\)\.trim\(\)\)/.test(app));

  /* The taught names go in the system message because the model has no other
     way to know them. The danbooru ones it already knows, so the tool works
     with an empty library -- which is the case on a fresh install. */
  check('the model is told which names are trained likenesses',
    /Taught here \(prefer these when the name matches/.test(app));
  check('  and the tool is offered even when none are',
    /const characterGuide = `/.test(app));

  // And the button, and its sheet, are gone.
  check('the button is gone', !/pictureAction\('swap'/.test(app));
  check('and so is the sheet it opened', !/CharacterPick/.test(app));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
