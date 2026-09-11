/**
 * Tools, described to the model rather than explained to it.
 *
 * The app has always had agent tools, and the way it asked for them was a page
 * of instructions in the system prompt telling the model to emit
 * `<TOOL_WEB_SEARCH>…</TOOL_WEB_SEARCH>` and stop. That works, until it does
 * not: the tag has to be spelled exactly, closed exactly, and emitted alone,
 * and a model that writes `<tool_web_search>` or adds a sentence afterwards
 * has silently done nothing. There is no error — the text simply reads as
 * prose and the tool never runs.
 *
 * Ollama takes a `tools` array in the same shape OpenAI uses, and the models
 * worth using here (qwen3, gemma) advertise `tools` in `/api/show`. Given
 * that, the model does not have to be *told* how to spell a tool call; it
 * returns a structured `tool_calls` array and there is nothing to parse out of
 * prose. Arguments arrive typed, several calls can come back at once, and a
 * model that does not support tools is told so by the server rather than
 * failing quietly at run time.
 *
 * What this module is: the schemas, and the small translation that lets one
 * executor serve both protocols. The executor still matches on tag text — so
 * rather than duplicate it, a native call is rendered *into* the tag it would
 * have been. One implementation, two ways in.
 */

/**
 * The tools, in Ollama's format.
 *
 * Descriptions are written for a model choosing between them, which means they
 * say when to use the tool rather than what it does. "Returns search results"
 * is useless; "snippets are not enough to answer a factual question, follow up
 * with fetch_url" is the sentence that changes behaviour.
 */

/* The shape of a picture or a clip, when they ask for one. Left out otherwise:
   the app then follows the picture being worked from -- the one they attached
   last, or the one being edited or animated -- and the Studio's size when there
   is none. */
const ASPECT_PARAM = {
  type: 'string',
  description:
    'Only when they ask for a shape or orientation: a ratio like "16:9", "9:16", "1:1", '
    + '"4:3", "3:4", "21:9" (가로 → 16:9, 세로 → 9:16, 정사각형 → 1:1). Leave it out '
    + 'otherwise; a picture made from another picture keeps that picture\'s shape.',
};

