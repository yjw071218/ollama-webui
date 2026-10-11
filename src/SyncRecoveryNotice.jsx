import React, { useEffect, useState } from 'react';
import localforage from 'localforage';

export default function SyncRecoveryNotice({ scope }) {
  const [copies, setCopies] = useState([]);
  useEffect(() => {
    let active = true;
    const read = async () => {
      const found = [];
      await localforage.iterate((value, key) => { if (key.startsWith(`sync-recovery:${scope}:`)) found.push(value); });
      if (active) setCopies(found);
    };
    void read();
    window.addEventListener('webui-sync-recovery', read);
    return () => { active = false; window.removeEventListener('webui-sync-recovery', read); };
  }, [scope]);
  if (!copies.length) return null;
  return <aside className="sync-recovery-notice" role="status">
    오래된 기기의 로컬 작업을 복구 사본 {copies.length}개에 보관했습니다.
    <button onClick={() => {
      const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'webui-sync-recovery-v1', copies }, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'webui-sync-recovery.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }}>복구 사본 다운로드</button>
    <button onClick={() => setCopies([])} aria-label="복구 안내 닫기">닫기</button>
  </aside>;
}
