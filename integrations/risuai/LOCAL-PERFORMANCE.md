# Local Ollama performance

The optional managed runtime starts a separate loopback-only Ollama instance
when the production or development WebUI starts. It uses the installed Ollama
binary and existing model store. It does not terminate the desktop Ollama app,
alter model weights, reduce context, or change CLI/cloud providers.

Enable in `.env`:

```dotenv
OLLAMA_URL=http://127.0.0.1:11435
OLLAMA_MANAGED=true
OLLAMA_MANAGED_FIT_TARGET=2048,768
```

The runtime enables Flash Attention, q8_0 KV cache, GPU spreading, one parallel
request, and one resident model. q8_0 reduces cache precision; it is not a change
to the model's weight quantization. The per-device free-VRAM targets are in MiB and need
retuning on different hardware. Inference still passes through the existing
ComfyUI resource guard. The extra server is idle until a model is requested.

On this RTX 5070 Ti 16GB + GTX 1660 SUPER 6GB machine, `gemma4:31b` at 32,768
context tokens generated a fixed 96-token test at 4.21 tokens/sec before tuning
and 6.88–7.08 tokens/sec after tuning. These are short synthetic generation
measurements, not a guarantee for long roleplay prompts or concurrent workloads.
Cold model loading and time waiting behind another request are not included in
tokens/sec. Original prompts, presets and context budgets were not altered.

Reproduce (PowerShell):

```powershell
$env:OLLAMA_BENCH_URL = 'http://127.0.0.1:11435'
node scripts/ollama-speed-bench.mjs sample
```

Metrics are saved in `logs/ollama-speed-bench.jsonl`. Runtime errors are recorded
in `logs/ollama-managed.log`. To revert routing, set `OLLAMA_MANAGED=false` and
`OLLAMA_URL=http://127.0.0.1:11434`, then restart WebUI. No model download or
conversion is required. An already-running private instance retains its current
settings until it is restarted; changing `.env` does not interrupt active work.