export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web and return titles, URLs and short snippets. The snippets '
        + 'are rarely enough to answer a factual question on their own — follow up '
        + 'with fetch_url on the most relevant result. Do not use this for news; '
        + 'use get_news, which returns stories rather than portal front pages.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description:
        'Open a web page and return its readable text. This is how you get real '
        + 'detail, quotes, dates and numbers, rather than the summary a search '
        + 'snippet gives you.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The full URL, including https://' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_news',
      description:
        'Current headlines with publisher and timestamp. Leave the topic empty for '
        + "today's top stories. Use this rather than web_search for anything about "
        + 'the news.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'Optional subject; empty for top stories.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "Read a file from this computer's disk and return its text.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'An absolute path.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write text to a file on this computer, replacing what is there.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'An absolute path.' },
          content: { type: 'string', description: 'The complete new contents.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the files and folders in a directory on this computer.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'An absolute directory path.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Find files under a directory whose contents contain some text.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'An absolute directory to search under.' },
          query: { type: 'string', description: 'The text to look for.' },
        },
        required: ['path', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: 'The current date, time and time zone on this computer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_models',
      description: 'The models installed in this Ollama.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_info',
      description: 'CPU, memory and GPU usage of this computer.',
      parameters: { type: 'object', properties: {} },
    },
  },
  /* Drawing.
   *
   * The description says what a diffusion prompt is, because that is the part a
   * language model gets wrong: handed "make a picture of my idea" it passes the
   * sentence straight through, and these models answer a sentence with a
   * literal illustration of it. They want a described scene — subject, setting,
   * light, framing — which the model is perfectly capable of writing if it is
   * told that is what the field is for.
   *
   * It takes a minute or so and the reader is watching, so the tool is
   * deliberately not offered for anything a picture is incidental to. */
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        'Draw a picture and show it to the person you are talking to. Use it when '
        + 'they ask for an image, an illustration, a diagram-as-art, a mock-up or a '
        + 'design — including when they ask in passing, as in "그림 그려줘" or "draw me '
        + 'one". The prompt is not a request — it is a description of the finished '
        + 'picture: name the subject, the setting, the lighting and the framing. '
        + 'Write it in English even when the conversation is in another language, '
        + 'because that is what these models were trained on. Takes about a minute, '
        + 'so do not use it to decorate an answer nobody asked to be illustrated.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description: 'The finished picture, described. Not an instruction.',
          },
          style: {
            type: 'string',
            enum: ['photo', 'anime'],
            description:
              'photo for realism and general illustration, anime for anime and '
              + 'character art. Defaults to photo.',
          },
          /* Written by the model, because it is the half of a diffusion prompt
             that depends on what is being drawn: a portrait wants "extra
             fingers, deformed hands" and a landscape wants "people, text,
             watermark", and a fixed list applied to both is the wrong list
             twice. Optional -- a model that leaves it out gets the workflow's
             own, which is what happened before this existed. */
          negative: {
            type: 'string',
            description:
              'What must not appear, as comma-separated words rather than a '
              + 'sentence: the flaws this particular subject tends to come out '
              + 'with, plus anything the request rules out. In English. Leave '
              + 'it out if nothing in particular applies.',
          },
          /* Changing a picture is not the same request as making one, and it
             is the one people make most after the first picture arrives: "make
             her hair blue", "same but at night". Redrawing from a new prompt
             loses everything they liked about the first one. */
          from: {
            type: 'string',
            enum: ['last_image', 'none'],
            description:
              'last_image edits the most recent picture in this conversation '
              + 'instead of drawing a new one — use it whenever they ask to '
              + 'change, fix, adjust or re-colour the picture they can already '
              + 'see. The prompt then describes the whole finished picture as '
              + 'it should now be, not only the part that changes. Defaults to '
              + 'none, which starts from nothing.',
          },
          change: {
            type: 'number',
            description:
              'With from=last_image, how much to change. Measured on these '
              + 'models rather than guessed: 0.5 retouches and keeps the '
              + 'colours and clothing; 0.65 restyles the clothing and details '
              + 'but the colours survive; 0.8 is what it takes to change a '
              + 'colour — hair, eyes — while keeping the pose and composition. '
              + 'Above 0.85 it is a different picture. Defaults to 0.65, or to '
              + '0.9 when `region` is set, because then only that part is redrawn.',
          },
          /* Where the change is. Without it an edit redraws the whole picture
             at `change`, and asking for shorter hair came back with a new
             collar, the buttons moved and the socks swapped: the model was
             given every pixel and used them. With it, the app finds that part
             of the picture itself and redraws only there; everything else is
             the original, pixel for pixel. */
          region: {
            type: 'string',
            description:
              'With from=last_image, the part of the picture to change, as a short '
              + 'English noun: "hair", "eyes", "clothes", "shirt", "background", '
              + '"sky", "face". Up to three, comma-separated, when the change '
              + 'spills over — hair that gets longer also covers "shoulders". '
              + 'Everything outside it stays exactly as it is. Set it for any '
              + 'change to one part: hairstyle, hair or eye colour, an outfit, the '
              + 'background. Leave it out only for changes to the whole picture: '
              + 'style, lighting, time of day, pose.',
          },
          /* Several at once, for "draw a few" and "show me some options" --
             the same prompt with a different seed each, so they are variations
             on one idea rather than four ideas. */
          count: {
            type: 'integer',
            minimum: 1,
            maximum: 4,
            description:
              'How many pictures to make, 1 to 4, each with its own seed. Only above 1 '
              + 'when they ask for several or for options to choose from. Defaults to 1.',
          },
          aspect: ASPECT_PARAM,
        },
        required: ['prompt'],
      },
    },
  },
  /* Things done to the picture already there, rather than a new one drawn.
   *
   * Each acts on the most recent picture in the conversation, which the app
   * finds itself -- the same reason `from: last_image` exists. None of them
   * asks the model to describe anything, except extending, which has to be told
   * what the new margin shows. */
  {
    type: 'function',
    function: {
      name: 'remove_background',
      description:
        'Cut the subject out of the most recent picture in this conversation and '
        + 'return it on a transparent background. Use it for "배경 지워줘", "remove '
        + 'the background", "make it a sticker / PNG". Takes no arguments.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upscale_image',
      description:
        'Make the most recent picture in this conversation bigger and sharper with '
        + 'an upscaling model. Use it for "더 크게", "고화질로", "upscale", "sharper". '
        + 'It adds resolution, not content.',
      parameters: {
        type: 'object',
        properties: {
          factor: {
            type: 'integer',
            enum: [2, 4],
            description: 'How many times larger. Defaults to 2. A picture that is already '
              + 'large is enlarged as far as a chat can hold.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extend_image',
      description:
        'Extend the most recent picture beyond its edges -- more of the scene to the '
        + 'sides, above or below -- keeping what is already there exactly as it is. '
        + 'Use it for "가로로 늘려줘", "전신이 보이게", "zoom out", "wider". For changing '
        + 'what is inside the picture, use generate_image with from=last_image instead.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            enum: ['left', 'right', 'up', 'down', 'horizontal', 'vertical', 'all'],
            description: 'Which edges to extend. horizontal is both sides, vertical top and '
              + 'bottom, all is every edge (zoom out). Defaults to horizontal.',
          },
          amount: {
            type: 'number',
            description: 'How much to add on each extended edge, as a fraction of the '
              + 'picture\'s size: 0.25 is a quarter more, 0.5 half. Between 0.1 and 1. '
              + 'Defaults to 0.5.',
          },
          prompt: {
            type: 'string',
            description: 'The whole finished picture described, including what the new '
              + 'margins show -- the same kind of prompt as generate_image, in English.',
          },
        },
        required: ['prompt'],
      },
    },
  },
  /* Filming.
   *
   * Separate from `generate_image` rather than a mode of it, because the two
   * differ in what they cost and in what they need. A video is minutes rather
   * than a minute, and "make *that* into a video" is the common request — so
   * the tool takes which picture to move, and the executor resolves it against
   * what is already in the conversation. A model asked to re-describe an image
   * it can see would describe it differently, and the video would be of
   * something else.
   */
  {
    type: 'function',
    function: {
      name: 'generate_video',
      description:
        'Make a short video and show it to the person you are talking to. Use it '
        + 'when they ask for a video, an animation, or for something to move — '
        + 'including "이걸 영상으로 만들어줘" or "animate that". If they mean a picture '
        + 'that is already in this conversation, set `from` to `last_image`; the '
        + 'app will find it. Only use `from: none` when they want a video made from '
        + 'nothing but words. This takes several minutes, so never use it unasked.',
      parameters: {
        type: 'object',
        properties: {
          /* H3 holds a clip together far better given a timeline than a
             paragraph. The executor makes the timecodes agree with the clip's
             length whatever is written -- see src/videoPrompt.js. */
          prompt: {
            type: 'string',
            description:
              'The clip as a timeline, in English, present tense: "[0s-2s] …" then '
              + '"[2s-5s] …", contiguous from 0s to the clip\'s length, 1-3 sentences '
              + 'each (2-3 segments for ~5s, 3-4 for ~8s, 5-8 for ~15s). Describe motion '
              + 'and camera movement, setting, light and mood, and imply the sound through '
              + 'what is seen ("waves crash"). Describe the scene directly, never "create a video".',
          },
          from: {
            type: 'string',
            enum: ['last_image', 'none'],
            description:
              'last_image animates the most recent picture in this conversation — '
              + 'one you generated or one they attached. none starts from nothing.',
          },
          duration: {
            type: 'integer',
            minimum: 5,
            maximum: 20,
            description: 'The clip\'s length in seconds, and where the last timecode ends. '
              + '5 unless they ask for longer; 15 is a long clip.',
          },
          aspect: ASPECT_PARAM,
        },
        required: ['prompt'],
      },
    },
  },
];

