"""
What ComfyUI has in memory, for Ollama WebUI's list of loaded models.

ComfyUI keeps models loaded between prompts and has no endpoint that says
which: /system_stats gives one total per card. This adds GET /webui/loaded,
read from the same list ComfyUI itself consults when it decides what to unload,
with the two figures Ollama's /api/ps reports for a language model -- the whole
model, and how much of it is on the GPU. The rest is in system RAM, which is
where a 20GB video model on a 16GB card spends most of its time.

It also keeps ComfyUI's reserve for other programs at ComfyUI's own figure.
See `_undo_snapshot_reserve`.

Install: copy this folder into ComfyUI/custom_nodes and restart ComfyUI.
Without it the WebUI still shows what ComfyUI holds, as one total.
"""

import logging

from aiohttp import web

import comfy.model_management as mm
from comfy.cli_args import args
from server import PromptServer

MB = 1024 * 1024


def _own_reserve():
    """What ComfyUI itself sets aside for other programs: --reserve-vram, or its default."""
    if args.reserve_vram is not None:
        return int(args.reserve_vram * 1024 * MB)
    reserve = 400 * MB
    if mm.WINDOWS:
        reserve = 600 * MB
        if mm.total_vram > 15 * 1024:
            reserve += 100 * MB
    return reserve


def _undo_snapshot_reserve():
    """
    Put the reserve back when something has frozen a snapshot into it.

    ComfyUI-DistorchMemoryManager ("VRAM-Manager") measures what other programs
    hold on the card at the moment ComfyUI starts and reserves that much for
    the whole session. Started while a language model sat on the card, it
    reserved 13.18 GB of a 16 GB card -- and ComfyUI already subtracts what
    other programs hold, because it asks the card what is free before every
    load, so the reservation counted them twice. Every model then loaded with
    0.6 GB to work in, fully offloaded, until the PiD upscaler, handed half a
    model, stopped with "Input type (CUDABFloat16Type) and weight type
    (CPUBFloat16Type) should be the same". The language model had been gone
    for an hour; the reservation was still there.

    Only a reserve well past ComfyUI's own is put back, so a --reserve-vram
    somebody chose is left alone.
    """
    own = _own_reserve()
    held = int(getattr(mm, 'EXTRA_RESERVED_VRAM', own) or 0)
    if held > own + 512 * MB:
        mm.EXTRA_RESERVED_VRAM = own
        logging.info('[ollama-webui] VRAM reserved for other programs was %.2f GB, measured once at '
                     'startup; put back to ComfyUI\'s own %.2f GB. ComfyUI measures what is free before '
                     'every load, so what other programs hold is already counted.', held / 1024 / MB, own / 1024 / MB)
        return held
    return None


_undo_snapshot_reserve()


def _on_prompt(json_data):
    # Again before each prompt, in case a node loaded after this one set it.
    _undo_snapshot_reserve()
    return json_data


PromptServer.instance.add_on_prompt_handler(_on_prompt)


def _describe(loaded):
    patcher = loaded.model
    if patcher is None:  # collected, and on its way out of the list
        return None
    inner = getattr(patcher, 'model', None)
    # The name ComfyUI's own log uses: "Requested to load MiniMaxH3VideoVAE".
    name = type(inner if inner is not None else patcher).__name__
    size = int(loaded.model_memory())
    on_card = int(loaded.model_loaded_memory())
    device = getattr(loaded, 'device', None)
    if getattr(device, 'type', '') == 'cpu':
        on_card = 0  # loaded, but loaded onto the CPU
    return {'name': name, 'size': size, 'size_vram': min(on_card, size), 'device': str(device)}


@PromptServer.instance.routes.get('/webui/loaded')
async def loaded_models(request):
    models = []
    for loaded in list(mm.current_loaded_models):
        try:
            described = _describe(loaded)
        except Exception:  # a model half torn down has no size worth reporting
            continue
        if described and described['size'] > 0:
            models.append(described)
    return web.json_response({
        'models': models,
        # What ComfyUI keeps free for other programs, so a wrong one can be seen.
        'reserved': int(getattr(mm, 'EXTRA_RESERVED_VRAM', 0) or 0),
    })


# No nodes, only the route. ComfyUI skips a custom node package without this.
NODE_CLASS_MAPPINGS = {}
