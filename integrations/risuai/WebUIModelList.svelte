<script lang="ts">
    /* Stands in for RisuAI's src/lib/UI/ModelList.svelte (see
       vite.webui.config.mjs). The original lists RisuAI's providers -- Claude,
       GPT, OpenRouter -- none of which this installation calls: every request
       goes to the WebUI model (webui-local-model.js). Picking one there was
       undone at once, so the model picker looked broken. This one lists the
       WebUI's models and picking one switches the model everywhere: here, the
       roleplay toolbar and the WebUI's own selector. */
    import { onMount } from 'svelte';
    import { DBState } from 'src/ts/stores.svelte';
    import { ArrowLeft } from '@lucide/svelte';
    import { subscribeLocalModel, ensureLocalModel } from '../../webui-local-model.js';

    interface Props {
        value?: string;
        onChange?: (v:string) => void;
        onclick?: (event: MouseEvent) => any
        blankable?: boolean
        excludesPrefix?: string
        noMargin?: boolean
    }

    // `value` is RisuAI's provider id (always the WebUI connection here) and is
    // left alone; the props are kept so every existing caller still compiles.
    let { value = $bindable(''), noMargin }: Props = $props();
    let state = $state({ model: '', models: [] as string[], error: '' });
    let openOptions = $state(false);
    let busy = $state(false);
    let failure = $state('');

    onMount(() => subscribeLocalModel((next) => { state = next; }));

    async function changeModel(name: string) {
        openOptions = false;
        busy = true;
        failure = '';
        try { await ensureLocalModel(DBState.db, name, { picked: true }); }
        catch (error) { failure = String(error?.message || error); }
        finally { busy = false; }
    }
</script>

{#if openOptions}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="fixed top-0 w-full h-full left-0 bg-black/50 z-50 flex justify-center items-center" role="button" tabindex="0" onclick={() => { openOptions = false }}>
        <div class="w-96 max-w-full max-h-full overflow-y-auto overflow-x-hidden bg-bgcolor p-4 flex flex-col" role="button" tabindex="0" onclick={(e) => e.stopPropagation()}>
            <div class="flex items-center gap-3 mb-4">
                <button class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0" onclick={() => { openOptions = false }} title="Back">
                    <ArrowLeft size={20} />
                </button>
                <h1 class="font-bold text-xl flex-1">모델</h1>
            </div>
            <div class="border-t-1 border-y-selected mb-2"></div>
            {#each state.models as name}
                <button class={{ 'hover:bg-selected px-6 py-2 text-lg text-left': true, 'text-green-500': name === state.model }} onclick={() => changeModel(name)}>{name}</button>
            {:else}
                <p class="text-textcolor2 px-2">{state.error || '모델 목록을 불러오는 중입니다…'}</p>
            {/each}
            <p class="text-textcolor2 text-xs mt-4 px-2">WebUI의 모델 선택과 같은 설정입니다. 여기서 바꾸면 WebUI 상단 선택도 함께 바뀝니다.</p>
        </div>
    </div>
{/if}

<button onclick={() => { openOptions = true }} disabled={busy}
    title={failure || state.error || ''}
    class={{
        "drop-shadow-lg p-3 flex justify-center items-center ml-2 mr-2 rounded-lg bg-darkbutton border-darkborderc border": true,
        "my-4": !noMargin,
    }}>
        {busy ? '연결 중…' : (state.model || state.error || '모델 확인 중…')}
</button>
