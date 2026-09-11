# Ollama WebUI

A local, single-page chat UI for [Ollama](https://ollama.com), built with React + Vite.
Everything runs on your machine: chats live in IndexedDB (via `localforage`), settings in
`localStorage`, and model traffic goes straight to Ollama — or to llama.cpp, if you would
rather have the flags. Pictures and video come from a local ComfyUI. Nothing leaves the
building unless you configure something that does.

## Running it

```bash
npm install
npm run dev        # UI only (expects `ollama serve` to already be running)
npm run dev:all    # starts `ollama serve` and the UI together
npm run build      # production bundle into dist/
npm run lint       # oxlint
npm test           # every offline test, ending with a smoke test that starts
                   # the built app in a headless browser
npm run test:smoke # just that last one
npm run test:live  # artifact pipeline against a live Ollama model
```

**`npm test` starts the app.** That last step exists because three crashes shipped without
it, all the same shape — a `const` read before the line declaring it, from a hook's
dependency array, which is evaluated during render:

```
Cannot access 'stopSpeaking' before initialization
Cannot access 'isGenerating' before initialization
Cannot access 'mcpEnabled' before initialization
```

Every one passed `npm run build` and `npm run lint` without a murmur. `no-undef` does not
see them, because the name *is* defined; `no-use-before-define` does not either — tested
against the exact code that threw, it reported nothing. Nothing static catches this class.
Starting the app does, in about fifteen seconds, and it is skipped with a message where
there is no Chrome or Edge to start it in.

Or double-click `start_ollama_webui.bat`.

## Configuration

Everything optional is off by default and the app works with none of it. What you
do configure goes in a `.env` file at the repository root — copy `.env.example`
and fill in what you want. `.env` is gitignored, so keys and machine paths stay
on your machine.

| Setting | For |
| --- | --- |
| `VITE_GOOGLE_CLIENT_ID`, `VITE_KAKAO_REST_KEY` | Social sign-in (public by design — they identify the app, not you) |
| `KAKAO_CLIENT_SECRET` | Kakao token exchange. **No `VITE_` prefix**, so it stays server-side and never reaches the browser bundle |
| `BRAVE_API_KEY`, `TAVILY_API_KEY`, `SERPER_API_KEY`, `SEARXNG_URL` | Web search. Without one the search tool falls back to scraping, which works but is fragile |
| `GPT_SOVITS_PATH`, `GPT_SOVITS_PYTHON`, `FFMPEG_BIN` | Voice output — see [`tts/README.md`](tts/README.md) |
| `LLM_BACKEND`, `LLAMACPP_URL` | Which engine runs the model: `ollama` (default) or `llamacpp` — see [Choosing an engine](#choosing-an-engine) |
| `COMFYUI_URL`, `*_CHECKPOINT` | Image and video generation — see [Pictures and video](#pictures-and-video) |

The rule the layout enforces: anything prefixed `VITE_` is compiled into the
bundle and is therefore public; anything without the prefix is read only by the
dev server and never leaves the machine.

The Vite dev server proxies:

| Path        | Target                    |
| ----------- | ------------------------- |
| `/api`      | `http://localhost:11434`  (Ollama), or dev-server middleware translating to llama.cpp |
| `/tts-api`  | `http://127.0.0.1:9880`   (GPT-SoVITS) |
| `/localfs`  | dev-server middleware (local file read/write/list/search) |
| `/kakao`    | dev-server middleware (Kakao OAuth code exchange) |
| `/system`   | dev-server middleware (CPU / GPU / memory stats) |
| `/mcp`      | dev-server middleware (page fetch and web search) |
| `/api/tts-status`, `/api/start-tts` | dev-server middleware (GPT-SoVITS launcher) |
| `/studio`  | dev-server middleware (image and video generation via ComfyUI) |


## Choosing an engine

`LLM_BACKEND` picks what actually runs the model: `ollama` (the default, and what this
app was built against) or `llamacpp`.

**Be clear about what the switch buys, because the headline number is misleading.**
Ollama *is* llama.cpp underneath. Measured head to head the gap is around ten percent,
and it comes from the wrapper rather than the arithmetic — real, but not a reason to
change anything.

The reason is the flags. If a model does not fit in VRAM, `--flash-attn` and a quantised
KV cache decide how many layers land on the GPU **at all**, and the difference between
34% offloaded and 100% offloaded is two to three times the speed, not ten percent. Ollama
does not expose them; `llama-server` takes them on the command line.

Nothing in the browser changes. The client keeps speaking Ollama's dialect and
[`server/llamacpp.js`](server/llamacpp.js) translates, so vision detection, tool
detection, the model list, downloads, the tokens/s footer and the context gauge all keep
working:

| The app asks | llama-server is asked |
| --- | --- |
| `POST /api/chat` (NDJSON) | `POST /v1/chat/completions` (SSE, translated back) |
| `POST /api/embed` | `POST /v1/embeddings` |
| `GET /api/tags` | `GET /models` |
| `POST /api/show` | `GET /models` + `GET /props?model=` |
| `GET /api/ps` | `GET /models`, filtered to the loaded ones |
| `POST /api/pull` | `POST /models` + `GET /models/sse` for progress |
| `POST /api/delete` | `POST /models/unload` |

`llama-server` must be started in **router mode**, or there is no model list and no
switching:

```bash
llama-server --models-dir D:\models --port 8080 \
  --flash-attn --cache-type-k q8_0 --cache-type-v q8_0 \
  -ngl 999 -c 8192
```

| Flag | Why |
| --- | --- |
| `--flash-attn` | Cheaper attention. Almost always a win. |
| `--cache-type-k/v q8_0` | Halves the KV cache, which is what frees the VRAM that buys the extra layers. This is where the speed is. |
| `-ngl 999` | Put every layer it can on the GPU. |
| `-c 8192` | The context. |

**One genuine difference.** In Ollama the context length is a per-request option; in
llama.cpp the KV cache is allocated when the model loads, so it is fixed by `-c`. The app
does not pretend otherwise — `num_ctx` is dropped rather than sent as a lie, and
`/api/show` reports the figure the model was *actually* loaded with, read back off the
running server, so the composer's context gauge measures against the truth.

## Pictures and video

Image and video generation runs in [ComfyUI](https://github.com/comfyanonymous/ComfyUI),
as its own process — the same arrangement as the TTS and STT servers, and for the same
reason: these are multi-gigabyte PyTorch models and no amount of Node will host them.

```bash
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI && pip install -r requirements.txt
python main.py --listen 127.0.0.1 --port 8188
```

Put the checkpoints in `ComfyUI/models/checkpoints/`. The Studio tab reads what is
actually installed and marks what is not, so a missing file is visible before you spend a
minute finding out.

**Every other checkpoint you already have is offered too**, under `Also installed here`.
Four described models none of which are downloaded yet is a Studio that can generate
nothing, and any ComfyUI that has been used for anything has its own models in it. The
described four come with ranges this app knows are right; the found ones get generic SDXL
ranges, which is exactly the case where the numbers belong on sliders.

Generation runs your **own ComfyUI workflows**, kept in `workflows/`. They are not
re-typed as hand-built graphs: the file exported from ComfyUI *is* the artefact, and
`server/comfyGraph.js` converts it to the API format ComfyUI's own `/prompt` accepts —
flattening subgraphs, resolving Reroute/SetNode/GetNode, honouring mute and bypass, and
matching `widgets_values` to names through `/object_info`.

| Workflow | What it is |
| --- | --- |
| **Krea 2 Turbo** | 8 steps, guidance 1, with a built-in LLM prompt refiner. |
| **Anima Base** | Anime and illustration. Booru tags or a sentence. Non-commercial licence — fine for personal use, not for a product. |
| **MiniMax H3** | Video with sound, and a reference-image input — which is what makes "turn this picture into a video" work. |

`server/workflows.js` says where each workflow's interesting inputs live, so the Studio
renders **only the controls that workflow actually has**: Anima gets a negative-prompt box
because its graph has somewhere to put one, and Krea 2 Turbo does not because its negative
conditioning is a `ConditioningZeroOut` with no text input. Sampler, scheduler, checkpoint,
VAE, text encoder and LoRA lists all come from the running ComfyUI, so a model downloaded
this morning is selectable this afternoon. Resolution is two free number boxes, rounded to
the multiple of eight latents need.

> **MiniMax H3 licensing.** The H3 Community Licence excludes the European Union, the
> United Kingdom, South Korea and the United States from *local* deployment. The hosted
> API is available worldwide and is the licensed route in those places. This repository is
> configured to run the weights locally by explicit choice of its owner; the restriction is
> recorded in [`server/studio.js`](server/studio.js) and shown in the Studio panel.

There are two ways in, because they are two different jobs:

* **The Studio** — the second of the two places at the top of the left panel, beside
  Chats — is for when the picture *is* the point. One prompt, one set of numbers, and a gallery — because making a picture
  is a loop rather than a request: write, look, change one word, look again. The seed is a
  control with a lock on it, so you can change one word and see only that word's effect.
  Each model brings its own sane ranges; a distilled model that wants a guidance of 1 does
  not get offered the same slider as one that wants 5.
* **The `generate_image` and `generate_video` tools** are for when a picture or a clip is
  part of an answer. Ask "그림 그려줘" or "이걸 영상으로 만들어줘" in the conversation and the
  model calls them itself. It chooses a *style* rather than a checkpoint — "is this anime"
  is a question it can answer, "Krea 2 Turbo or Anima Base" is not — and for video it says
  only whether to animate the picture already in the conversation; which picture that is, is
  resolved from the transcript rather than re-described by the model, because a model asked
  to describe an image so another model can redraw it produces a different image.

  **Editing a picture** is the request people make after the first one arrives —
  "머리를 파랗게", "make it night" — and redrawing from a new prompt loses
  everything they liked about the first. `generate_image` takes `from:
  last_image`, which the app resolves from the transcript, and `change`, which
  is how far to go. Those numbers were measured rather than guessed: 0.5
  retouches and keeps the colours, 0.65 restyles clothing and details, 0.8 is
  what it takes to change hair from blonde to blue while keeping the pose.

  Anima is already wired for it — its loader takes an image and has a mode to
  switch — and Krea 2 samples from an empty latent, so it is given the two nodes
  that encode a picture at request time and the sampler is repointed at them.
  Either way the reference is scaled to the size being worked at first: a
  picture from this app is the *finished* one, four times the resolution it was
  sampled at, and encoding that is nine times the work. Skipping that step
  filled a 16GB card and turned a seventy-second edit into more than twenty-five
  minutes.

  **One picture per turn.** Searching is iterative and the tool loop is built
  for it: hand back the result, say how many calls are left, ask the model to
  continue. Drawing is not, and the same encouragement read to a model as an
  invitation — it drew, saw "you have 9 tool calls left", and drew again. Once a
  picture exists in a turn the drawing tools are withdrawn from that turn's
  schemas and from the tag registry, so a second call has nothing to call.

  Neither needs the web/tools switch. Fetching a page or reading a file needs
  permission and drawing does not, and behind the same switch a request to draw
  came back as a paragraph describing the picture — the model had never been
  told it could draw. The two drawing tools now go with every turn a
  tool-capable model takes, and the tag-based instructions (for models without
  structured tool calls) document them alongside the rest.

  The model writes both prompts, positive and negative, because what must not appear
  depends on what is being drawn — a portrait wants "extra fingers, deformed hands" and a
  landscape wants "people, text, watermark". Everything *else* comes from the Studio: the
  resolution, sampler, scheduler, checkpoint, VAE and LoRA stack you last used there, per
  workflow, validated against what ComfyUI still has before it is sent. Settings are a
  preference you chose once; a chat message is not a form.

**While it runs, you can see it running.** ComfyUI broadcasts what it is doing on a
websocket — which node, which step of how many, and the partly-denoised latent as a small
JPEG — and the app relays that to the browser over server-sent events. So a generation
shows the picture appearing, what stage it is at in words ("Drawing", "Enlarging",
"Refining faces"), how far through, how long it has taken and roughly what is left, in the
Studio and inside the conversation both. Above that is the whole pipeline this
particular workflow will go through, read off its graph rather than assumed —
which is what makes a percentage mean something, because 89% with an upscaler
still ahead is a minute away and 89% with only the file left to write is
seconds. ComfyUI ships with previews off; the app asks for
them per prompt, so nothing has to be restarted (`COMFYUI_PREVIEW` in `.env`). If the
stream cannot be opened, the job still completes exactly as before — the progress is
additive, never on the path between asking for a picture and getting one.

**The prompt is four boxes, not one.** A positive prompt for these models is
four different things concatenated — the quality words that go first, the
artists, the subject, and the modifiers that go last — and only the subject
changes between one picture and the next. In one box that meant re-reading a
wall of tags to find the two words worth editing. They are joined in order when
the job is sent, because these models read a prompt positionally.

The artists go wherever the workflow can actually use them. Anima has an artist
encoder — `AnimaArtistPack` conditions on each name separately and
`AnimaArtistCrossAttn` patches the model with them, which is a different
mechanism from naming somebody in the prompt — so its artist box is wired
straight to that node, and the names are held out of the prompt text. Krea 2 and
MiniMax have no such node, so for them the box is folded into the front of the
prompt. The label under the box says which of the two is happening.

**The subject box knows the tag vocabulary.** `assets/danbooru-tags.csv` is
every danbooru tag — two hundred thousand of them, with how many pictures carry
each one and a Korean description carrying the words a Korean speaker would
search by. Type into a tag and the matches appear under it, most-used first:
`홍조` finds `blush`, `긴 머리` finds `long hair`, `nyte` finds `NyteTyde`. Tab
or Enter accepts, arrows move, Escape dismisses.

The file is 22MB, so it is parsed on the server and searched there — this app is
opened from a phone over the LAN as a matter of course, and 22MB per page load
to make a text box suggest words is not a trade anybody would take. The index is
built on the first request rather than at boot (about 200ms), and every search
after that is single-digit milliseconds. Completion is deliberately confined to
the subject box: the other three hold settings, and a dropdown over them would
be in the way of the thing being set.

**Pasting a booru link fills it in.** A post address from danbooru, safebooru,
gelbooru, yande.re or konachan pasted into the subject box is replaced by that
post's tags — the fastest way to describe a picture you have already found, and
the tags are already written, in the vocabulary the model was trained on.
Underscores become spaces and brackets are escaped, because a bare bracket is
prompt-weighting syntax and an unescaped character name silently reweights
everything inside it. Post metadata (`highres`, `commentary request`) is dropped:
it describes the *post*, and a model handed "commentary request" draws a caption.
The fetch happens on the server because no booru sends
`Access-Control-Allow-Origin`, so a browser fetch returns an opaque response and
the page gets nothing.

**The Studio keeps working while you are elsewhere.** It is laid over the
conversation rather than replacing it, and it now stays mounted once opened —
so switching to a chat while a picture is being made no longer takes the card,
its poller and its progress stream down with it. Running jobs are written to
storage alongside finished ones, so a reload picks them up where they were;
one that ComfyUI no longer recognises (it was restarted) says so instead of
showing "generating" for ever. Choosing a chat, from the list, the palette or a
new chat, leaves the Studio rather than leaving it on top of a conversation you
cannot see.

**And the settings follow you between devices.** The four prompt boxes, the
size, the sampler and the LoRA stack — per workflow — sync with the chats and
the personas, as does the gallery. Written on a phone, they are on the desktop;
the pictures themselves are not carried, because a gallery entry holds a
`/studio/view` URL that resolves through whichever machine is serving this app.

**The workflows come emptied of their author's own picture.** A `.json` exported from
somebody's ComfyUI carries whatever was in the boxes at the time — in these, a Safebooru
post's tags, a chain of artist handles, a block of quality words, and a style appended to
every prompt. All of it draws something, and none of it is visible from the Studio, so a
prompt asking for a lighthouse came back as a twin-tailed girl with tomato hair ornaments.
Replacing the positive prompt is not enough: a second path carries the author's text into
`AnimaArtistPack`, which patches the model itself through cross attention. The places that
text *originates* are listed per workflow in `server/workflows.js` and blanked before every
job, and unused LoRA slots are cleared rather than merely switched off. An empty prompt box
means an empty prompt.

Either way the result is stored on the message as bytes, not as a link. A `/studio/view`
URL points at a file on one machine's ComfyUI, which the phone opening the same
conversation cannot reach and which ComfyUI will tidy away regardless.

## Features

### Chat
- Streaming responses with tokens/sec and total-time metrics, committed **once per animation
  frame** rather than once per token, so fast models read smoothly instead of stuttering.
  Each newly streamed word fades in from a blur, and the growing edge carries a soft mask,
  so text arrives as a gradient rather than a jump. A blinking caret marks the paragraph
  still being written
- Reasoning shown in a **height-animated** "Thought process" section that opens itself while
  the model is thinking and collapses when it finishes — a click always overrides. Both shapes are handled:
  inline `<think>` tags, and the separate `message.thinking` field that Ollama >= 0.9
  uses for models like qwen3 and deepseek-r1
- **Thinking: Auto / On / Off** (Settings → Generation). Auto leaves the field out of the
  request so each model keeps its own default
- Markdown with GFM, KaTeX math, and syntax-highlighted code
- Edit any user message and re-run from that point
- Retry the last answer, or **regenerate it with a different model**
- **Branch a new chat from any message** — forks the history, leaves the original intact
- Copy, delete, star and read-aloud per message; delete is undoable from the toast.
  **Copying works over plain HTTP**, which is every address but the one the server is
  opened on. `navigator.clipboard` exists only in a secure context — HTTPS or localhost,
  nothing else — and `PUBLIC_ORIGIN` exists precisely so a phone can reach the app over
  neither. Calling `.writeText` on `undefined` threw, nothing caught it, and the line that
  shows the "copied" tick came after the throw, so the button did not even lie: it did
  nothing at all. There is one helper now (`src/clipboard.js`), it falls back to
  `document.execCommand` where the modern API is missing or refuses, and it reports whether
  the copy actually happened so the tick is only shown when it did
- Voice input via the Web Speech API
- **Find in chat** (`Ctrl+F`) highlights every hit in place with a match counter and
  prev/next stepping - nothing is hidden. Sidebar search still spans all chats
- **Star messages** and filter the transcript down to the starred ones
- **Quote a passage back** — the quote button on an answer drops it into the composer as
  a `>` block, ready for the follow-up question. Highlight part of the answer first and
  only that part is quoted, which is almost always what was meant; quoting eight hundred
  words because you wanted one sentence is not
- **Leave the chat while it is being answered.** The reply is written to the chat that
  asked for it, so switching away is safe and coming back shows however much has arrived.
  The chat being written to carries a spinner in the list; every other chat behaves as
  though nothing were happening, because as far as it is concerned nothing is, and its
  composer says where the reply is going with a way back to it.

  This was a one-line guard — `if (isGenerating) return` on the chat list — standing in for
  a fact the interface did not have. The reply already went to the right chat: `handleSend`
  captures the id when it starts and every write it makes goes there. Nothing on screen
  knew that, so the safe thing was to forbid the move. Holding the id in state is what
  replaced the ban with the distinction.
- **A finished answer says so when you are not looking.** If the tab is in the background
  when a reply lands, its title picks up a ✅ until the tab is looked at again. Deliberately
  not a notification: that needs a permission prompt, and prompting on first use for
  something nobody asked for is how a site teaches people to click Block

### Composer
- **Slash commands** — type `/` for a menu (`/imagine`, `/web`, `/summarize`, `/translate`,
  `/explain`, `/review`, `/fix`, plus anything in your prompt library)
- **Paste images straight from the clipboard**, or **drag & drop files** onto the composer
- Attach images (routed to a vision model), **PDFs, Word files and plain text**

  PDFs are *extracted*, not read as text, and that distinction was a real bug. Everything
  that was not an image used to go through `reader.readAsText(file)` — which for a PDF
  means decoding compressed binary as UTF-8. The model received a hundred thousand
  characters of `%PDF-1.4`, stream markers and replacement characters: an enormous token
  bill for an attachment containing no readable text at all, and a prompt so far from
  language that what came back had little to do with the question. A tuition invoice went
  in; nonsense came out.

  The extractor was already here, doing this correctly for the knowledge library — the
  composer simply never called it.

  **Korean, Japanese and Chinese PDFs need their character maps**, and not having them looks
  exactly like a document with no text in it. A CID-keyed font — how every CJK document
  embeds characters — stores glyph ids, and turning those back into Unicode needs the map
  for the font's collection. Without `cMapUrl`, pdf.js cannot fetch one: `getTextContent()`
  returns items whose `str` is empty, and the only honest conclusion left is "this PDF has
  no text". A Korean tuition invoice, full of text, reported exactly that. The file it
  wanted is called `Adobe-Korea1-UCS2.bcmap` and it was sitting unreferenced inside
  `pdfjs-dist` the whole time.

  There are 169 of them and pdf.js picks one by name at run time, so they cannot be
  bundled — `scripts/pdf-assets.mjs` copies them into `public/` before every dev start and
  every build. Measured on a PDF with Adobe-Korea1 fonts and no ToUnicode map: 41 Korean
  characters extracted with the maps in place, zero without.

  **A PDF that really has no text becomes pictures.** A scan, or a page exported as one
  flat image, holds words that are visible but not encoded. Refusing is true and useless
  when the model in front of you can see, so the pages are drawn at about 150dpi and
  attached as images — the first four, on a white background, through the same path as a
  photograph. A file nothing can read (a zip, a video, an executable)
  is now refused rather than decoded, because those produce exactly the same flood. A
  scanned PDF says so, since it is a picture of text and holds none. And anything past
  30,000 characters is trimmed with a note on the chip: an attachment is context for a
  question, not a corpus, and the knowledge library is what indexes the longer thing
- **An attachment opens after it has been sent, not only before.** The thumbnail in a
  sent message is 200x150 and cropped to fill, so a screenshot of a terminal is
  unreadable in the transcript — and the moment you most want to check what you sent is
  while reading the answer about it. Tapping the chip or the image opens the same viewer
  the composer uses. A file that was too long to send whole shows the passages the
  knowledge library holds for it
- **Live context meter** — estimated token usage against your `num_ctx` setting
- **The model is told the date, the time zone, and — if you fill it in — where you are.**
  Location is a line you type in Settings rather than something read from the browser:
  geolocation needs both a permission prompt and an HTTPS address, and this app is routinely
  opened over plain HTTP so a phone can reach it. With the file tools switched on it is also
  told the operating system and your home directory, so "find my invoice" starts from a real
  path instead of a guessed Unix one — and only then, because naming somebody's home
  directory in every prompt for no reason is not a neutral act
- Jump-to-latest button when you have scrolled up

**Scrolling while the answer is still arriving** is the reader's, not the app's. The
transcript follows the end of a reply only while you are actually reading the end of it;
one flick and it stops, however fast the model is talking, and it resumes when you come
back to the bottom or press jump-to-latest.

Getting that right took two changes that only work together. The first is that a scroll
this code performs is marked as its own before the browser reports it — otherwise every
automatic scroll to the bottom is read back a frame later as "the reader is at the bottom,
keep following", and scrolling up became impossible rather than merely difficult. The
second is that the release is driven by the gesture (`wheel`, `touchmove`) rather than by
the scroll position: a streaming reply rewrites the transcript several times a second, and
someone dragging the list up passes through every distance from the bottom on the way, so
while they are still inside whatever slack the position check allows, the next token puts
them back. They never get out. The slack is smaller now too — 40px rather than 100px, which
sounds like a detail and was most of the problem on a phone, where a flick starts slowly.

### Voice
- **Text to speech** through GPT-SoVITS, or the browser's built-in synthesiser
- **Reasoning, tool blocks, code and injected context are stripped before speaking** -
  only the prose the assistant actually wrote is read out
- Configurable reference clip, reference transcript, output/reference language, speed
  and a character cap so long answers do not take minutes to synthesise
- Optional **auto-play** of finished replies, a Test voice button, and a Stop control
- **Hands-free conversation** — hold the microphone button (or right-click it, or use the
  command palette) and it listens, sends what it heard, reads the answer out, and listens
  again. Every part of this already existed and none of it was joined up: dictation put
  words in the composer and stopped, auto-play read finished answers aloud, and between
  them sat the two manual steps — press send, press the microphone again — that are exactly
  the two you cannot do while cooking, driving, or holding a baby, which are the times
  anyone wants to talk to a computer instead of typing at it.

  A strip above the composer says which of four things it is doing, because a mode that
  spends ten seconds silently thinking is otherwise indistinguishable from one that has
  crashed. One piece of code decides when the microphone opens — "hands-free is on and
  nothing else is happening" — rather than a completion callback hung off each of the four
  ways a turn can end, which is four places to forget one. Refused microphone permission
  ends the mode rather than being retried, or that one piece of code would ask again every
  half second
- If GPT-SoVITS is not listening, the app asks the dev server to start it and says so

### Sessions
- **The model names the chat.** Once the first answer is complete it is asked, in the
  interface language, for a four-or-five-word title, and the first message's opening
  30 characters — used as a placeholder from the moment you press send — is replaced. A
  title you type yourself is locked and never overwritten. Grouped by Today / Yesterday /
  Previous 7 days / …

  This was written and did not run. `generateSessionTitle` called `promptLanguageName`,
  which lives in `i18n.jsx` and was never imported into `App.jsx`, so the first line threw
  a `ReferenceError` — inside a `try` whose `catch` logged a warning nobody was reading.
  The request never reached the model, and every chat kept its placeholder. See the note
  on `no-undef` under [Layout](#layout): this is one of two bugs of exactly that shape.
- **Pin** chats to the top, **rename** them (double-click the title), **duplicate** them
- Export a single chat as **Markdown**, all chats as Markdown, or everything as JSON
- Import a JSON export back (IDs are re-keyed, so nothing is overwritten)
- **Chat info panel** with message/token/speed statistics, a **per-chat system prompt
  override**, retitle, and an undoable "clear messages"
- **Archive** a chat instead of deleting it. The list is what gets unusable first — a year
  of one-off questions buries the handful of chats anyone returns to — and deleting is the
  wrong answer to that, because the reason those chats are kept is that they might be
  wanted. The archive is a view rather than a place: the button beside the search swaps
  which half of the list is showing, and a banner says so, since "my chats are gone" is
  otherwise a reasonable conclusion. The chat you are reading stays visible either way
- **A half-written question survives leaving the chat**, and so does where you were reading
  in it. Both are the same complaint — leaving a chat threw away the state that was not
  *in* the chat — and neither mattered much while switching chats mid-answer was forbidden.
  It is not any more.

  Drafts and scroll positions stay in this browser rather than on the account: a draft is
  not a message yet, syncing it would upload on every keystroke, and one arriving from
  another device would overwrite whatever was being typed here. A scroll position is about
  a window's height, which is not the same on the phone as on the laptop.

  The reading position is recorded as you scroll, not when you leave. By the time an effect
  can see that the chat changed, React has already rendered the new one, so the container
  is showing that chat and reading its offset files the new chat's position under the old
  chat's id. A chat read to the end reopens at the end, even though the answer has grown
  since — which is why what is stored is "at the bottom", not a pixel offset
- **Select several at once** — the button beside the sidebar search turns the list into a
  selection, and the bar that replaces the footer moves, exports or deletes all of them.
  Deleting is one undo for the lot, not one per chat. "Select all" means everything the
  list is currently *showing*, so it never reaches past a search into chats you cannot see

### Answers you can go back to
- Regenerating **keeps the previous answer** instead of replacing it. A `‹ 2/3 ›` pager
  under the message moves between them, and each one remembers its own speed, token
  counts and which model produced it — so regenerating with a different model gives you
  a side-by-side rather than a replacement
- A reply that stops because it hit `num_predict` is detected from Ollama's
  `done_reason` and offers to **carry on**, stitched back into the same message.
  Two ways of asking are used depending on what the model's chat template allows:
  a prefill continues the same token stream seamlessly (qwen3.8), and where the template
  closes the assistant turn and would restart the answer instead (gemma4), that is
  detected and the continuation is requested as an instruction. Optionally automatic,
  bounded to three rounds

### Folders
- Chats can be filed into folders, which sit above the date groups in the sidebar
- A folder can carry a **shared system prompt** placed in front of each chat's own —
  useful for "everything I ask about this project"
- Deleting a folder never deletes the chats in it; they go back to being unfiled
- Folders sync like everything else — and did not, for a long time. The whole list travels
  to the account as one record, and the sync decides whether a device has anything to say
  by comparing that record's timestamp with the one it last sent. `saveFolders` wrote the
  list and never moved the timestamp, so the answer was always "nothing has changed". The
  first save went up, because there was no previous timestamp to match, and none after it
  ever did. Deleting was the case that showed: a folder removed on the laptop stayed on the
  phone through every sync and every reload, because as far as the account was concerned
  the laptop had not touched its folders since the day it created them. Sampling presets
  were stored the same way and had the same bug
- **Drag a chat onto a folder** to file it, and onto a date heading to take it out again.
  The row menu still does the same thing for a touch screen, where a press-and-drag is a
  scroll. A drag carrying anything else — a file, a link, a selection — is refused, because
  the rows travel under a private MIME type that nothing else sets

### Share a conversation, read-only
- **A secret link anyone can open, with no account.** Chat panel → *Share this
  conversation*. The link is copied as it is made.
- **A copy is published, not a pointer.** Everything said afterwards stays private —
  including the message where you paste a key into the same thread out of habit.
  Sharing is an act with a boundary, and the boundary is the snapshot
- **Reasoning, tool output and attached file contents are stripped** before publishing.
  A `<think>` block often restates the prompt, and a tool result carries filesystem
  paths and whatever a read returned. "Share this answer" is not consent to publish a
  directory listing
- **The page a reader lands on is not the app.** No composer, no sidebar, no session:
  the route branches before the session provider mounts, so following a link neither
  requires an account nor creates one, and the read is made without credentials
- **Expiry (never / 1 / 7 / 30 days), a view count, and revoke.** Revoking deletes the
  stored copy rather than flagging it, and deleting your account takes every link with
  it — a foreign key, so it cannot be forgotten
- **The token is stored hashed**, the way session tokens are, so a copy of `webui.db`
  is not a stack of working links. The consequence is that the URL can only be shown
  on the device that made it; the server can list a link and end it, but never show it
  again
- An unknown, revoked and expired link all get the same answer, because telling them
  apart tells a stranger with a guessed token that the guess landed on something real
### Cross-chat memory
- Facts worth keeping (`profile` / `preference` / `project` / `fact`) are extracted with a
  JSON-Schema-constrained call and injected into the system prompt of later chats
- Word-overlap duplicate detection, so the same preference is not stored twenty times
- Off by default, per profile, editable and deletable, and never leaves the browser

### Saved system prompts
- **Keep several and switch between them** (Settings → General, under the system prompt
  box). One box is enough only while the app is used for one thing: the prompt that
  makes a model a terse code reviewer is the wrong prompt for translating a letter
- **Applying one writes it into the box**, where it stays editable. The library is a set
  of starting points, not a set of modes
- **Which one is in effect is worked out by comparing the text**, not by remembering
  which was clicked — so the panel stops claiming "Code reviewer" the moment you edit
  the prompt underneath it
- **Also in the command palette** (`Ctrl+K`), because switching prompt is something you
  do between questions rather than four clicks deep in Settings
- Saving under a name that already exists replaces it. The list travels to the account
  like folders and sampling presets do
- A chat with its own system prompt override is not affected, and says so rather than
  looking like the button did nothing
### Command palette — `Ctrl+K`
One search box over every action: switch model, jump to a chat, insert a saved prompt,
change theme, export, toggle Web Fetch, open settings.

### Models
- **Pull with a real progress bar** (streams Ollama's NDJSON progress)
- See what is **loaded in VRAM** right now, and unload it with one click
- Delete installed models, see size / parameter count / quantization

### Generation settings
`temperature`, `num_predict`, `top_p`, `top_k`, `repeat_penalty`, `num_ctx`, `seed`,
stop sequences and the thinking mode — all persisted, all sent with every request.

### Artifacts, preview and running code
Previewable, runnable or simply long code blocks open in a side panel with four tabs:

- **Preview** - a sandboxed iframe. HTML, CSS and JavaScript fences from the *same message*
  are stitched into one document. **JSX, TSX and TypeScript are transpiled in the browser
  by Babel**, and React is loaded automatically when the snippet needs it. SVG renders too.
  Device presets (Responsive / Desktop / Laptop / Tablet / Phone) with rotation and
  zoom-to-fit let you check a layout at a real viewport size.
- **Run** - Python executes via Pyodide, with `stdout`/`stderr`, a timer, and **whatever
  the code imports installed before it runs**.

  This used to be a hand-written list of twenty-two module names, and anything outside it
  was simply not installed — the code ran anyway and failed on the import. `import pygame`
  produced a `ModuleNotFoundError` beside a Run button that had said nothing about needing
  to install anything. Nothing is listed by hand now. Three sources answer the question in
  turn, each authoritative about its own part: Pyodide's own `loadPackagesFromImports`
  loads anything in its catalogue of pre-built packages; Python then says what is *still*
  missing, via `importlib.util.find_spec` against `sys.stdlib_module_names`, so there is no
  list of standard-library names here to fall behind and no guessing about what step one
  already did; and `micropip` installs the rest from PyPI, which covers every pure-Python
  package there is.

  The imports are read with Python's own parser rather than a regular expression. `import`
  inside a comment, a string or a docstring is not an import, and a regex over source
  cannot tell the difference — which matters, because models write all three constantly.

  What is left after all that is genuinely unavailable, and the runner says so **before**
  running, by name, instead of letting it surface as a traceback. A package with compiled C
  in it cannot be installed at runtime by anything: it has to be built for WebAssembly
  ahead of time, which is what Pyodide's catalogue is. Saying "no matching wheel" to
  somebody whose game will not start is true and no help at all, so that case gets its own
  sentence.

  **Graphics get a canvas.** `pygame` is in Pyodide's catalogue — as `pygame-ce`, which
  installs as `pygame`, so code written against pygame needs no changes — but SDL draws
  onto a canvas the page has to supply, and without one `pygame.display.set_mode()` does
  not raise. It *hangs*, reaching into an undefined 2D context and never returning, taking
  the tab with it. So the canvas is created from the source before the code runs, rather
  than in response to drawing that can no longer happen, and it only appears when something
  is going to draw on it. Its width and height belong to the program: `set_mode((320, 240))`
  rewrites them, and the stylesheet only ever scales the result down to fit.

  **A game loop is rewritten so it runs instead of hanging.** Python runs on the one thread
  the page is drawn with, so `while True:` never hands it back, and no Stop button can help
  — processing that click is precisely what the loop prevents. Refusing to run it is honest
  and useless: the code is fine, the environment is different, and telling somebody to edit
  code they did not write is not a fix.

  So the fix is applied rather than described. Every blocking loop gets two statements at
  the end of each pass — `await asyncio.sleep(0)` to hand the browser a turn, and a check
  of whether Stop has been pressed — using Python's own parser, because indentation is
  significant, loops nest, and "append a line to the end of the loop body" is not something
  a regex can locate. Your code is untouched; only what was run is. A loop that already
  awaits is left alone, and so is one inside a `def`, where `await` would force the
  function to become `async def` and change every caller.

  Detection covers the shape models actually write, which is not `while True:` — it is
  `running = True; while running:` with `pygame.event.get()` inside. `running` never
  becomes false in a browser, because the QUIT event comes from closing a window and there
  is no window to close. So any `while` loop driving a frame clock or an event pump counts;
  a `while queue:` that empties a list does not.

  Measured with a real pygame game: the page answered in **9ms while the game was
  running**, and Stop ended it.

  **If a loop cannot be rewritten, it is still not run.** Python runs on the one thread the page is
  drawn with, so `while True:` never gives it back — and no Stop button can help, because
  processing that click is precisely what the loop is preventing. The only way out is
  reloading the page, which takes the artifact panel, the scroll position and any unsent
  draft with it.

  A warning printed beside the run is no use here: by the time it is on screen the tab is
  already gone, because the thing being warned about is the thread that would have drawn
  it. So the run does not start. The warning takes the place of the output, with the fix
  in it — `async def main()`, `await asyncio.sleep(0)` at the end of each pass,
  `asyncio.ensure_future(main())` — and a "run it anyway" button for people who meant it.
  A loop that already awaits is left alone, since that is the fix being suggested.
- **Code** - syntax highlighted with line numbers. **Editable**: change the code and the
  preview re-runs against your edit, with a one-click revert back to the model's version.
  Edits stay local to the panel and never rewrite the conversation.
- **Console** - `console.*`, uncaught errors and rejected promises from the preview are
  forwarded to the panel, with an error count on the tab.

Plus reload, copy, download (source or assembled page), open-in-new-tab, a **maximize**
toggle, and a **console docked under the preview** so output and rendering are visible at
once. Short Python blocks still get an inline Run button in the transcript.

Fence parsing handles ` ``` ` and `~~~`, four-or-more markers, unlabelled blocks and info
strings like ` ```js title="demo" `. Code written inside a `<think>` block is never turned
into an artifact.

**A fence is recognised by being a `<pre>`, not by asking.** The renderer used to be mapped
onto `code` and read its own `inline` prop to tell a block from a word inside a sentence.
react-markdown stopped passing `inline` in v9 — the string does not appear anywhere in
v10's source — so it was `undefined` on every call, `if (!inline)` was true on every call,
and every scrap of inline code rendered as a full bordered block with a language header and
a copy button. "Use the `` `useState` `` hook, then call `` `npm run build` ``" came out as
five pieces: two words, a card, three words, another card, three words. It also nested a
`<div>` and a `<pre>` inside a `<p>`, which is invalid HTML that browsers silently
restructure. A fence is the only thing that parses to a `<pre>`, so the renderer is mapped
there and inline code never reaches it — and there is no longer a question to get wrong.

### Agent tools (MCP toggle)
When enabled, the model can emit `<TOOL_READ_FILE>`, `<TOOL_WRITE_FILE>`, `<TOOL_LIST_DIR>`,
`<TOOL_SEARCH_FILES>` and `<TOOL_WEB_SEARCH>` tags; the dev-server middleware executes them
and feeds the result back. URLs in your prompt are fetched and injected as context.

> The `/localfs` middleware reads and writes anywhere your user account can reach, and only
> exists while the Vite dev server is running. Keep it off untrusted networks.

### Sampling presets
- **Precise / Balanced / Creative / Repeatable** as starting points, plus any number of
  named snapshots of the whole generation panel
- Whichever preset matches the current numbers is highlighted, so moving one slider
  visibly takes you off it
- Values are clamped on save *and* on load, so nothing Ollama rejects can reach it

### Languages
The interface ships in **12 languages** — English, 한국어, 日本語, 简体中文, 繁體中文,
Español, Français, Deutsch, Português, Русский, Tiếng Việt and العربية. The language is
detected from the browser on first run and can be changed in Settings → General.
Arabic switches the whole layout to **right-to-left**. Every settings tab, dialog, menu and
error message is translated; only proper nouns (highlight.js theme names, `GPT-SoVITS`) and
example placeholders stay as they are.

Adding one more is a single entry in `LANGUAGES` plus one object in `src/i18n.jsx`; the
test suite fails if any language is missing a key or drops an interpolation placeholder.

### Accounts

**One account, on the server.** The browser holds an opaque session cookie and nothing
else: no user table, no password hashing, no local notion of who is signed in. Whenever the
app needs to know who you are it asks `GET /api/auth/session` and believes the answer.

That is a change of design, not just of code. There used to be two account systems — one in
the browser's IndexedDB, one on the server — and every screen had to decide which was
authoritative. The answer changed halfway through each page load: the local one was
available instantly, the server's took a round trip. Storage keys were derived from it, so
a few hundred milliseconds of the wrong answer was enough to write a chat into another
account's bucket, and the state sync then uploaded it. That is where the reports of mixed-up
data came from, and it is not fixable while two sources of identity exist.

**Four ways in, plus guest.**

**Passkey.** Windows Hello, Touch ID, a fingerprint or a security key. The ceremony belongs
to the relying party and the relying party is the server: it mints the challenge, stores the
public key against an account, and verifies the signature — checking the origin, the RP id,
the user-presence flag and the signature counter alongside it. (Doing this in the page, as
this app used to, verifies nothing: a page that generates its own challenge and approves its
own answer is a lock with the key printed on the door.) Sign-in names no account and needs
no username — a discoverable credential carries the account with it — and where the browser
supports it, the passkey is offered from the email field itself.

**Email and password.** **PBKDF2-SHA512** on the server (210k iterations, per-account salt),
compared in constant time. A hash is derived even for unknown accounts, so a missing account
and a wrong password take the same time. Repeated failures are throttled per address and
account.

**Google.** Google Identity Services renders its own button; the ID token is posted to
`/api/auth/google`, where the **server** verifies it against Google and checks that it was
issued for this application. The browser never decides what a token means. Needs an OAuth
**client ID** with this origin listed under *Authorised JavaScript origins*. No redirect URI
and no client secret.

**Kakao.** Authorization code grant, as a full redirect rather than a popup. `/kakao/start`
issues the `state` — a value the page invents and the page checks proves nothing — and
`/kakao/callback` exchanges the code and sets the session. Kakao's token endpoint rejects
the JS key and sends no CORS headers, so it cannot be called from the page at all. In the
Kakao console, in this order:

1. 플랫폼 → Web → 사이트 도메인 `http://localhost:5173` (Redirect URIs are rejected until
   the domain exists)
2. 카카오 로그인 → 활성화 ON
3. 카카오 로그인 → Redirect URI → `http://localhost:5173/kakao/callback`
   — the **full path**, not just the origin. A bare origin is the usual cause of `KOE006`.
4. 앱 키 → **REST API 키** → `VITE_KAKAO_REST_KEY`
5. Client Secret is ON by default on new keys. Either switch it off, or put the code in
   `KAKAO_CLIENT_SECRET` (no `VITE_` prefix, so it stays server-side). Leaving it on
   without the value gives `KOE010 Bad client credentials`.

The dev server pins `port: 5173` with `strictPort`, because a second `npm run dev` silently
moving to 5174 changes the origin and breaks every registered redirect URI.

> **Why do Google and Kakao need setup when other sites "just work"?** They don't skip it:
> the site's developer registered the app once and shipped the client ID, so visitors only
> see the result. Here you are the developer, so the one-time step is visible. Copy
> `.env.example` to `.env`, fill in `VITE_GOOGLE_CLIENT_ID` / `VITE_KAKAO_REST_KEY`, and the
> buttons work for everyone from then on. **Passkeys need none of this.**

#### Sessions

Ordinary session handling, and each piece is load-bearing:

- The cookie value is never what is stored. Only its **SHA-256** lands in `sessions.json`, so
  a leaked file cannot be replayed as a login.
- **HttpOnly**, `SameSite=Lax`, and `Secure` only when the request arrived over TLS —
  hardcoding `Secure` means a LAN install over plain HTTP loses the cookie and loops
  forever with no error anywhere.
- The session id is **replaced at every sign-in**, so a cookie planted before you sign in is
  worthless afterwards. Signing in from a tab that was the guest *adds* a session instead,
  which is what lets two accounts be open at once; the browser holds at most sixteen, and
  the oldest goes rather than the cookie growing without bound.
- Opening a tab **forks** a session rather than creating one: nobody proved anything, so the
  fork inherits the source's clocks and cannot extend how long that sign-in lasts. It is a
  `GET` that writes a row, so it is fenced behind a header only this origin's own script can
  set — a navigation, a crawler and a cross-site request all fork nothing.
- The CSRF token is **per session**, so one tab's cannot act for the account in another's
  even though the browser sends every session on every request.
- Two clocks: **idle** (7 days, slides while you use it) and **absolute** (30 days, does
  not).
- **Signing out while a reply is arriving** asks first, and keeps what has arrived. The
  reply cannot outlive the sign-out and that is a decision, not a limitation: signing out
  changes which account's storage the whole app is pointed at, and a generation running
  across that boundary would be writing an answer into an account nobody is signed into any
  more. What was actually being lost is the answer *so far* — the transcript is written on
  a debounce, so the last second or two of a stream had not been stored when the final
  upload went out. The stream is closed, the partial answer is written immediately, and
  only then does the sign-out proceed, so signing back in finds the reply where it stopped
  and "carry on" continues it.
- Every session carries a **CSRF token**, delivered in a script-readable cookie and required
  as `X-CSRF-Token` on everything that changes state. A cross-site form post arrives with
  your cookie attached — that is what cookies do — but cannot read the token.
- Sessions are enumerable and revocable: Settings → Account lists where you are signed in,
  and **changing your password ends every other session**, which is usually the reason for
  changing it. "Other" means other sessions of *that account* — a tab signed into a
  different account is not yours to end, and is left alone. Your own other tabs on that
  account are sessions too, so they do end; that is what the button says it does.

#### Where the data lives

Accounts, sessions, passkeys and everything the account holds live in **SQLite**
(`server/data/webui.db`), through Node's built-in `node:sqlite` — no dependency,
no install step, no native rebuild.

It used to be JSON files. `users.json` was read whole on every authenticated
request and rewritten whole on every change, with nothing holding the read and
the write together: two requests arriving close enough each read the same array,
each appended to their own copy, and the second write dropped the first. That is
what read-modify-write on a shared file does, and losing an account to it is not
hypothetical. A unique index and a transaction do not have that failure mode —
there is a test that fires eight simultaneous registrations at one address and
asserts that exactly one wins.

Chats and settings are also cached in the browser under the account's scope
(`ollama-sessions:srv-<id>`, `systemPrompt@srv-<id>`), so the app works offline
and starts instantly. The account's copy on the server is what makes them follow
you to a phone.

#### Sync

**Per record, not per blob.** The old sync sent the account's whole state as one
object and stored it by overwriting. With one device that is fine. With two — the
entire point of having an account — it loses data three ways:

* The laptop uploads. Its copy does not contain the chat the phone wrote a minute
  ago, so the account no longer has that chat.
* The phone deletes a chat. The laptop's next upload, made from a copy that still
  has it, puts it back. A blob cannot say *this one is gone*; it can only fail to
  mention it, which is indistinguishable from not knowing.
* Every change ships the whole history. On a phone that is not a sync, it is a
  download.

Now each chat, setting, document and memory is its own record with its own
timestamp:

* **Conflicts resolve per record, by time.** Two devices editing different chats
  never touch each other. Two devices editing the *same* chat keep the later
  edit — not whichever device happened to reconnect second.
* **Deletions are tombstones.** A deletion is a real write that travels like any
  other, so it reaches the other devices instead of being undone by them.
* **The timestamp is the mechanism, not decoration.** A device uploads a chat
  only when its stamp differs from the one it last sent, and the server keeps a
  record only when its stamp beats the one it holds — so a chat edited without
  moving `updatedAt` is edited in this browser and nowhere else, permanently.
  Every edit therefore goes through one function that stamps it
  (`reviseSession`, on top of `src/sessionEdit.js`) rather than twenty call
  sites each remembering to. They did not: sending a message stamped the chat
  and nothing after it did, so the account kept the *empty* assistant
  placeholder and every other device sat on "Thinking..." — through a reload,
  because that really was what the account held.
* **Devices pull by revision.** Each account has a counter that advances on every
  write; a device asks for *everything above N*. Coming back after a week
  downloads exactly what changed. A device already in step downloads nothing,
  which is what makes polling cheap enough to do from a phone.
* **Large accounts arrive in pages**, so a first sync is a series of small
  requests rather than one that times out.
* **Batching has a ceiling.** Two timers stand between a change and the
  account: one before the chat list is written to browser storage, one before
  it is uploaded. Both were plain debounces, and a plain debounce never fires
  at all if changes arrive faster than its delay — which is precisely what a
  streaming reply is. So for the whole of an answer nothing was saved and
  nothing was sent. Locally that was invisible, because the screen is drawn
  from React state; everywhere else it was the bug, because the upload reads
  storage. `src/coalesce.js` gives both timers a ceiling, and the upload is now
  scheduled *by the storage write* rather than by a separate timer racing it.
* **A device is told, rather than left to ask.** Every device holds an event
  stream open (`/api/auth/events`); an upload that actually changed something
  rings it, and the others fetch what they are missing. The fifteen-second poll
  it replaces is still there underneath, at half the rate, for a browser or a
  proxy that will not carry a stream — but on its own it was not enough on a
  phone, because a browser suspends the timers of a page that is not in front.
  What travels on the stream is a revision number, never a record: it is a
  doorbell, and the door is the ordinary sync.

Two windows of the same browser on one computer looked instant long before any
of this, and that is worth knowing when judging whether sync works: they share
one local database and read each other's writes directly, without the account
being involved at all. A phone is the honest test.

#### One address, not several

This server answers on every address that reaches it — `localhost`, its LAN
address, a `nip.io` hostname, a public one — and a browser treats each of them
as a **separate website**. Chats, settings and the sign-in cookie are all keyed
to the origin, so opening the desktop on `http://localhost:5173` while the phone
uses `http://1.2.3.4.nip.io:5173` is one person signed in twice, with two local
caches that only the account sync ever brings together. Nothing is lost when it
happens; it is filed under an address you are not looking at.

The database is not what splits. `server/data/webui.db` is one file, opened by
one process, identical for every address. It is the browser's copy that divides,
and no server code can undo that — it is the rule that stops one website reading
another's data.

So: put the address you want in `PUBLIC_ORIGIN` in `.env`.

```
PUBLIC_ORIGIN=http://192.168.1.20.nip.io:5173
```

The launcher then opens *that* instead of `localhost`, the startup banner leads
with it, and the app says so — with a link — whenever it is loaded from anywhere
else. Every other address still works; a server that refuses the address you can
actually reach is worse than one that costs you a second login. Pick one that
works from every device: a LAN address is fine on your own wifi, and a public
one is what you need if you reach this over mobile data. Register whichever you
choose with Google and Kakao too, since they allow-list by exact origin.

Every batch is **stamped with the account it belongs to**, and a mismatch is
refused at both ends: the server rejects an upload whose stamp is not the
session's, and the client discards a response whose stamp is not the account on
screen. Nothing merges across identities, because no code path does.

Signed out, you are the guest: everything stays under the original unscoped keys,
which is also why an install that predates any of this opens exactly where it
left off.

**Read from where you wrote.** Seventeen settings — every sampling parameter and
the whole voice panel — were written through `setSetting`, which puts them under
the account's key (`topP@srv-abc`), and read back with a bare
`localStorage.getItem('topP')`. The scoped value was written, stamped, uploaded
and downloaded onto the other device, and then read by nothing at all: every
device started from the built-in default on every load. The symptom was "my
phone and my laptop disagree about every generation setting", which reads as a
sync problem and is not one — sync was carrying the values correctly the entire
time, to a store nothing consulted.

`scripts/settingscope.test.mjs` covers both halves: the store's round trip under
an account, and a scan of `App.jsx` for settings read straight out of
localStorage. The second is the one that would have caught it.

**And write where the sync can see it.** The folder and preset lists each travel
as a single record whose timestamp is what the sync compares, and both were
written without moving it — so both were edited on one device and nowhere else,
permanently. It is the same failure the chat clock exists to prevent, one level
down: a write that does not move a stamp is a write the account never hears
about. `scripts/syncengine.test.mjs` now creates, deletes and renames a folder
through the real save path and asserts the timestamp moves each time.

**Each tab is its own identity.** A cookie belongs to an origin, not to a tab,
so a cookie holding one session made every tab one person: signing out of one
signed out the rest, and two accounts could not be open side by side at all. The
cookie holds a **set** of sessions now, and each tab holds the *id* of the one it
is using — in `sessionStorage`, the only per-tab store there is — and sends it as
`X-Session-Id`. Sign out in one tab and only that session ends; the others carry
on.

**A tab is a session.** A newly opened tab has no id to send, so it sends `new`
and the server **forks** it one: same account, same clocks — it is the same
sign-in seen through another window — but its own token and its own CSRF token.
That fork is the fix, not the set. Two tabs opened on the same account used to be
handed the same session, and a tab cannot sign itself out of a session another
tab is using, so signing out of one still took the other with it. Switching
accounts forks for the same reason: adopting the session the other tab is holding
would put the two straight back to sharing one.

Sixteen sessions per browser, oldest evicted — which is a cap on open tabs as
much as on accounts, and the eviction is what keeps the table from filling up
with sessions belonging to windows that were closed weeks ago.

The id is a prefix of the session's stored hash, not the cookie: it names a
session without being able to present one. It travels in a header rather than in
the cookie because a header is something only this origin's script can set — a
cross-site request cannot choose which of your accounts it acts as.

What a tab must never do is decide *who* it is. The version of this that came
before kept a whole profile per tab, and because storage keys were derived from
it a tab could be signed out on the server while still writing to and uploading
an account's chats. A tab stores an id and nothing else; the server says who that
is, or that it is nobody.

Signing in or out anywhere still reaches the other tabs over a
`BroadcastChannel`, but they no longer obey it — they re-read, keep whoever they
are, and update the list of accounts they can switch to. **Add an account** is in
the profile menu and in Settings → Account; the accounts already signed in are
listed there and on the sign-in screen, and switching between them costs no
sign-in because nothing ended.

**Old data is offered, never taken.** Chats left behind by the browser-local
accounts are found, labelled and offered once per account, and copied only if you
say so. Automatically folding whatever is lying around into the first account
that signs in is the same failure this rework is about, arriving through the
front door. Nothing is deleted; the originals stay where they are.

> **Upgrading.** The JSON store is imported into SQLite automatically on first
> start — accounts, chats, settings and passkeys — and the old files are
> *renamed* (`users.json.imported`, `state.imported`), never deleted, so a
> mistake is recoverable by hand. Session records changed format, so everyone
> signs in once more. Password hashes and passkey keys left in IndexedDB by the
> old browser-local login are stripped on first load: nothing can authenticate
> against them any more, so they were only material to be scraped.

> **`WEBUI_DATA_DIR`** overrides where the database lives. The tests set it to a
> scratch directory, which is why running them can no longer touch real accounts
> — an earlier version moved the real directory aside and put it back, and that
> failed whenever the server was running.

**Profile settings** — display name, email, and a **profile picture** (cropped to a square
and downscaled to 160px before storing). Accounts with a password can change it — proving
the old one first — and any account can add or remove passkeys. Profiles without a picture
get a colour derived from their id, so they stay recognisable.

### Layout and appearance
- **Resizable panels** - drag the edge of the sidebar or the artifact panel. Double-click
  an edge to reset just that one, arrow keys nudge it when focused, and the sizes are
  remembered. Dragging keeps working over the preview iframe.
- The artifact panel **maximizes** to fill the window, and becomes a full-screen overlay
  below 860px instead of squeezing the chat.
- **The header adapts to the column it is in, not to the window.** Those are different
  numbers whenever the artifact panel is open: a 1500px window with the panel takes the
  conversation column down to 540px, and a `@media (max-width: …)` rule still sees 1500 and
  sheds nothing. The header then needed 802px in 540 — four system meters, a full model
  name, a search field and six buttons — and its contents overlapped. That is what the
  "broken" system monitor was.

  It is a container query now (`container-type: inline-size` on the column), so a narrow
  window and a wide window with the panel open are treated as the same problem, which is
  what they are. The model's name also ellipsises at every width rather than only on a
  phone: how much room the meters can have depends on the length of a string Ollama
  supplies, so the name is the part that always gives way and no breakpoint has to
  guarantee the row fits. Swept across thirteen widths with the panel open and closed,
  nothing overflows.
- **Chat outline** - jump to any of your turns in a long conversation from one popover.
- Light / Dark / System theme (stored, and it overrides your OS preference).
- **Text size** (small / medium / large), **density** (comfortable / compact) and
  **reading width** (narrow / medium / wide). The conversation and the composer read one
  variable, so they are always the same width as each other; 768px was hardcoded, which is
  a comfortable measure for prose on a laptop and two thirds of a large monitor left empty.
- **Reading progress** — a hairline under the header showing how far through a long answer
  you are, with a back-to-top button beside the existing jump-to-latest. The browser's own
  scrollbar is a few pixels wide on a laptop and is not drawn at all on a phone until you
  are already moving, which is when you have stopped needing it.
- A **word-wrap toggle on every code block**, not only in the artifact panel — a one-line
  shell command is otherwise a third of a line and a horizontal scroll.
- **Animations** - System / Full / Reduced. Everything that opens also *closes* with
  motion: modals, the command palette, popovers, menus and the slash list stay mounted for
  the length of their exit animation instead of vanishing.
- Every duration flows through a handful of CSS custom properties, so Reduced (and your OS
  `prefers-reduced-motion` setting) switches the whole app off in one place. The streaming caret keeps blinking either way,
  because that one carries meaning.
- Seven highlight.js themes for code blocks, plus a word-wrap toggle in the code view.

### On a phone

Below 860px the layout is a different one rather than a squeezed version of the desktop.

- **The header holds the model picker.** It is the only control up there that *says*
  something rather than doing something, so it gets the row. What used to happen is that
  the search field was told to take the full width of the group it sits in, the group is
  sized by its contents, and the picker was left with no width at all — invisible, with the
  buttons after it hanging past the edge. The field now comes out of the row and is reached
  from a button, opening on a line of its own.
- Everything else in the header — starred-only, the outline, the system monitor, chat info,
  compare, export, the theme cycle — is in the command palette too, so a phone loses the
  buttons and not the features.
- The sidebar is a **drawer** over the conversation with a backdrop, rather than a column
  taking half the screen. Panels and dialogs are full-screen.
- **The settings tabs scroll sideways** rather than wrapping into a wall, with the edge
  that has more behind it faded so it is visibly a strip and not a row that ends. Whichever
  tab is open is scrolled into view — which matters because the command palette opens
  Knowledge, Voice or Account directly, and the strip would otherwise still be showing the
  first five.

  This was broken outright for a while and it is worth recording why, because the cause is
  a CSS rule that reads as unrelated. `.settings-modal` is a flex column with a fixed
  height on a phone, so its children shrink when the content is taller than the screen —
  and a flex item whose `overflow` is anything but `visible` loses the automatic minimum
  size that would otherwise stop it at its content. The declaration that made the strip
  scroll, `overflow-x: auto`, is therefore also what made it free to shrink to nothing, and
  it did: one pixel of border-bottom, every tab clipped away, and only the panel that
  happened to be open reachable at all. Nothing looked broken — there was simply no tab bar,
  and no reason to think there should be one. `flex: 0 0 auto` is the fix, and it says the
  actual intent rather than asserting a height that has to be kept in step with the tabs.
- Touch targets are **40px**, not the 34px a cursor can live with. Hover-to-reveal actions
  are simply shown, because a touch screen has no hover.
- Toasts move off the bottom-right corner, where the composer is — an Undo you cannot tap
  because the send button is on top of it is not an Undo.
- `viewport-fit=cover` is set, which is what makes `env(safe-area-inset-*)` a real number.
  Without it every inset computes to zero and the padding spent on notches and the home
  indicator does nothing at all.
- **Deleting a chat is written and uploaded immediately** rather than through the two
  debounces the ordinary path uses — 700ms to storage, four seconds to the account. Those
  are right for a reply that changes on every token and wrong for a deletion: reload inside
  that window and the account still has the chat and sends it straight back. On a phone that
  is the ordinary case, refreshing being how you return to the app. The cost is that Undo
  has a tombstone to beat, so a restored chat is stamped with when it was restored.
- Pending writes are flushed on `pagehide` and on `visibilitychange`, not only on
  `beforeunload` — which iOS Safari fires rarely, and which never arrives at all when the
  page is frozen for an app switch and discarded later.
- **Swipe in from the edge to open the chat list**, and swipe it back to close. This is the
  one interaction a phone user expects to exist, and the drawer could previously only be
  reached from a button in the corner of the header — the hardest place on a phone to hit
  one-handed, and precisely why every messaging app on both platforms puts the same drawer
  behind an edge swipe.

  Almost every *other* horizontal drag on the screen is something else, so three rules keep
  them apart, and `src/gestures.js` is a pure function of six numbers so they can be tested
  without a touch screen. Opening counts only from within a thumb's width of the edge — a
  drag from the middle is a scroll, a table being pushed sideways, or the platform's back
  gesture. Horizontal travel must beat vertical by half again, because a thumb scrolling a
  long answer draws an arc whose sideways component easily clears a distance threshold on
  its own. And a gesture that begins on something which scrolls sideways — a code block,
  the settings tab strip, a slider — belongs to that thing. In Arabic the whole thing is
  mirrored: the drawer is on the right, so "in from the edge" is a leftward swipe.
- **A short buzz** when a chat is deleted, the drawer moves, or a selection changes — the
  actions whose only confirmation is under the finger that caused them. Off with one
  switch, and the switch is only offered where there is a motor to buzz: `navigator.vibrate`
  is not that test on its own, because desktop Chrome defines it and does nothing with it.

### Installing it as an app

There is a **web app manifest and a service worker**, so the browser will offer to install
this — a home-screen icon on a phone, an entry in the launcher on a desktop, and its own
window with no address bar. Settings → General → Install has the button where the browser
offers one, and says where to find the browser's own menu item where it does not (Firefox
and Safari never fire the event Chromium does). The launcher's "New chat" shortcut opens
`/?new=1`, which the app reads once and then clears out of the address bar, so refreshing
does not quietly create another chat.

**What the worker caches, and what it must never touch.** A worker sits in front of every
request the page makes, so the interesting question is not whether it caches well but
whether it caches the wrong thing. A cached model reply, session lookup, directory listing
or search result is not stale data — it is a wrong answer served confidently, from a layer
the page cannot see, that survives a reload. So `/api`, `/mcp`, `/localfs`, `/system`,
`/tts-api` and `/kakao` are passed straight through as though the worker were not
installed, along with every request that is not a same-origin `GET`. What is left is the
shell: the HTML network-first, so a rebuild is picked up on the next load rather than
whenever the worker feels like it, and the hashed build assets cache-first, because a file
whose name contains a digest of its contents can never be the wrong version.

Offline, then, means the app opens and says it cannot reach Ollama — which is a very
different thing to be looking at than a blank page, and far more often about a bad network
than no network.

**Updates are offered, not applied.** A worker that takes over mid-session leaves the next
lazily-loaded chunk coming from a different build than the code that asked for it, and the
failure looks like a random crash. So a new build waits, a toast says so, and the reload
happens after the new worker has actually taken over rather than immediately — otherwise
the reload is served by the old one.

`index.html` carries Apple's older keys as well, because iOS reads none of the manifest for
this: without them an app added to the home screen opens with the browser chrome still on
it. And `server/index.js` serves `/sw.js` and the manifest `no-cache` — everything else in
`dist/` carries a content hash and is immutable for a year, and a service worker frozen for
a year is a build that never reaches the browser again.

## Reaching it from a phone, over HTTPS

Worth doing, because a plain-HTTP address costs more than a padlock icon. The browser
calls it an insecure context and switches things off, and it does not say why — so each
one looks like a separate fault:

| | HTTPS or localhost | plain HTTP |
| --- | --- | --- |
| Passkeys (`PublicKeyCredential`) | yes | **absent** — the sign-in button never appears |
| Installing as an app (service worker) | registers | **cannot register** — nothing to install |
| Microphone (`getUserMedia`) | yes | **absent** — voice input and hands-free cannot start |
| Clipboard API | yes | absent — copying falls back to `execCommand` |

Measured, not assumed: the same build served over both, with a headless browser reporting
what it could see. Settings → General says the same thing on the affected address, since
"the passkey button is missing" is otherwise an unsolvable mystery.

**What plain HTTP does *not* cost you** is worth saying, because the list above looks
alarming and most of what people want is unaffected. Anything that goes through this app's
own server is untouched by any of it — a secure context is a rule about what a *page* may
do, not about what a server may do:

* **Reading and writing files** works over plain HTTP. It is `/localfs`, not the browser's
  File System Access API, and it is gated by `ALLOW_LOCAL_FS=true` in `.env` rather than by
  the scheme. Verified over a LAN address: a directory listing came back normally.
* **System information** works over plain HTTP — CPU, GPU, memory, platform, hostname and
  home directory, all from `/system/stats`.
* **Location** is the only one of the three that a browser really does withhold, and even
  then the time zone stands in for it: an IANA zone is named after a city, needs no
  permission and no network request, and works on any origin. With nothing typed in
  Settings the model is told "the time zone is `Asia/Seoul`, so somewhere around Seoul —
  treat that as a rough guess and say which place you assumed."

So the honest split is: **the three things in the table are genuinely gone without HTTPS**,
because each needs the browser to hold a secret or open a device — a passkey's private key,
a service worker's lifetime, a microphone. Everything else has a route through the server,
and this app already takes it.

The server already speaks TLS both ways, so the choice is only about where the certificate
comes from:

* **Directly.** Set `TLS_KEY_FILE` and `TLS_CERT_FILE` in `.env` and it serves HTTPS —
  the startup banner changes to `https://` and the session cookie gains its `Secure` flag.
* **Behind something that terminates TLS.** `X-Forwarded-Proto: https` is honoured, so
  cookies are marked correctly even though the last hop is plain HTTP on localhost.

### Tailscale — the short route

Free, no port forwarding, and nothing exposed to the internet. Install it on the machine
and on the phone; they join a private network and can reach each other from anywhere.

```bash
tailscale cert my-machine.tailnet-name.ts.net     # a real certificate, renewed for you
```

Then in `.env`:

```
TLS_KEY_FILE=/path/to/my-machine.tailnet-name.ts.net.key
TLS_CERT_FILE=/path/to/my-machine.tailnet-name.ts.net.crt
PUBLIC_ORIGIN=https://my-machine.tailnet-name.ts.net:5173
```

The certificate is issued by Let's Encrypt for a name Tailscale controls, so phones trust
it with nothing to install. `tailscale serve` will do the TLS instead if you prefer to
leave the app on HTTP — the `X-Forwarded-Proto` path above is for exactly that.

### Cloudflare Tunnel — when the phone cannot install anything

Free, works from any network, and needs no app on the phone. It gives the machine a public
hostname with automatic HTTPS and no open ports. The trade is that the traffic passes
through Cloudflare, and the address is reachable by anyone who learns it — so set
`ACCESS_TOKEN` before starting, and note that the app refuses to listen on a non-loopback
address without one anyway.

### A certificate you make yourself

Free and entirely local, but every phone has to be told to trust it — an iOS profile plus
a switch in Settings → General → About → Certificate Trust Settings, and the equivalent on
Android. Fine for one device, tedious for a household.

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365   -keyout key.pem -out cert.pem   -addext "subjectAltName=IP:192.168.1.20,DNS:localhost"
```

The `subjectAltName` matters: a certificate without one for the address you actually type
is rejected outright by every current browser, common name or not.

### DuckDNS and Let's Encrypt

`DUCKDNS_DOMAIN` and `DUCKDNS_TOKEN` in `.env` keep a free subdomain pointed at a home IP
that changes. With port 80 forwarded, `certbot` can then issue a real certificate for it.
This is the only option here that puts the machine on the public internet, which is a
larger decision than the certificate it is made for.

### Whichever you choose

Set `PUBLIC_ORIGIN` to the `https://` address. Google and Kakao allow-list by exact
origin, so both consoles need it added, and the app will say so if it is opened somewhere
else — a browser keeps separate storage per origin, so `http://192.168.1.20:5173` and
`https://my-machine.ts.net:5173` are two different installations to it. **Sign in on both
and the account brings the chats across.**

## What is not in this repository

- **Model weights.** Ollama manages its own; GPT-SoVITS keeps its where you installed it
- **The GPT-SoVITS install.** Tens of gigabytes of weights and a bundled Python runtime.
  The repository holds the launcher and the proxy; `.env` points them at your copy
- **Reference voice clips and generated audio.** Someone's voice is not project data
- **Any key, secret or machine path.** They live in `.env`, which is gitignored

## Keyboard shortcuts

| Keys | Action |
| ---- | ------ |
| `Ctrl+K` | Command palette |
| `Ctrl+Shift+O` | New chat |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+,` | Settings |
| `Ctrl+F` | Find in chat (`Enter` / `Shift+Enter` to step through hits) |
| `Ctrl+\` | Toggle the artifact panel |
| `Ctrl+/` | Shortcut list |
| `Esc` | Close palette / settings / artifact panel, or leave chat selection |
| `Enter` / `Shift+Enter` | Send / newline |
| `/` | Slash commands in the composer |

## Layout

`no-undef` is on in `.oxlintrc.json`, and it is there because of two shipped bugs
of the same shape: a component calling `t()` with no `t` in scope, which threw the
moment a long code block rendered, and `generateSessionTitle` calling
`promptLanguageName` without importing it, which meant no chat was ever named by
the model. Each is one missing import, neither is visible in review, and both
were swallowed — one by an error boundary, one by a `catch`. The rule finds them
at zero cost: it reports nothing else anywhere in the repository. `env` lists
every runtime here, because they differ — the app is a browser, `scripts/` and
`server/` are Node, and `public/sw.js` is a service worker.

```
src/
  App.jsx       chat, sessions, settings, voice
  StudioPanel.jsx  making a picture on purpose: the form, the queue, the gallery
  artifacts.jsx fence parsing, preview assembly, sandbox frame, runners, code view
  ui.jsx        resizable splitters, popovers, persisted-size hook
  i18n.jsx      12 language tables, detection, RTL, the t() provider
  session.jsx   the session: who is signed in, CSRF, cross-tab, the sign-in calls
  syncEngine.js browser storage <-> records, the sync scheduler, the live stream
  sessionEdit.js when a chat last changed, and why that is load-bearing
  clipboard.js  copying that works on an address that is not localhost
  perf.js       what each model has actually done on this machine
  coalesce.js   batching that still fires while a reply is streaming
  gestures.js   the drawer swipe, and the drags it has to refuse
  haptics.js    a short buzz where the confirmation is under your finger
  pwa.js        installing the app, and noticing a new build is waiting
  viewport.js   keeps the app the height of the part of the screen the keyboard
                has left, on the browsers that do not do it themselves
  auth.jsx      Google button, Kakao redirect, provider config, avatars
  passkey.js    the browser half of WebAuthn; the server does the verifying
  AuthScreen.jsx  the sign-in / sign-up screen
  ProfileDialog.jsx  profile editing, avatar handling, password change
  index.css     base Claude-style theme
  extras.css    design tokens, data-theme overrides, newer components
scripts/
  artifacts.test.mjs         offline tests for parsing + preview assembly
  i18n-auth.test.mjs         translation completeness, provider config
  auth.test.mjs              login over real HTTP: sessions, CSRF, throttling,
                             passkeys, delta sync and the owner check
  accounts.test.mjs          accounts, sessions and the record store in SQLite
  syncengine.test.mjs        two simulated devices: conflicts, deletions, deltas
  livesync.test.mjs          the change doorbell: who is woken, and who is not
  origin.test.mjs            PUBLIC_ORIGIN parsing, and what the app is told
  stamp.test.mjs             the chat clock: which edits the sync can see
  coalesce.test.mjs          the debounce ceiling, against a simulated stream
  gestures.test.mjs          the drawer swipe: what opens it, and what must not
  settingscope.test.mjs      settings are read from where they were written
  pyimports.test.mjs         runs the runner's import-finder and its loop
                             transform through a real Python, since Node cannot
                             tell whether a snippet of Python is even valid
  clipboard.test.mjs         copying with and without a secure context
  llamacpp.test.mjs          the Ollama-to-llama.cpp translation, which fails
                             silently when it is wrong: a dropped repeat_penalty
                             is a looping model, and tool arguments of the wrong
                             type are a tool that never runs
  comfygraph.test.mjs        converting an editor workflow into the API format:
                             widget order, the control_after_generate that
                             `/object_info` does not always admit to, subgraphs
                             and subgraphs inside them, mute versus bypass —
                             every rule found by watching a live ComfyUI reject
                             three real workflows
  studio.test.mjs            the catalogue and the bindings: which control each
                             workflow actually has, and where it writes
  webtext.test.mjs           charset detection against real EUC-KR bytes, and
                             whether a search result is about the question
  composer.test.mjs          the composer, measured in a real browser: the box
                             is above the controls, and the menus open upwards
  perf.test.mjs              the arithmetic behind the model table: medians,
                             cold loads counted apart, and a chat that has
                             grown expensive enough to be worth compacting
  smoke.test.mjs             builds, serves dist/, opens it in a headless
                             browser and fails on any uncaught exception — the
                             only thing that catches a render-time crash
  attach.test.mjs            what a dropped file becomes: a real PDF through
                             the extractor, the CJK character maps being present
                             and wired up, and a scan for the readAsText call
                             that turned a PDF into mojibake
  pwa.test.mjs               the manifest, and every request the worker refuses
                             to cache
  artifacts.integration.mjs  the artifact pipeline against a live model
  measure-layout.mjs         drives headless Edge/Chrome and reports what is
                             wider than the viewport, so "looks cut off" is a
                             number rather than an impression of a screenshot
public/
  manifest.webmanifest  what makes the browser offer to install this
  sw.js                 the offline shell, and everything it refuses to cache
  icon-maskable.svg     the logo on a plate, for launchers that crop to a shape
  pdf-assets.mjs             copies pdf.js's character maps into public/, so a
                             Korean PDF is readable rather than "empty"
workflows/      the ComfyUI workflows the Studio runs, exported from ComfyUI
server/
  api.js        the API both the dev server and `npm start` mount
  comfyGraph.js a ComfyUI editor workflow, converted to the API's own format
  workflows.js  which node in each workflow is the prompt, the size, the LoRA
  llamacpp.js   being Ollama, but llama.cpp: the dialect translation and its routes
  studio.js     ComfyUI: the model catalogue, the workflow graphs, the queue
  webText.js    reading the web as text — charset detection, relevance ranking
vite.config.js  proxies + the /localfs dev middleware
```

The preview pulls Babel and React from a CDN only when a snippet actually needs them;
without a network connection those previews report the failure in the Console tab instead
of rendering a blank frame.
