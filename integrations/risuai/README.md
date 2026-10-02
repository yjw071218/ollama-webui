# RisuAI integration

The **상황극** tab embeds a locally built, pinned RisuAI browser application.
The upstream character/preset/module importers, prompt assembly, CBS parser,
lorebooks, regex engine, triggers and chat UI run inside that application.
This is not a conversion of cards into the WebUI image-training character list.

## Install and use

Requires Git, Node compatible with upstream (20.19+ or 22.12+), and pnpm.

```sh
npm run risu:setup
npm run build
npm start
```

`npm run dev` serves the same `/risuai` routes. A server already running before
the integration was added needs a restart. Source and the browser build stay
in `integrations/risuai/upstream`, outside the main `dist` folder; deploy this
directory alongside the WebUI when copying an installation. `npm run risu:build`
rebuilds without installing dependencies. Setup verifies `version.json`'s
commit and refuses to reset an existing checkout at another revision.

1. Select a local model in the WebUI and open **상황극**.
2. Review RisuAI's first-use service terms screen. The integration does not
   accept terms for the user.
3. Use **파일 가져오기** for CHARX, PNG, JPG/JPEG CHARX, JSON cards,
   RISUP/RISUPRESET/PRESET presets or RISUM modules.
4. A character opens after import. Imported presets are listed in RisuAI's
   settings; select one there to apply its prompt template and parameters.
5. The selected WebUI model connects automatically when it is installed locally
   in Ollama. Otherwise the previous valid local model or first installed chat
   model is used. Cloud and embedding models are excluded. The toolbar shows
   the actual model. Requests use `/risuai/ollama/api/chat` and always route to
   Ollama, including when the main chat uses llama.cpp. The exception is a
   model answered by a signed-in coding CLI (`claude-code:…`, `codex:…`,
   `agy:…`, see `server/cliModels.js`): those are listed and answered here
   too, streamed like any other, on the reader's own subscription. Presets retain prompts
   and sampling settings while their provider choice and cloud fallbacks are
   overridden. An unavailable local server produces an explicit error.

On subsequent visits the last valid roleplay model is restored from account-scoped
browser storage before considering the host model. Explicit changes to the host
model still update roleplay. Both streaming and complete Ollama responses use
the host's shared UTF-8 byte-fallback decoder, including thinking text; streaming
decodes accumulated text so byte tokens split across chunks can be reassembled.

The character home, toolbar, composer and settings follow the host palette and
font, including live light/dark theme changes. Native character editing, preset
controls and importers remain available inside the embedded application.

CLI-backed models preserve preset system/developer instruction text and retain
the position of instructions placed after or between conversation turns. A
post-history instruction does not disable continuation of an assistant prefix.
This improves prompt transport fidelity for AGY, Claude Code and Codex; it does
not guarantee model compliance with every preset or override provider policies.

The roleplay chat proxy sends all user-role messages as assistant-role history,
including the latest input, so generation continues from user-supplied AI context.
Message content, images and ordering are preserved. This applies to both local
Ollama and CLI-backed roleplay models. Saved chats and displayed speakers retain
their original roles; the main WebUI chat is unaffected.

CBS-bearing streaming replies use the normal parser even when strong display
optimization is selected. Conditional blocks inserted by display scripts are
evaluated with the message index and character context before Markdown and
asset rendering, consistently across desktop and mobile.

Fast generation is enabled on first upgrade and can be disabled in model
settings. It applies only to local Ollama models; AGY, Claude Code, Codex and
cloud models retain their original context, response and thinking settings even
when the toggle is enabled. Local runtime prompt and Ollama context budgets are capped together at
32,768 tokens; the response budget is capped at 2,048. Original preset values
are retained. Native history trimming still applies, and oversized mandatory
prompts may require a larger budget with fast mode disabled. Fast mode disables
separate model thinking. Streaming is enabled once on upgrade and remains
user-configurable; automatic streaming initialization is local-only. Local requests retain the model for 15 minutes to reduce reloads;
the host resource manager can still unload it for other GPU jobs.

Encrypted presets also work on HTTP LAN origins without `crypto.subtle`:
the adapter uses local SHA-256/AES-GCM via `@noble/hashes` and `@noble/ciphers`,
preserving the upstream format and authentication tag validation. Preset bytes
are not uploaded for decryption. The browser suite tests this missing-API path;
set `RISU_TEST_PRESET` to a local file path to additionally test a private preset
in its disposable browser profile.

## Storage and assets

