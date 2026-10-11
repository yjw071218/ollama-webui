import React from 'react';
import {createRoot} from 'react-dom/client';
import Mermaid from '../../src/Mermaid.jsx';
import OfficeEditor from '../../src/OfficeEditor.jsx';
import ChatOfficeCard from '../../src/ChatOfficeCard.jsx';
import * as office from '../../src/officeEditing.js';
import * as design from '../../src/officeDesign.js';
import '../../src/extras.css';
import '../../src/motion.css';
const root=createRoot(document.getElementById('test'));
window.officeTest={...office,...design,
 chatDocument:source=>root.render(<ChatOfficeCard source={source}/>),
 diagram:()=>root.render(<div style={{width:'100%',maxWidth:900}}><Mermaid source={'flowchart LR\n A["시작"] --> B["검토"] --> C["완료"]'}/></div>),
 editor:()=>root.render(<OfficeEditor scope="office-test" seed={{title:'테스트'}} model="test-model" onClose={()=>{}}/>),
};
