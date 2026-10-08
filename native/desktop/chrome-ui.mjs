import { localize } from './page-i18n.mjs';
localize();
document.querySelectorAll('[data-action]').forEach(button=>button.addEventListener('click',()=>window.appChrome.action(button.dataset.action)));
// The page's own colours (theme.mjs chromeColors), sent on every theme change.
window.appChrome.onColors(colors=>{
  const style=document.documentElement.style;
  for (const name of ['bg','fg','muted','line','hover']) if (/^#[0-9a-f]{6}$/i.test(colors?.[name]||'')) style.setProperty('--'+name, colors[name]);
});