/* Drawing is not a web tool.
 *
 * Everything else here reaches outside the machine or into its filesystem, and
 * hiding those behind a switch somebody has to find is right. Making a picture
 * does neither, and it is the one tool people ask for by name in the middle of
 * a sentence — "그림 그려줘". Behind the same switch, that request was answered
 * with a paragraph describing the picture instead of the picture, because the
 * model had not been told it could draw.
 *
 * So these two are always offered and the rest stay behind the switch. */
export const DRAWING_TOOLS = new Set([
  'generate_image', 'generate_video', 'remove_background', 'upscale_image', 'extend_image',
]);

/** The same ones, named as the executor's registry names them. */
export const DRAWING_TAGS = new Set([
  'TOOL_GENERATE_IMAGE', 'TOOL_GENERATE_VIDEO', 'TOOL_REMOVE_BACKGROUND', 'TOOL_UPSCALE_IMAGE', 'TOOL_EXTEND_IMAGE',
]);

/**
 * The schemas to send.
 *
 * `web` is the switch: fetching a page or reading a file needs permission and
 * drawing does not. `drawing` is not a preference — it goes false once a
 * picture has been made this turn, so the model cannot draw a second one. A
 * model told "you have 9 tool calls left" after drawing takes it as an
 * invitation, and the only reliable answer to that is to stop handing it the
 * tool.
 */
