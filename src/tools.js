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

import { decodeByteFallback } from './byteFallback.js';

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
        + 'so do not use it to decorate an answer nobody asked to be illustrated. '
        /* "그려줘" is the same word for both, and a diffusion model handed
           "r = 4cos3θ" returns a drawing of a graph -- axes, a squiggle, and
           numbers that are not the ones asked for. */
        + 'Not for an equation, a function, a curve or a set of numbers: those are '
        + 'plotted in the reply itself, exactly, and the writing instructions say how.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            /* "여캐 그려줘" was coming back as `1girl, solo`. A picture model
               given no description does not draw an unspecified person -- it
               draws its own default one, the same every time. */
            description: 'The finished picture, described. Not an instruction. When there is a '
              + 'person in it, say how they look even if the request did not: hair colour and '
              + 'cut, eye colour, the whole outfit, expression, pose, framing, and where they '
              + 'are. A prompt that leaves the appearance out gets the same stock face every '
              + 'time, so design somebody and write them down. Preserve any supplied unusual '
              + 'hair colour or hairstyle instead of normalising it to a stock black/brown '
              + 'colour, long hair, bob, or ponytail unless the user asks for that change. '
              + 'When style is "photo" (Krea 2), write this as natural descriptive English '
              + 'sentences and never as a comma-separated Danbooru tag list. Only use the '
              + 'tag-first format when style is "anime" (Anima).',
          },
          style: {
            type: 'string',
            enum: ['photo', 'anime'],
            description:
              'photo for realism and general illustration, anime for anime and '
              + 'character art. Defaults to photo. This choice also controls prompt format: '
              + 'photo means natural English for Krea 2; anime means Danbooru tags followed '
              + 'by one or two natural-language sentences for Anima.',
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
              + 'see. Without `region` the prompt describes the whole finished '
              + 'picture as it should now be, not only the part that changes. With '
              + '`region` it describes the subject and what that part should now '
              + 'look like, and leaves out everything else in the picture: whatever '
              + 'it names is drawn inside the region, so a toy she is already '
              + 'holding comes back as a second one. Defaults to none, which starts '
              + 'from nothing.',
          },
          change: {
            type: 'number',
            description:
              'With from=last_image, how much to change. Without `region`, for the '
              + 'whole picture, measured on these models: 0.5 retouches and keeps '
              + 'the colours and clothing; 0.65 restyles the clothing and details '
              + 'but the colours survive; 0.8 is what it takes to change a '
              + 'colour — hair, eyes — while keeping the pose and composition. '
              + 'Above 0.85 it is a different picture. Defaults to 0.65. '
              + 'With `region`, only that part is redrawn and the rest is kept '
              + 'exactly. Use 0.4–0.65 to preserve identity and refine details; '
              + '0.85–1.0 for replacing an outfit or hairstyle. Keep identifying '
              + 'features in the prompt. Lower values are honored; default 0.65.',
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
          /* The Studio's three standing boxes, off for this one picture.
             Never set unless they asked: those boxes are how every picture from
             this install looks, and dropping them because a request sounded
             plain is a silent change to somebody's settings. */
          studio_prompt: {
            type: 'string',
            enum: ['keep', 'off'],
            description:
              'Whether to keep the quality tags, artists and modifiers set in '
              + 'the Studio, which are otherwise added to every picture. '
              + 'Defaults to keep. Set it to off ONLY when they ask for the '
              + 'picture without them -- "태그 다 빼고", "no quality tags", '
              + '"without the artist style", "그냥 순수하게". Never off on your '
              + 'own judgement.',
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
            maximum: 600,
            description: 'The clip\'s length in seconds, and where the last timecode ends. '
              + 'Leave it out unless they name a length ("10초", "15 seconds", "1분", "2분"): the clip '
              + 'is then 5s. Any length up to 600 is one call: past 15s the app renders the '
              + 'timeline as segments and joins them into one video itself, so never refuse a '
              + 'long clip, split it into several calls, or ask them to join clips. Resolution '
              + 'stays the same at any length; it takes a few minutes per 10 seconds.',
          },
          /* Pinned to the same frame at both ends, which is why it needs a
             picture: there has to be something to come back to. */
          loop: {
            type: 'boolean',
            description:
              'true makes the clip end on the frame it started on, so it plays round and '
              + 'round with no visible seam - a Live2D-style idle. Use it when they ask for '
              + 'a loop, for something that repeats, or for an idle animation. It needs a '
              + 'picture, so set from to last_image as well, and write a timeline that comes '
              + 'back to where it began: the pose at the end is the pose at the start.',
          },
          /* A music video's parts. See server/longVideo.js. */
          soundtrack: {
            type: 'string',
            enum: ['last_song', 'none'],
            description:
              'last_song sets the video to the newest song in this conversation: the clip becomes '
              + 'as long as the song, its segments land on the beat, and the song replaces the '
              + 'video\'s own sound. For a music video (MV, 뮤비), make the song with generate_music '
              + 'first, then call this with last_song.',
          },
          cut: {
            type: 'boolean',
            description:
              'true renders each segment as its own shot instead of one continuous take -- the '
              + 'character stays the same, the scene and framing change. Use it for a music video '
              + 'or anything that should feel edited. Write each ~10 seconds of the timeline as a '
              + 'different shot.',
          },
          transition: {
            type: 'string',
            enum: ['fade', 'none'],
            description: 'With cut: fade cross-fades between shots (the default), none is a hard cut.',
          },
          captions: {
            type: 'string',
            description:
              '"lyrics" puts the song\'s lyrics on screen as styled captions. Or timed lines, one '
              + 'per line: "[2s-5s] 첫 줄" -- words shown at those times.',
          },
          upscale: {
            type: 'boolean',
            description: 'true doubles the resolution of what is written. Slower; use it when they ask for high quality.',
          },
          aspect: ASPECT_PARAM,
        },
        required: ['prompt'],
      },
    },
  },
  /* Music.
   *
   * ACE-Step writes the song and sings it: one call produces a finished mix,
   * vocals and all, in about as long as the song lasts. Which is why the two
   * fields are what they are -- a *style*, in the vocabulary a music model was
   * trained on (genre, instruments, tempo, mood, production), and the actual
   * lyrics with their section markers. A sentence asking for a song is not
   * either of those, and passing one through gets a song about the request.
   */
  {
    type: 'function',
    function: {
      name: 'generate_music',
      description:
        'Write and record a song, and play it to the person you are talking to. Use it '
        + 'when they ask for a song, a track, background music, a jingle, or music in a '
        + 'named style - "노래 만들어줘", "작곡해줘", "make me a song". You write both the '
        + 'style and the lyrics yourself unless they gave you words to use. Takes about '
        + 'as long as the song lasts, so never call it unasked.',
      parameters: {
        type: 'object',
        properties: {
          style: {
            type: 'string',
            description:
              'The sound, as comma-separated tags in English - genre, instruments, tempo, '
              + 'mood, voice, production: "dream pop, female vocal, reverbed guitars, 90bpm, '
              + 'wistful, warm analogue tape". Not a sentence and not a request; this is the '
              + 'field the music model actually listens to.',
          },
          lyrics: {
            type: 'string',
            description:
              'The words to sing, with section markers on their own lines - [verse], '
              + '[chorus], [bridge], [outro]. Write them in the language the song should be '
              + 'sung in (Korean lyrics for a Korean song). Use their words if they gave '
              + 'you any. Leave it out for an instrumental.',
          },
          instrumental: {
            type: 'boolean',
            description: 'true for music with no singing at all. Leave lyrics out as well.',
          },
          language: {
            type: 'string',
            description: 'The language of the lyrics as a code: ko, en, ja, zh. Default en.',
          },
          duration: {
            type: 'integer',
            minimum: 10,
            maximum: 300,
            description:
              'How long in seconds. Leave it out for about a minute; a full song with '
              + 'verses and a chorus wants 120-180. Only set it when they ask for a length.',
          },
        },
        required: ['style'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swap_character',
      description:
        'Redraw whoever is in the newest picture as somebody else, keeping '
        + 'their clothes, the setting and the framing. Use it when they ask for '
        + 'the person in a picture to be a different character — "이 그림 루나로 '
        + '바꿔줘", "make her Hoshino instead", "같은 구도로 다른 캐릭터". Two '
        + 'kinds of answer work: a character this install has been taught (the '
        + 'system message lists them by name), or any character these models '
        + 'already know, named as danbooru tags it, with the brackets escaped — '
        + '"hoshino \\(blue archive\\)", "ganyu \\(genshin impact\\)". '
        + 'Prefer a taught one when the name is in '
        + 'that list, since it is a likeness trained from real pictures. Not '
        + 'for changing hair, clothes or expression on the same character — '
        + 'that is generate_image with from="last_image".',
      parameters: {
        type: 'object',
        properties: {
          into: {
            type: 'string',
            description:
              'Who to put in the picture. A name from the system message\'s list '
              + 'of taught characters, or danbooru tags for anyone else — the '
              + 'character tag and its series, lowercase, as danbooru writes '
              + 'them, with the brackets escaped: "hoshino \\(blue archive\\)". '
              + 'Unescaped, brackets mean emphasis to the image model and the '
              + 'series is not read as part of the name at all.',
          },
          style: {
            type: 'string',
            description:
              'How it should be drawn, if they asked for that too — '
              + '"watercolor", "90s anime cel", "thick lineart". Comma-separated '
              + 'English tags. Leave it out when they only asked for the '
              + 'character to change.',
          },
        },
        required: ['into'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_shadow',
      description:
        'Lift the shadows out of the newest picture, keeping everything else. '
        + 'Use it when they ask for the shadows or the shading to go — "그림자 '
        + '지워줘", "remove the shading", "그림자 빼줘". It raises the shaded '
        + 'areas towards the light and takes the colour cast out of them, which '
        + 'on flat and anime-coloured work removes the shade outright; on a '
        + 'photograph it lightens the shadow rather than deleting it, because '
        + 'nothing local can invent what a real shadow covers. Say which of '
        + 'those it was if it matters. Seconds, not minutes.',
      parameters: {
        type: 'object',
        properties: {
          strength: {
            type: 'number',
            description:
              'How far to lift, 0 to 2, where 1 is the usual amount. Below 1 '
              + 'leaves some shading; above 1 flattens harder. Leave it out '
              + 'unless they asked for more or less.',
          },
        },
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
  'generate_image', 'generate_video', 'generate_music', 'remove_background', 'upscale_image', 'extend_image',
  'swap_character', 'remove_shadow',
]);

/** The same ones, named as the executor's registry names them. */
export const DRAWING_TAGS = new Set([
  'TOOL_GENERATE_IMAGE', 'TOOL_GENERATE_VIDEO', 'TOOL_GENERATE_MUSIC',
  'TOOL_REMOVE_BACKGROUND', 'TOOL_UPSCALE_IMAGE', 'TOOL_EXTEND_IMAGE',
  'TOOL_SWAP_CHARACTER', 'TOOL_REMOVE_SHADOW',
]);

/**
 * Where the n-th finished drawing call ends in a reply, or -1.
 *
 * Only the answer counts: a tag inside reasoning (`<think>`) is the model
 * thinking about drawing, and a reply still thinking has no answer yet.
 */
export const drawingCallEnd = (text, n = 0) => {
  const source = String(text || '');
  const lastOpen = source.lastIndexOf('<think>');
  const lastClose = source.lastIndexOf('</think>');
  if (lastOpen > lastClose) return -1;
  const start = lastClose === -1 ? 0 : lastClose + '</think>'.length;
  const ends = /<\/(TOOL_[A-Z_]+)\s*>|<(TOOL_[A-Z_]+)[^<>]*\/>/gi;
  ends.lastIndex = start;
  let seen = 0;
  let match;
  while ((match = ends.exec(source)) !== null) {
    if (!DRAWING_TAGS.has((match[1] || match[2]).toUpperCase())) continue;
    if (seen === n) return match.index + match[0].length;
    seen += 1;
  }
  return -1;
};

/**
 * A reply as it may be shown while its drawing has not been made yet.
 *
 * Tools run once the reply has finished arriving, so whatever the model wrote
 * after the drawing call -- "I hope you like it!" -- reached the screen before
 * the picture, and stayed there when the drawing failed and was tried again.
 * Everything after the first finished drawing call waits for the picture.
 */
export const holdAfterDrawing = (text) => {
  const end = drawingCallEnd(text, 0);
  return end === -1 ? text : String(text).slice(0, end).replace(/\s+$/, '');
};

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
export const schemasFor = ({ web = false, drawing = true, mcp = [] } = {}) => {
  const built = TOOL_SCHEMAS.filter((t) => {
    const name = t.function?.name;
    return DRAWING_TOOLS.has(name) ? drawing : web;
  });

  /* Tools from MCP servers, on the same switch as the other tools that reach
     outside the browser. They are described by whoever wrote the server, so
     the description goes through untouched -- rewriting somebody else's tool
     description to match the house style would be this app deciding what a
     tool it has never seen is for. */
  if (!web || !mcp?.length) return built;
  return built.concat(mcp.map(tool => ({
    type: 'function',
    function: {
      name: tool.qualified,
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} },
    },
  })));
};

/**
 * One tag for every tool this app did not write.
 *
 * The executor matches tag text, and the built-in tools each get a tag with
 * named attributes because their arguments are known here. An MCP tool's are
 * not: the schema arrives at run time from a server this codebase has never
 * seen, and inventing an attribute per field would mean a tag shape that
 * changes with the config.
 *
 * So the arguments travel as JSON in the body, and one entry in the executor's
 * registry serves every MCP tool there will ever be. The model never writes
 * this tag -- it is produced here, from a structured call -- so its legibility
 * to a model is not a consideration, which is exactly why it can be the shape
 * that is easiest to parse correctly.
 */
export const MCP_TAG = 'TOOL_MCP';

/** Is this the name of a tool from a server, rather than a built-in? */
export const isMcpToolName = (name) => typeof name === 'string' && name.startsWith('mcp_');

/* The built-in file tags, carried out by an MCP filesystem server when one is
 * configured.
 *
 * The built-in ones go through `/localfs`, which the server keeps switched
 * off unless ALLOW_LOCAL_FS=true -- and a model offered both the built-in tags
 * and a filesystem server in `mcp.json` reached for the built-in ones, was
 * told "local file access is disabled", and gave up, while the server it was
 * allowed to use sat unused. So the tag is kept (it is what every model
 * already knows to write) and the work goes to the server: `mcp.json` is the
 * permission either way, with its folders and its allow-list.
 *
 * Returns `{ server, tool, args }`, or null when no server offers the tool. */
const escapeRegExp = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FILE_TAG_TOOLS = {
  TOOL_READ_FILE: [['read_text_file', ({ path }) => ({ path })], ['read_file', ({ path }) => ({ path })]],
  TOOL_LIST_DIR: [['list_directory', ({ path }) => ({ path })]],
  TOOL_WRITE_FILE: [['write_file', ({ path, content }) => ({ path, content })]],
  TOOL_SEARCH_FILES: [
    // The workbench searches contents, which is what this tag has always meant.
    ['grep', ({ path, query }) => ({ path, pattern: escapeRegExp(query), files_only: true, ignore_case: true })],
    // The filesystem server matches names only: a glob around the words.
    ['search_files', ({ path, query }) => ({ path, pattern: `**/*${query}*` })],
  ],
};
export const mcpFileRoute = (tag, mcpTools = [], { path = '', content = '', query = '' } = {}) => {
  for (const [name, argsOf] of FILE_TAG_TOOLS[tag] || []) {
    const found = (mcpTools || []).find(t => t?.name === name && !t.synthetic);
    if (!found) continue;
    return { server: found.server, tool: name, args: argsOf({ path, content, query }) };
  }
  return null;
};

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
  generate_music: 'TOOL_GENERATE_MUSIC',
  remove_background: 'TOOL_REMOVE_BACKGROUND',
  upscale_image: 'TOOL_UPSCALE_IMAGE',
  extend_image: 'TOOL_EXTEND_IMAGE',
  swap_character: 'TOOL_SWAP_CHARACTER',
  remove_shadow: 'TOOL_REMOVE_SHADOW',
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
/* Byte-fallback tokens, put back into characters, in every string of a call.

   A model's words go through `decodeByteFallback` on their way to the screen;
   a native call's arguments did not. gemma4 writes a character outside its
   merged vocabulary as its UTF-8 bytes spelled out -- the ideographic space
   U+3000 as `<0xE3><0x80><0x80>` -- and Ollama hands the tool arguments over
   as written. Reported as Japanese lyrics sung and saved with those tokens in
   them: `加速する鼓動<0xE3><0x80><0x80>デジタルな空`. */
const decodeArgs = (value) => {
  if (typeof value === 'string') return decodeByteFallback(value);
  if (Array.isArray(value)) return value.map(decodeArgs);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeArgs(item)]));
  }
  return value;
};

