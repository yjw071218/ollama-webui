import React, { useMemo, useRef, useState } from 'react';
import { buildChatOffice, parseChatOffice } from './chatOffice.js';

export default function ChatOfficeCard({ source }) {
  const parsed = useMemo(() => { try { return { document: parseChatOffice(source) }; } catch (error) { return { error: error.message }; } }, [source]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  if (!parsed.document) return <section className="tool-block"><p role="status">문서 내용을 받는 중입니다. 응답이 끝난 뒤에도 파일이 표시되지 않으면 다시 생성을 요청해 주세요.</p><details><summary>문서 상태</summary>{parsed.error}</details></section>;
  const doc = parsed.document;
  const download = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const bytes = await buildChatOffice(doc);
      const { downloadOffice } = await import('./officeEditing.js');
      downloadOffice(bytes, doc.title, doc.format);
    } catch (e) { setError(e.message); }
    finally { lock.current = false; setBusy(false); }
  };
  return <section className="tool-block" aria-label="대화에서 만든 오피스 문서" style={{ padding: 16 }}>
    <strong>{doc.title}</strong>
    <p>{doc.format.toUpperCase()} · {doc.slides ? `${doc.slides.length}개 슬라이드` : doc.sheets ? `${doc.sheets.length}개 시트` : '문서'}</p>
    <button type="button" disabled={busy} onClick={download}>{busy ? '파일 만드는 중…' : `${doc.format.toUpperCase()} 다운로드`}</button>
    {error && <p role="alert">{error} 다시 다운로드를 누르면 재시도합니다.</p>}
    <details><summary>내용 미리보기</summary>
      {doc.slides ? doc.slides.map((s,i) => <div key={i}><h4>{i+1}. {s.title}</h4><p style={{ whiteSpace:'pre-wrap' }}>{s.body}</p>{s.items.map((v,j)=><p key={j}>{v.title}: {v.body}</p>)}</div>)
        : doc.sheets ? doc.sheets.map((s,i)=><div key={i}><h4>{s.name}</h4><pre style={{ overflow:'auto' }}>{s.rows.slice(0,20).map(row=>row.join('\t')).join('\n')}</pre></div>)
        : <p style={{ whiteSpace:'pre-wrap' }}>{doc.text}</p>}
    </details>
  </section>;
}
