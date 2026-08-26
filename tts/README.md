# GPT-SoVITS voice output

The web UI speaks replies through a local [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
inference server. This folder holds the launcher and the settings that connect
the two.

**The GPT-SoVITS install itself is not in this repository.** A working copy is
roughly 25 GB — model weights, a bundled Python runtime, and whatever voices you
have trained — which is both far past what a git host will take and, in the case
of the voices, yours rather than the project's. So the repository carries the
integration and you point it at your own install.

## Setup

1. Install GPT-SoVITS (the Windows integration package is the least work).
2. Copy `.env.example` to `.env` in the repository root and fill in:

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
| `tts/start-tts-api.ps1` | Reads `.env`, puts ffmpeg on `PATH`, runs `api_v2.py` |
| `/api/tts-status` | Whether a path is configured and whether it exists |
| `/api/start-tts` | Launches the server detached, so it outlives the request |
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

**"GPT_SOVITS_PATH is not set"** — `.env` is missing or the key is empty.

**Server starts, requests fail** — check `GPT_SoVITS/configs/tts_infer.yaml`
points at weights that exist. Override its location with `GPT_SOVITS_CONFIG`.

**Audio is silent or clipped** — ffmpeg is not on `PATH`. Set `FFMPEG_BIN`;
GPT-SoVITS shells out to it for anything that is not already 32 kHz wav.

**Port already in use** — set `TTS_PORT` (and restart the dev server, since the
proxy target is read at startup).