export const schemasFor = ({ web = false, drawing = true } = {}) =>
  TOOL_SCHEMAS.filter((t) => {
    const name = t.function?.name;
    return DRAWING_TOOLS.has(name) ? drawing : web;
  });

/** Which tag each native name renders into. */
const TAG_FOR = {
  web_search: 'TOOL_WEB_SEARCH',
  fetch_url: 'TOOL_FETCH_URL',
  get_news: 'TOOL_NEWS',
  read_file: 'TOOL_READ_FILE',
  write_file: 'TOOL_WRITE_FILE',
  list_dir: 'TOOL_LIST_DIR',
  search_files: 'TOOL_SEARCH_FILES',
  get_time: 'TOOL_TIME',
  list_models: 'TOOL_LIST_MODELS',
  system_info: 'TOOL_SYSTEM_INFO',
  generate_image: 'TOOL_GENERATE_IMAGE',
  generate_video: 'TOOL_GENERATE_VIDEO',
  remove_background: 'TOOL_REMOVE_BACKGROUND',
  upscale_image: 'TOOL_UPSCALE_IMAGE',
  extend_image: 'TOOL_EXTEND_IMAGE',
};

export const toolNames = () => Object.keys(TAG_FOR);

/**
 * Arguments, whatever shape they arrived in.
 *
 * The spec says an object. Ollama gives an object; some models hand back a
 * JSON string, and one that produces neither has produced nothing useful, so
 * an empty object is the honest reading — the tool then fails on its own
 * missing-argument path with a message the model can act on.
 */
export const parseToolArgs = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }
  return {};
};

/** Escape a value that is about to sit inside a double-quoted tag attribute. */
const attr = (value) => String(value ?? '').replace(/"/g, '&quot;');

/**
 * The attributes of a tool tag, by name.
 *
 * Read by name rather than by position because models do not write them in
 * the order the documentation lists them, and a pattern with the attributes in
 * a fixed order does not match `negative="…" style="…"` at all -- the call is
 * not run and the tag sits in the answer as text.
 */
export const tagAttrs = (text) => {
  const out = {};
  for (const [, name, value] of String(text || '').matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)) {
    out[name.toLowerCase()] = value.replace(/&quot;/g, '"');
  }
  return out;
};

/** The attribute list of a tool tag, as a pattern fragment: any names, any order. */
export const TAG_ATTRS = String.raw`((?:\s+[A-Za-z_][\w-]*="[^"]*")*)`;