Cards, binary assets and conversations use browser IndexedDB, separately for
each WebUI account. Small preferences and broadcast channels are also scoped.
Signed-in accounts additionally sync characters (including conversations),
preset lists, modules and binary assets through `/api/risu/sync`. Open the PC
roleplay tab first and wait for **동기화됨**, then open the same WebUI server and
account on mobile. Visible tabs check revisions every second and on focus;
completed responses trigger an immediate automatic check. Unchanged revisions
avoid downloading the full snapshot. Generation and open settings defer
applying remote updates; unsent draft text remains in the composer. No manual
sync or conflict confirmation is required. Active model, prompt and generation
settings, selected preset, personas, global lorebooks/scripts and enabled modules
sync with the conversations. UI preferences and provider credentials remain
device-local. Settings edits sync while the panel remains open.
Mobile pages restored from the browser back/forward cache resume synchronization.
Asset verification and transfer use eight concurrent workers and report progress.
Uploads retain file paths instead of the entire binary library in memory, so
large libraries do not require a second in-memory copy on mobile. The synced
status includes the actual local character count and is shown only after apply.
After initial synchronization, both directions transfer revision-checked deltas:
appended messages and edited fields, rather than whole libraries. A client older
than the retained ten revisions receives a full snapshot once to catch up.
Asset digests are indexed once per page session and updated on storage writes;
ordinary conversation/settings updates do not re-read unchanged binary files.
Same-account tabs invalidate changed asset keys through a scoped broadcast channel.
Visible pages check the lightweight revision endpoint every 500 ms, with an
additional 100 ms debounced sync after storage writes. Completed generation
triggers a sync after 250 ms. Network/asset transfer time adds to these intervals.
Guest data remains local and is not silently moved into a
signed-in account; export/import it explicitly if needed.

Server snapshots use SQLite account foreign keys, authenticated sessions and
CSRF checks. Optimistic revisions reject stale writes; three-way merging keeps
independent edits. Conflicting records are automatically preserved as separately
named copies with deterministic ids, keeping both conversation versions.
Conflicting binary paths get separate references. The local pre-merge snapshot
is additionally retained in IndexedDB (`webui-sync/conflict-*`).
The server retains 10 snapshot revisions. Binary
assets are SHA-256 checked and account-scoped (64 MiB per file, 2 GiB per account);
failures are visible and leave local data intact. Include the WebUI server data
directory in backups, and still use native Risu export for portable backups.

CHARX assets, PNG embedded asset chunks, `module.risum`, and asset references
are processed by upstream. Local asset bytes are displayed through Blob URLs
with MIME detection for image/audio/video rather than being labelled PNG.
RisuAI's root service worker and OPFS storage are disabled to avoid overwriting
the host worker or mixing accounts. Blob URLs are released when the frame exits.
Tabs keep the frame mounted so switching away does not interrupt a roleplay.

## Compatibility and validation

Compatibility follows the pinned upstream revision, not every historical or
future RisuAI version. Corrupt files, missing assets, browser quota/codec limits,
upstream asset size limits, network-only features and third-party plugin/provider
requirements still apply. Import success does not establish that every script
or provider-specific preset option works on every local model. No blanket
“100% compatible” claim is made.

```sh
npm run test:risu
node scripts/risuai.browser.test.mjs
```

The browser suite uses an isolated disposable Chrome/Edge profile and generated
fixtures. It exercises actual importers, Unicode asset references, encrypted
legacy and RPack presets, PNG asset chunks, embedded modules, image/WAV rendering,
failed imports, saved conversations and persistent account isolation. It also
checks the host tab at mobile size. A mock Ollama endpoint verifies the assembled
character/lore prompt and sampling values; this does not assess a real model's
roleplay quality. It does not access personal character cards.

Validation on 2026-09-28: host and RisuAI production builds passed, the browser
suite passed, and host PWA/Studio/server regression tests passed. Upstream
`pnpm check` reports two pre-existing `PluginPermission` type errors for
`'periodically'` in `src/ts/plugins/apiV3/v3.svelte.ts`; that pinned file is
unmodified. No type errors were reported for the integration bridge.

## Upstream and modifications

RisuAI: https://github.com/kwaroran/Risuai

Pinned source: https://github.com/kwaroran/Risuai/tree/ca1345fca1b65f2f4eac976510b7753e290eaa98

RisuAI is GPL-3.0; its license is copied into the served build at
`/risuai/LICENSE.txt`. Keep upstream's notices and component licenses with its
source. Hosting adapters in this directory were added on 2026-09-28: build base
paths, scoped storage, import/model bridge, Blob asset rendering, local Ollama
sampling and cancellation. `vite.webui.config.mjs` applies those adapters at
build time without editing the pinned source files. Their source and build
script must accompany a distributed modified build, along with the pinned
upstream source. This installation is configured for private self-hosting;
public services need their own deployment configuration.
