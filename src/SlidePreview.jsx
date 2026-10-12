import React from 'react';
import {slideScene} from './officeDesign.js';
export function SlidePreview({slide,index=0}) {
  return <svg className="office-slide-preview" viewBox="0 0 1333.3 750" role="img" aria-label={`슬라이드 ${index+1} 디자인 미리보기`}>
    {slideScene(slide,index+1).map((s,i)=>s.type==='image'?<image key={i} href={s.src} x={s.x*100} y={s.y*100} width={s.w*100} height={s.h*100} preserveAspectRatio="none"/>:s.type==='ellipse'?<ellipse key={i} cx={(s.x+s.w/2)*100} cy={(s.y+s.h/2)*100} rx={s.w*50} ry={s.h*50} fill={'#'+s.fill}/>:s.type==='rect'?<rect key={i} x={s.x*100} y={s.y*100} width={s.w*100} height={s.h*100} fill={'#'+s.fill}/>:<foreignObject key={i} x={s.x*100} y={s.y*100} width={s.w*100} height={s.h*100}><div xmlns="http://www.w3.org/1999/xhtml" style={{color:'#'+s.color,fontSize:s.size*100/72,fontWeight:s.bold?700:400,fontFamily:'맑은 고딕, sans-serif',lineHeight:1.2,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{s.text}</div></foreignObject>)}
  </svg>;
}