/**
 * Tool tags as the documentation writes them, whatever a model wrote.
 *
 * Models write HTML, not this app's tag format, and the difference was enough
 * for a call never to run -- the tag sat in the answer as text instead:
 *
 *     <TOOL_GENERATE_VIDEO from="last_image" duration=5 prompt="[0s-2s] …" />
 *
 * Self-closing, the prompt as an attribute, a value without quotes. Each of
 * those is rewritten into the one form every reader of these tags matches:
 *
 *     <TOOL_GENERATE_VIDEO from="last_image" duration="5">[0s-2s] …</TOOL_GENERATE_VIDEO>
 *
 * The attribute that is really the argument -- `prompt` for a picture, `query`
 * for a search -- becomes the body when the body is empty.
 * Single-quoted and bare values are quoted. A tag whose opening is not finished
 * yet -- still streaming -- is left exactly as it is, and so is a tag that opens
 * and never closes, which is text somebody wrote.
 */
const OPEN_TOOL = /<(TOOL_(?!RESULT\b)[A-Z_]+)(?=[\s/>])/gi;
/* Which attribute is really the body, per tool. Per tool, because
   TOOL_SEARCH_FILES takes `query` as an attribute on purpose and its body is
   meant to be empty. */
const BODY_ATTR = {
  TOOL_GENERATE_IMAGE: 'prompt',
  TOOL_GENERATE_VIDEO: 'prompt',
  TOOL_EXTEND_IMAGE: 'prompt',
  TOOL_WEB_SEARCH: 'query',
  TOOL_NEWS: 'topic',
  TOOL_FETCH_URL: 'url',
  TOOL_READ_FILE: 'path',
  TOOL_LIST_DIR: 'path',
};

