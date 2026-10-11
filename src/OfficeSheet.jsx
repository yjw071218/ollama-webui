import React, { useState } from 'react';
import { utils } from 'xlsx';

export default function OfficeSheet({workbook,onChange}) {
  const [selected,setSelected]=useState(0),[row,setRow]=useState(0),[column,setColumn]=useState(0);
  const name=workbook.SheetNames[Math.min(selected,workbook.SheetNames.length-1)];
  const sheet=workbook.Sheets[name], range=utils.decode_range(sheet['!ref']||'A1');
  const update=(r,c,value)=>{
    const address=utils.encode_cell({r,c}), next={...sheet};
    const cell={...next[address]}; delete cell.w; delete cell.f; delete cell.h; delete cell.r;
    if(value==='') delete next[address];
    else {
      if(value.startsWith('=')) {cell.t='n';cell.f=value.slice(1);delete cell.v;}
      else if(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)&&!/^[-+]?0\d/.test(value)) {cell.t='n';cell.v=Number(value);}
      else {cell.t='s';cell.v=value;}
      next[address]=cell;
    }
    next['!ref']=utils.encode_range({s:{r:Math.min(range.s.r,r),c:Math.min(range.s.c,c)},e:{r:Math.max(range.e.r,r),c:Math.max(range.e.c,c)}});
    onChange({...workbook,Sheets:{...workbook.Sheets,[name]:next}});
  };
  return <div className="office-sheet">
    <nav aria-label="워크시트">
      {workbook.SheetNames.map((n,i)=><button key={n} aria-pressed={n===name} onClick={()=>{setSelected(i);setRow(0);setColumn(0);}}>{n}</button>)}
      <button onClick={()=>{let n=`Sheet${workbook.SheetNames.length+1}`;while(workbook.Sheets[n])n+='_';onChange({...workbook,SheetNames:[...workbook.SheetNames,n],Sheets:{...workbook.Sheets,[n]:{'!ref':'A1'}}});setSelected(workbook.SheetNames.length);setRow(0);setColumn(0);}}>시트 추가</button>
    </nav>
    <p className="office-note">=로 시작하는 수식을 입력할 수 있습니다. 계산 결과는 Excel·LibreOffice에서 열 때 갱신됩니다. CSV·TSV는 첫 시트만 저장합니다. 복잡한 차트·피벗·매크로 보존은 지원하지 않습니다.</p>
    <nav><button disabled={row===0} onClick={()=>setRow(Math.max(0,row-30))}>이전 행</button><label>시작 행<input type="number" min="1" max="1048547" value={row+1} onChange={e=>setRow(Math.max(0,Math.min(1048546,Number(e.target.value)-1||0)))} /></label><button onClick={()=>setRow(Math.min(1048546,row+30))}>다음 행</button>
      <button disabled={column===0} onClick={()=>setColumn(Math.max(0,column-12))}>이전 열</button><span>{utils.encode_col(column)}–{utils.encode_col(column+11)}</span><button onClick={()=>setColumn(Math.min(16372,column+12))}>다음 열</button></nav>
    <div className="office-grid-scroll"><table><thead><tr><th>#</th>{Array.from({length:12},(_,c)=><th key={c}>{utils.encode_col(column+c)}</th>)}</tr></thead><tbody>
      {Array.from({length:30},(_,r)=><tr key={row+r}><th>{row+r+1}</th>{Array.from({length:12},(_,c)=>{const address=utils.encode_cell({r:row+r,c:column+c}),cell=sheet[address];return <td key={address}><input aria-label={`${name} ${address}`} value={cell?.f?'='+cell.f:String(cell?.v??'')} onChange={e=>update(row+r,column+c,e.target.value)} /></td>;})}</tr>)}
    </tbody></table></div>
  </div>;
}
