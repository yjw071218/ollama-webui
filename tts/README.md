# GPT-SoVITS voice output

The web UI speaks replies through a local [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
inference server. This folder holds the launcher and the settings that connect
the two.

**The GPT-SoVITS install lives in `engines/gpt-sovits`, and is gitignored.** A working copy is
roughly 25 GB — model weights, a bundled Python runtime, and whatever voices you
have trained — which is both far past what a git host will take and, in the case
of the voices, yours rather than the project's. So it sits inside the project
and out of the repository -- see `engines/README.md`.

## Setup

1. Put a GPT-SoVITS install in `engines/gpt-sovits` (the Windows integration
   package is the least work). Nothing else is needed: it is started with the
   `runtime\python.exe` it ships with, by the app, when something is first
   spoken.
2. Optionally, in `.env` -- only to point somewhere else, or if ffmpeg is not on
   `PATH`:

   ```ini
   GPT_SOVITS_PATH=C:\path\to\GPT-SoVITS
   GPT_SOVITS_PYTHON=C:\path\to\python.exe
   FFMPEG_BIN=C:\path\to\ffmpeg\bin
   ```

   `.env` is gitignored, so none of this leaves your machine.

3. Start the web UI with `npm run dev`. Open **Settings → Voice**, choose a
   reference clip and press **Start TTS server** — or run the launcher yourself:

   ```powershell
   pwsh -File tts/start-tts-api.ps1
   ```

## How it hangs together

| Piece | What it does |
|---|---|
| `server/engines.js` | Finds it, starts it, waits for it to answer, and logs the attempt to `engines/logs/` |
| `tts/start-tts-api.ps1` | The same, from a terminal, for when you want the console |
| `/api/tts-status` | Whether it is installed, and whether it is answering |
| `/api/start-tts` | Starts it, detached, so it outlives the request |
| `/api/engines` | The same question for every engine, ACE-Step included |
| `/tts-api/*` | Proxied to the inference server (default `127.0.0.1:9880`) |

The proxy exists because the browser would otherwise be making cross-origin
requests to a server that does not send CORS headers.

## Settings

Everything except the paths lives in the browser, under **Settings → Voice**:
reference clip, prompt text, language of the text and of the clip, speed, and a
character cap per utterance.

A note on the reference clip: it is a path on the machine running the inference
server, not an upload. Nothing about it is stored in this repository, and the
field starts empty precisely so that no one's voice sample ships as a default.

## Troubleshooting

**"GPT-SoVITS is not in engines/gpt-sovits"** — put the install there, or point
`GPT_SOVITS_PATH` at wherever you keep it.

**It says it started and nothing answers** — read `engines/logs/gpt-sovits.log`.
A start that dies quotes the end of that file back at you; one that is merely
slow is still loading two checkpoints onto the card.

**Server starts, requests fail** — check `GPT_SoVITS/configs/tts_infer.yaml`
points at weights that exist. Override its location with `GPT_SOVITS_CONFIG`.

**Audio is silent or clipped** — ffmpeg is not on `PATH`. Set `FFMPEG_BIN`;
GPT-SoVITS shells out to it for anything that is not already 32 kHz wav.

**Port already in use** — set `TTS_PORT` (and restart the dev server, since the
proxy target is read at startup).