const readOpening = (text, from) => {
  const attrs = [];
  let j = from;
  const space = () => { while (j < text.length && /\s/.test(text[j])) j += 1; };
  for (;;) {
    space();
    if (j >= text.length) return null;
    if (text[j] === '>') return { attrs, end: j + 1, selfClosing: false };
    if (text[j] === '/' && text[j + 1] === '>') return { attrs, end: j + 2, selfClosing: true };
    const name = /^[A-Za-z_][\w-]*/.exec(text.slice(j, j + 64));
    if (!name) return null;
    j += name[0].length;
    space();
    if (text[j] !== '=') { attrs.push([name[0].toLowerCase(), '']); continue; }
    j += 1;
    space();
    let value;
    if (text[j] === '"' || text[j] === "'") {
      const close = text.indexOf(text[j], j + 1);
      if (close === -1) return null;
      value = text.slice(j + 1, close);
      if (text[j] === "'") value = value.replace(/"/g, '&quot;');
      j = close + 1;
    } else {
      const bare = /^[^\s>"']+/.exec(text.slice(j));
      if (!bare) return null;
      value = bare[0];
      // `duration=5/>`: the slash belongs to the tag, not the value.
      if (value.endsWith('/') && text[j + value.length] === '>') value = value.slice(0, -1);
      j += value.length;
      value = value.replace(/"/g, '&quot;');
    }
    attrs.push([name[0].toLowerCase(), value]);
  }
};

export const canonicalToolTags = (source) => {
  const text = String(source ?? '');
  if (!/<TOOL_/i.test(text)) return text;
  let out = '';
  let at = 0;
  const open = new RegExp(OPEN_TOOL.source, 'gi');
  let match;
  while ((match = open.exec(text)) !== null) {
    const name = match[1].toUpperCase();
    const head = readOpening(text, match.index + match[0].length);
    if (!head) continue;                       // unfinished: leave it for the streaming view

    let body = '';
    let end = head.end;
    if (!head.selfClosing) {
      const closing = new RegExp(`</${match[1]}\\s*>`, 'i').exec(text.slice(head.end));
      if (!closing) continue;                  // opened and never closed: text somebody wrote
      body = text.slice(head.end, head.end + closing.index);
      end = head.end + closing.index + closing[0].length;
    }

    let attrs = head.attrs;
    if (!body.trim() && BODY_ATTR[name]) {
      const carried = attrs.find(([key]) => key === BODY_ATTR[name]);
      if (carried) {
        body = carried[1].replace(/&quot;/g, '"');
        attrs = attrs.filter(a => a !== carried);
      }
    }
    out += text.slice(at, match.index)
      + `<${name}${attrs.map(([key, value]) => ` ${key}="${value}"`).join('')}>${body}</${name}>`;
    at = end;
    open.lastIndex = end;
  }
  return out + text.slice(at);
};

/**
 * Render a native tool call as the tag the executor already understands.
 *
 * This is the whole of the bridge. The executor matches tag text with a regex,
 * so rather than write a second executor keyed on function names — two
 * implementations of the same ten tools, drifting apart — a structured call is
 * turned back into the string the existing one reads. Returns null for a name
 * that is not a tool, which is how a hallucinated function is refused.
 */
export const nativeCallToTag = (name, rawArgs) => {
  const tag = TAG_FOR[name];
  if (!tag) return null;
  const args = parseToolArgs(rawArgs);

  switch (name) {
    case 'web_search': return `<${tag}>${args.query ?? ''}</${tag}>`;
    case 'fetch_url': return `<${tag}>${args.url ?? ''}</${tag}>`;
    case 'get_news': return `<${tag}>${args.topic ?? ''}</${tag}>`;
    case 'read_file':
    case 'list_dir': return `<${tag}>${args.path ?? ''}</${tag}>`;
    case 'write_file':
      return `<${tag} path="${attr(args.path)}">\n${args.content ?? ''}\n</${tag}>`;
    case 'search_files':
      return `<${tag} path="${attr(args.path)}" query="${attr(args.query)}"></${tag}>`;
    case 'generate_image':
      return `<${tag} style="${attr(args.style || 'photo')}" negative="${attr(args.negative || '')}"`
        + ` from="${attr(args.from || 'none')}" change="${attr(args.change ?? '')}"`
        + `${args.region ? ` region="${attr(args.region)}"` : ''}`
        + `${Number(args.count) > 1 ? ` count="${attr(args.count)}"` : ''}`
        + `${args.aspect ? ` aspect="${attr(args.aspect)}"` : ''}>`
        + `${args.prompt ?? ''}</${tag}>`;
    case 'upscale_image':
      return `<${tag} factor="${attr(args.factor ?? 2)}"></${tag}>`;
    case 'extend_image':
      return `<${tag} direction="${attr(args.direction || 'horizontal')}" amount="${attr(args.amount ?? 0.5)}">`
        + `${args.prompt ?? ''}</${tag}>`;
    case 'generate_video':
      return `<${tag} from="${attr(args.from || 'none')}"`
        + `${args.duration ? ` duration="${attr(args.duration)}"` : ''}`
        + `${args.aspect ? ` aspect="${attr(args.aspect)}"` : ''}>${args.prompt ?? ''}</${tag}>`;
    // The three that take nothing.
    default: return `<${tag}></${tag}>`;
  }
};

/**
 * Does this model do tool calls itself?
 *
 * From `/api/show`, which lists what a model can do. Asked rather than
 * assumed: sending `tools` to a model without them is not an error the server
 * reports, it is a request the model answers by ignoring the tools and
 * inventing prose — the exact silent failure this replaces.
 */
export const supportsTools = (show) =>
  Array.isArray(show?.capabilities) && show.capabilities.includes('tools');

/**
 * The tool calls in one streamed frame, normalised.
 *
 * Ollama puts them on `message.tool_calls`; each has `function.name` and
 * `function.arguments`. Anything else in there is not a call this can run.
 */
export const toolCallsIn = (frame) => {
  const calls = frame?.message?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .map(call => ({
      name: call?.function?.name || '',
      args: parseToolArgs(call?.function?.arguments),
    }))
    .filter(call => call.name);
};
