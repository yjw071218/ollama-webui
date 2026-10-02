<script lang="ts">
  import { DBState, OpenRealmStore } from 'src/ts/stores.svelte';
  import { changeChar, createNewCharacter } from 'src/ts/characters';
  import { getFileSrc } from 'src/ts/globalApi.svelte';
  import { Upload, Plus, ArrowLeft } from '@lucide/svelte';
  import Hub from 'src/lib/UI/Realm/RealmMain.svelte';
  const importCard = () => window.parent.postMessage({ channel: 'webui-risu', openImport: true }, location.origin);
  const create = async () => { await changeChar(createNewCharacter()); };
  let query = $state('');
  let sort = $state('original');
  const characters = $derived.by(() => {
    const term = query.trim().toLocaleLowerCase();
    const entries = DBState.db.characters.map((character, index) => ({ character, index }))
      .filter(({ character }) => !term || (character.name || '').toLocaleLowerCase().includes(term));
    return sort === 'name' ? entries.sort((a, b) => (a.character.name || '').localeCompare(b.character.name || '', 'ko')) : entries;
  });
</script>

{#if $OpenRealmStore}
  <div class="webui-home"><button class="m-4 p-2" aria-label="캐릭터 목록으로" onclick={() => OpenRealmStore.set(false)}><ArrowLeft /></button><Hub /></div>
{:else}
  <main class="webui-home">
    <div class="webui-home-inner">
      <div class="webui-library-heading"><h1>내 캐릭터</h1><span>{DBState.db.characters.length}</span><div class="webui-home-actions">
        <button onclick={create}><Plus size={16} /> 직접 만들기</button>
      </div></div>
      {#if DBState.db.characters.length}
        <div class="webui-library-tools">
          <input type="search" bind:value={query} aria-label="캐릭터 이름 검색" placeholder="캐릭터 이름으로 검색" />
          <select bind:value={sort} aria-label="캐릭터 정렬"><option value="original">기본 순서</option><option value="name">이름순</option></select>
        </div>
      {/if}
      {#if DBState.db.characters.length}
        <div class="webui-character-grid">
          {#each characters as { character, index } (index)}
            <button class="webui-character" onclick={() => changeChar(index)}>
              {#if character.image}
                {#await getFileSrc(character.image)}
                  <span class="webui-character-initial">{character.name?.slice(0, 1) || '·'}</span>
                {:then image}
                  <img src={image} alt="" loading="lazy" />
                {:catch}
                  <span class="webui-character-initial">{character.name?.slice(0, 1) || '·'}</span>
                {/await}
              {:else}
                <span class="webui-character-initial">{character.name?.slice(0, 1) || '·'}</span>
              {/if}
              <div class="webui-character-copy"><strong>{character.name || '새 캐릭터'}</strong><p>{character.type === 'group' ? '여러 캐릭터와 함께하는 대화' : (character.scenario || character.desc || '이 캐릭터와 이야기를 시작하세요.').slice(0, 160)}</p></div>
            </button>
          {/each}
        </div>
        {#if !characters.length}<div class="webui-library-empty">검색한 이름의 캐릭터가 없습니다.<br /><button onclick={() => query = ''}>검색 지우기</button></div>{/if}
      {:else}
        <div class="webui-library-empty"><p>함께 이야기할 캐릭터를 추가하세요.</p><p>캐릭터 카드를 가져오면 이미지와 설정도 함께 불러옵니다.</p><button onclick={importCard}><Upload size={16} /> 캐릭터 가져오기</button></div>
      {/if}
      <footer class="webui-home-footer"><span>Powered by RisuAI</span><a href="/risuai/LICENSE.txt" target="_blank" rel="noreferrer">라이선스</a></footer>
    </div>
  </main>
{/if}
