# engines/

The models this app runs itself, each a whole install: its own Python, its own
weights, and — for the voice — the voices trained on this machine.

| Folder | What it is | Port | Started by |
|---|---|---|---|
| `gpt-sovits/` | GPT-SoVITS, the voice the app speaks with | 9880 | Settings → Voice, or the first time something is spoken |
| `ace-step/` | ACE-Step 1.5, which writes and records songs | 8001 | the first time a song is asked for |

Everything in here except this file is gitignored. It is tens of gigabytes,
none of it is source, and the voices are nobody else's to publish.

## Starting them

You do not. `server/engines.js` starts an engine the first time a request needs
it and waits for it to answer; a start that dies reports the end of its log
rather than looking like one that is still loading. The logs are in
`engines/logs/<name>.log`.

    GET  /api/engines          what is installed, and what is running
    POST /api/engines/start    { "id": "ace-step" }

## Pointing somewhere else

`.env` wins where it names a path, so an install kept elsewhere on purpose goes
on working:

    GPT_SOVITS_PATH=D:\GPT-SoVITS
    GPT_SOVITS_PYTHON=D:\GPT-SoVITS\runtime\python.exe
    ACE_STEP_PATH=D:\ACE-Step-1.5
    ACE_STEP_PYTHON=D:\ACE-Step-1.5\.venv\Scripts\python.exe

With nothing set, each is looked for in this folder, and its own bundled
interpreter is used — `gpt-sovits/runtime/python.exe`, `ace-step/.venv`.

## If you move one in or out

These installs record their own absolute path in a few places, and moving the
folder without fixing them gives an engine that starts and then cannot import
itself:

- `ace-step/.venv/Lib/site-packages/_ace_step.pth` and the `direct_url.json`
  beside it — the editable install pointing at the project root.
- `gpt-sovits/runtime/Lib/site-packages/users.pth` — the same idea.
- `gpt-sovits/GPT_SoVITS/configs/tts_infer.yaml` — the `custom:` block holds
  absolute paths to the weights currently loaded.

Each was rewritten when these were moved in; the originals are beside them as
`*.before-move`.

A junction is left at each folder's old location, so anything else on this
machine that pointed at the old path still finds it.