export const parseToolArgs = (raw) => {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return decodeArgs(raw);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? decodeArgs(parsed) : {};
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
 * and never closes with nothing in it to run: `<TOOL_TIME>` in a sentence is
 * text somebody wrote.
 *
 * An opening tag that never closes but already carries its argument is a call:
 *
 *     <TOOL_GENERATE_IMAGE style="anime" from="none" prompt="a cat, on a wall">
 *
 * The prompt is right there and no body is coming, so the missing
 * `</TOOL_GENERATE_IMAGE>` is a typo -- not a reason to print the tag at the
 * person instead of drawing. A tool whose body is the payload is exempt:
 * without its closing tag that body was cut off, and running it would write the
 * wrong thing.
 */
const OPEN_TOOL = /<(TOOL_(?!RESULT\b)[A-Z_]+)(?=[\s/>])/gi;
/* Which attribute is really the body, per tool. Per tool, because
   TOOL_SEARCH_FILES takes `query` as an attribute on purpose and its body is
   meant to be empty. */
const BODY_ATTR = {
  TOOL_GENERATE_IMAGE: 'prompt',
  TOOL_GENERATE_VIDEO: 'prompt',
  TOOL_EXTEND_IMAGE: 'prompt',
  // The body is the character's name, so a model that writes the tag
  // rather than a native call has one obvious place to put it.
  TOOL_SWAP_CHARACTER: 'into',
  TOOL_WEB_SEARCH: 'query',
  TOOL_NEWS: 'topic',
  TOOL_FETCH_URL: 'url',
  TOOL_READ_FILE: 'path',
  TOOL_LIST_DIR: 'path',
};
/* Tools whose body is the payload rather than a convenience: the contents of a
   file, the lyrics of a song. An unclosed one of those has lost that payload,
   so it stays the text it looks like rather than running on half of it. */
const BODY_IS_PAYLOAD = new Set(['TOOL_WRITE_FILE', 'TOOL_GENERATE_MUSIC']);

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

/* `{"action": "generate_image", "action_input": {...}}` -- the LangChain agent
 * shape some models write as text instead of a tag. `action_input` often comes
 * as a JSON string with its inner quotes left unescaped, which JSON.parse
 * rejects, so the known arguments are read one key at a time. */
const ACTION_KEYS = ['prompt', 'style', 'negative', 'from', 'change', 'region', 'count', 'aspect',
  'duration', 'loop', 'soundtrack', 'cut', 'transition', 'captions', 'upscale', 'factor',
  'direction', 'amount', 'query', 'url', 'topic', 'path', 'content', 'lyrics', 'language',
  'instrumental', 'into', 'strength'];
const actionArgs = (block) => {
  const flat = block.replace(/\\"/g, '"');
  const args = {};
  for (const key of ACTION_KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*(?:"([\\s\\S]*?)"(?=\\s*[,}\\n])|(-?\\d+(?:\\.\\d+)?|true|false))`).exec(flat);
    if (m) args[key] = m[1] ?? (m[2] === 'true' ? true : m[2] === 'false' ? false : Number(m[2]));
  }
  return args;
};
export const jsonActionTags = (source) => {
  const text = String(source ?? '');
  if (!/"action"\s*:/.test(text)) return text;
  let out = '';
  let at = 0;
  const finder = /"action"\s*:\s*"([A-Za-z_]+)"/g;
  let m;
  while ((m = finder.exec(text)) !== null) {
    const raw = m[1];
    const name = TAG_FOR[raw.toLowerCase()] ? raw.toLowerCase()
      : Object.keys(TAG_FOR).find(k => TAG_FOR[k] === raw.toUpperCase());
    if (!name) continue;
    const start = text.lastIndexOf('{', m.index);
    if (start < at) continue;
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) break;                      // still streaming
    let from = start;
    let to = end;
    const fence = /```(?:json)?\s*$/i.exec(text.slice(at, start));
    const after = /^\s*```/.exec(text.slice(end));
    if (fence && after) { from = at + fence.index; to = end + after[0].length; }
    const tag = nativeCallToTag(name, actionArgs(text.slice(start, end)));
    if (!tag) continue;
    out += text.slice(at, from) + tag;
    at = to;
    finder.lastIndex = to;
  }
  return out + text.slice(at);
};

export const canonicalToolTags = (source) => {
  const text = jsonActionTags(source);
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
      if (closing) {
        body = text.slice(head.end, head.end + closing.index);
        end = head.end + closing.index + closing[0].length;
      } else {
        /* Opened and never closed. Complete it anyway when the attributes
           already say what to do -- otherwise it is text somebody wrote. */
        const carried = BODY_ATTR[name]
          ? head.attrs.some(([key]) => key === BODY_ATTR[name])
          : head.attrs.length > 0 && !BODY_IS_PAYLOAD.has(name);
        if (!carried) continue;
      }
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
export const nativeCallToTag = (name, rawArgs, { mcp = [] } = {}) => {
  /* A tool from a server, before the built-in lookup: its name is not in
     TAG_FOR and never will be, since the set of them depends on a config file
     rather than on this source. Matched against what the server actually
     offered, so a model inventing an `mcp_`-prefixed name is still refused. */
  const served = isMcpToolName(name) ? mcp.find(tool => tool.qualified === name) : null;
  if (served) {
    return `<${MCP_TAG} server="${attr(served.server)}" tool="${attr(served.name)}">`
      + `${JSON.stringify(parseToolArgs(rawArgs))}</${MCP_TAG}>`;
  }

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
    /* The lyrics are the body, because they are the part with newlines in it
       and an attribute cannot hold those. */
    case 'generate_music':
      return `<${tag} style="${attr(args.style || '')}"`
        + `${args.duration ? ` duration="${attr(args.duration)}"` : ''}`
        + `${args.language ? ` language="${attr(args.language)}"` : ''}`
        + `${args.instrumental ? ' instrumental="true"' : ''}>${args.lyrics ?? ''}</${tag}>`;
    case 'generate_video': {
      /* Timed caption lines travel in the body, under the timeline -- see
         splitCaptions in src/videoPrompt.js -- and "lyrics" as an attribute. */
      const captions = String(args.captions || '').trim();
      const timed = captions && captions.toLowerCase() !== 'lyrics' ? `\nCAPTIONS:\n${captions}` : '';
      return `<${tag} from="${attr(args.from || 'none')}"`
        + `${args.duration ? ` duration="${attr(args.duration)}"` : ''}`
        + `${args.aspect ? ` aspect="${attr(args.aspect)}"` : ''}`
        + `${args.loop ? ' loop="true"' : ''}`
        + `${args.soundtrack === 'last_song' ? ' soundtrack="last_song"' : ''}`
        + `${args.cut ? ' cut="true"' : ''}`
        + `${args.transition === 'none' ? ' transition="none"' : ''}`
        + `${captions.toLowerCase() === 'lyrics' ? ' captions="lyrics"' : ''}`
        + `${args.upscale ? ' upscale="true"' : ''}>${args.prompt ?? ''}${timed}</${tag}>`;
    }
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
