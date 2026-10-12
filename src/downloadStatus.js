// Native download events and browser exports share one accessible status tray.
const entries = new Map();
let tray;
export function reportDownload(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('ollama-download', {detail}));
}
if (typeof window !== 'undefined') window.addEventListener('ollama-download', event => {
  const d = event.detail;
  if (!d || !d.id) return;
  if (!tray || !tray.isConnected) {
    tray = document.createElement('aside'); tray.className='download-tray'; tray.setAttribute('aria-label','다운로드 현황');
    document.body.appendChild(tray);
  }
  let row=entries.get(d.id);
  if (!row || !row.isConnected) {
    row=document.createElement('div'); row.className='download-entry';
    const label=document.createElement('strong'), status=document.createElement('span'), progress=document.createElement('progress'), close=document.createElement('button');
    status.setAttribute('role','status'); close.textContent='×'; close.setAttribute('aria-label','현황 닫기');
    close.onclick=()=>{row.remove();entries.delete(d.id);};
    row.append(label,status,progress,close);tray.prepend(row);entries.set(d.id,row);
    if(entries.size>8){const [id,old]=entries.entries().next().value;old.remove();entries.delete(id);}
  }
  const [label,status,progress]=row.children;
  label.textContent=d.name||'파일';
  const states={preparing:'파일 만드는 중…',saving:'저장 위치 선택·저장 중…',progress:'다운로드 중…',completed:'저장 완료',cancelled:'저장 취소',failed:'저장 실패',handedOff:'브라우저로 다운로드 전달'};
  status.textContent=d.error||states[d.state]||d.state;
  progress.hidden=['completed','cancelled','failed','handedOff'].includes(d.state);
  if(d.total>0){progress.max=d.total;progress.value=d.received||0;status.textContent+=` ${Math.floor((d.received||0)/d.total*100)}%`;}else progress.removeAttribute('value');
});

if(typeof window!=='undefined')window.ollamaNative?.onDownload?.(reportDownload);
