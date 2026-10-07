"""Local speech-to-text for Ollama WebUI.

Speaks the OpenAI /v1/audio/transcriptions shape that server/index.js proxies
to (STT_HOST:STT_PORT). Run with the Python bundled in engines/gpt-sovits,
which already ships faster-whisper and FastAPI, so nothing extra is installed.
The model (STT_MODEL, default "small") is downloaded on first use.

Started by server/engines.js as the "stt" engine.
"""
import argparse
import os
import tempfile

import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, PlainTextResponse

parser = argparse.ArgumentParser()
parser.add_argument("--host", default="127.0.0.1")
parser.add_argument("--port", type=int, default=8000)
args = parser.parse_args()

app = FastAPI()
_model = None


def model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        name = os.environ.get("STT_MODEL", "small")
        try:
            _model = WhisperModel(name, device="cuda", compute_type="float16")
        except Exception:
            # No CUDA (or no room on the card): the CPU is slower but works.
            _model = WhisperModel(name, device="cpu", compute_type="int8")
    return _model


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), language: str = Form(None),
                     response_format: str = Form("json"), model_name: str = Form(None, alias="model")):
    suffix = os.path.splitext(file.filename or "")[1] or ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        segments, _info = model().transcribe(path, language=language or None, vad_filter=True)
        text = "".join(s.text for s in segments).strip()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if response_format == "text":
        return PlainTextResponse(text)
    return JSONResponse({"text": text})


if __name__ == "__main__":
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
