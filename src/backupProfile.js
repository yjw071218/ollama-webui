// Move one explicitly selected backup profile into the current account.
// Never import login credentials, sync cursors, or other accounts' preferences.
import { isScopedSetting } from './settingsStore.js';
const prefix = 'ollama-sessions';
export const backupProfiles = backup => Object.entries(backup.sessions || {})
  .filter(([key, value]) => (key === prefix || key.startsWith(prefix + ':')) && Array.isArray(value))
  .map(([key, value]) => ({ key, chats: value.length }));
export function backupForProfile(backup, sourceKey, targetKey) {
  if (!backupProfiles(backup).some(p => p.key === sourceKey)) throw new Error('복원할 계정의 대화 저장소를 찾을 수 없습니다.');
  const scope = key => key === prefix ? '' : key.slice(prefix.length + 1);
  const source = scope(sourceKey), target = scope(targetKey);
  const settings = {};
  const browserWide = Object.keys(backup.settings || {}).some(key => key.includes('@'));
  if (targetKey !== prefix && !targetKey.startsWith(prefix + ':')) throw new Error('Invalid destination profile');
  for (const [raw, value] of Object.entries(backup.settings || {})) {
    const at = raw.lastIndexOf('@');
    // Scoped exports use bare names; old browser-wide exports carry @scope.
    const key = at < 0 ? raw : raw.slice(0, at);
    if (at >= 0 && raw.slice(at + 1) !== source) continue;
    if (isScopedSetting(key) && !key.includes(':') && !(source && browserWide && at < 0)) {
      if (!(key in settings) || at >= 0) settings[key] = value;
    }
    for (const list of ['chatFolders', 'samplingPresets', 'systemPrompts', 'userProfile']) {
      if (raw === list + (source ? ':' + source : ''))
        settings[list + (target ? ':' + target : '')] = value;
    }
  }
  const remap = (store, kind) => {
    const key = kind + ':' + (source || 'guest');
    return Object.hasOwn(store || {}, key) ? { [kind + ':' + (target || 'guest')]: store[key] } : {};
  };
  return { ...backup, primaryKey: targetKey, settings,
    sessions: { [targetKey]: backup.sessions[sourceKey] },
    knowledge: remap(backup.knowledge, 'knowledge'), memory: remap(backup.memory, 'memory') };
}
