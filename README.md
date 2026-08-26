# Ollama WebUI

A local, single-page chat UI for [Ollama](https://ollama.com), built with React + Vite.
Everything runs on your machine: chats live in IndexedDB (via `localforage`), settings in
`localStorage`, and model traffic goes straight to `http://localhost:11434`.

## Running it

```bash
npm install
npm run dev        # UI only (expects `ollama serve` to already be running)
npm run dev:all    # starts `ollama serve` and the UI together
npm run build      # production bundle into dist/
npm run lint       # oxlint
npm test           # artifact, i18n and auth tests (no server needed)
npm run test:live  # artifact pipeline against a live Ollama model
```

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

The rule the layout enforces: anything prefixed `VITE_` is compiled into the
bundle and is therefore public; anything without the prefix is read only by the
dev server and never leaves the machine.

The Vite dev server proxies:

| Path        | Target                    |
| ----------- | ------------------------- |
| `/api`      | `http://localhost:11434`  (Ollama) |
| `/tts-api`  | `http://127.0.0.1:9880`   (GPT-SoVITS) |
| `/localfs`  | dev-server middleware (local file read/write/list/search) |
| `/kakao`    | dev-server middleware (Kakao OAuth code exchange) |
| `/system`   | dev-server middleware (CPU / GPU / memory stats) |
| `/mcp`      | dev-server middleware (page fetch and web search) |
| `/api/tts-status`, `/api/start-tts` | dev-server middleware (GPT-SoVITS launcher) |

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
- Copy, delete, star and read-aloud per message; delete is undoable from the toast
- Voice input via the Web Speech API
- **Find in chat** (`Ctrl+F`) highlights every hit in place with a match counter and
  prev/next stepping - nothing is hidden. Sidebar search still spans all chats
- **Star messages** and filter the transcript down to the starred ones

### Composer
- **Slash commands** — type `/` for a menu (`/imagine`, `/web`, `/summarize`, `/translate`,
  `/explain`, `/review`, `/fix`, plus anything in your prompt library)
- **Paste images straight from the clipboard**, or **drag & drop files** onto the composer
- Attach images (routed to a vision model) and text files
- **Live context meter** — estimated token usage against your `num_ctx` setting
- Jump-to-latest button when you have scrolled up

### Voice
- **Text to speech** through GPT-SoVITS, or the browser's built-in synthesiser
- **Reasoning, tool blocks, code and injected context are stripped before speaking** -
  only the prose the assistant actually wrote is read out
- Configurable reference clip, reference transcript, output/reference language, speed
  and a character cap so long answers do not take minutes to synthesise
- Optional **auto-play** of finished replies, a Test voice button, and a Stop control
- If GPT-SoVITS is not listening, the app asks the dev server to start it and says so

### Sessions
- Auto-generated titles, grouped by Today / Yesterday / Previous 7 days / …
- **Pin** chats to the top, **rename** them (double-click the title), **duplicate** them
- Export a single chat as **Markdown**, all chats as Markdown, or everything as JSON
- Import a JSON export back (IDs are re-keyed, so nothing is overwritten)
- **Chat info panel** with message/token/speed statistics, a **per-chat system prompt
  override**, retitle, and an undoable "clear messages"

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

### Cross-chat memory
- Facts worth keeping (`profile` / `preference` / `project` / `fact`) are extracted with a
  JSON-Schema-constrained call and injected into the system prompt of later chats
- Word-overlap duplicate detection, so the same preference is not stored twenty times
- Off by default, per profile, editable and deletable, and never leaves the browser

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
- **Run** - Python executes via Pyodide, with `stdout`/`stderr`, a timer, and on-demand
  installation of detected imports (numpy, pandas, matplotlib, sympy, …).
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
Three ways in, plus guest. Each profile gets its own chat history.

**Passkey — nothing to configure.** Sign up and in with Windows Hello, Touch ID, a
fingerprint or a security key. No password, no provider registration, no client ID: the
browser and the OS do the work. The assertion is verified in-page with WebCrypto against
the public key captured at sign-up (ECDSA P-256 / RS256, DER→raw conversion included), and
the challenge is checked against the one just issued. The button only appears when the
device actually has a platform authenticator.

**Email and password.** Stored as **PBKDF2-SHA512** hashes (210k iterations, per-account
salt) via WebCrypto — never in plaintext. Sign-in compares in constant time and derives a
hash even for unknown accounts, so a missing account and a wrong password take the same
time.

**Google.** Google Identity Services renders its own button; the ID token comes straight
back to the browser. Needs an OAuth **client ID** with this origin listed under *Authorised
JavaScript origins*. No redirect URI and no client secret.

**Kakao.** Authorization code grant. A popup collects the code and the dev server exchanges
it at `/kakao/exchange` — Kakao's token endpoint rejects the JS key and sends no CORS
headers, so it cannot be called from the page. In the Kakao console, in this order:

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

> **Why do these two need setup when other sites "just work"?** They don't skip it: the
> site's developer registered the app once and shipped the client ID, so visitors only see
> the result. Google and Kakao will not issue a token to an unregistered origin — that is
> the entire point of the client ID. Here you are the developer, so the one-time step is
> visible. Copy `.env.example` to `.env`, fill in `VITE_GOOGLE_CLIENT_ID` /
> `VITE_KAKAO_REST_KEY`, and the buttons work for everyone from then on, exactly like a
> normal site. Settings → Account has the checklist, the origin and the redirect URI.
> **Passkeys need none of this.**

**Profile settings** — display name, email, and a **profile picture** (cropped to a square
and downscaled to 160px before storing, so a photo cannot bloat IndexedDB). Password
accounts can change their password, which re-derives against a fresh salt. Profiles without
a picture get a colour derived from their id, so they stay recognisable.

Chats are namespaced per profile (`ollama-sessions:<id>`); a guest keeps the original key,
so an existing install keeps its history.

> **What this is and is not.** There is no backend here, so accounts are *device-local
> profiles*. They separate histories and settings between people sharing the app, but
> anyone who can open this browser's devtools can read the stored data. Real
> authentication would need a server; this deliberately does not pretend to be one.

### Layout and appearance
- **Resizable panels** - drag the edge of the sidebar or the artifact panel. Double-click
  an edge to reset just that one, arrow keys nudge it when focused, and the sizes are
  remembered. Dragging keeps working over the preview iframe.
- The artifact panel **maximizes** to fill the window, and becomes a full-screen overlay
  below 860px instead of squeezing the chat.
- **Chat outline** - jump to any of your turns in a long conversation from one popover.
- Light / Dark / System theme (stored, and it overrides your OS preference).
- **Text size** (small / medium / large) and **density** (comfortable / compact).
- **Animations** - System / Full / Reduced. Everything that opens also *closes* with
  motion: modals, the command palette, popovers, menus and the slash list stay mounted for
  the length of their exit animation instead of vanishing.
- Every duration flows through a handful of CSS custom properties, so Reduced (and your OS
  `prefers-reduced-motion` setting) switches the whole app off in one place. The streaming caret keeps blinking either way,
  because that one carries meaning.
- Seven highlight.js themes for code blocks, plus a word-wrap toggle in the code view.

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
| `Esc` | Close palette / settings / artifact panel |
| `Enter` / `Shift+Enter` | Send / newline |
| `/` | Slash commands in the composer |

## Layout

```
src/
  App.jsx       chat, sessions, settings, voice
  artifacts.jsx fence parsing, preview assembly, sandbox frame, runners, code view
  ui.jsx        resizable splitters, popovers, persisted-size hook
  i18n.jsx      12 language tables, detection, RTL, the t() provider
  auth.jsx      PBKDF2 hashing, passkeys (WebAuthn), profile store, Google / Kakao
  AuthScreen.jsx  the sign-in / sign-up screen
  ProfileDialog.jsx  profile editing, avatar handling, password change
  index.css     base Claude-style theme
  extras.css    design tokens, data-theme overrides, newer components
scripts/
  artifacts.test.mjs         offline tests for parsing + preview assembly
  i18n-auth.test.mjs         translation completeness, password hashing, passkey crypto
  artifacts.integration.mjs  the artifact pipeline against a live model
vite.config.js  proxies + the /localfs dev middleware
```

The preview pulls Babel and React from a CDN only when a snippet actually needs them;
without a network connection those previews report the failure in the Console tab instead
of rendering a blank frame.
