// Installed only by QuickAskActivity, before the server UI starts. Keeping the
// real chat engine preserves sign-in, model providers, streaming and attachments.
(() => {
  if (window !== window.top) return;
  const install = () => {
    if (!document.documentElement) return false;
    document.documentElement.dataset.nativeQuickAsk = 'true';
    const style = document.createElement('style');
    style.textContent = `
      html[data-native-quick-ask] .claude-sidebar,
      html[data-native-quick-ask] .sidebar-backdrop,
      html[data-native-quick-ask] .main-header,
      html[data-native-quick-ask] .composer-disclaimer,
      html[data-native-quick-ask] .inapp-browser-fab { display: none !important; }
      html[data-native-quick-ask] .claude-app { --sidebar-width: 0px !important; }
      html[data-native-quick-ask] .claude-main { margin: 0 !important; width: 100%; min-width: 0; }
      html[data-native-quick-ask] .input-container { margin-block: 4px; }
      html[data-native-quick-ask] .chat-input { max-height: 120px; }
    `;
    document.documentElement.appendChild(style);
    return true;
  };
  if (!install()) {
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    observer.observe(document, { childList: true });
  }
})();
