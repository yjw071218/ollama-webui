import { officePrompt, parseOfficeProposal } from './officeDesign.js';

const modes = { pptx:'pptx', ppt:'pptx', odp:'pptx', xlsx:'xlsx', xls:'xlsx', ods:'xlsx', csv:'xlsx', tsv:'xlsx', docx:'docx', doc:'docx', odt:'docx', rtf:'docx', txt:'docx', hwpx:'hwpx', hwp:'hwpx' };
export function parseChatOffice(source) {
  if (source.length > 2000000) throw new Error('문서 내용이 너무 큽니다. 문서를 나누어 요청해 주세요.');
  const value = JSON.parse(source);
  const format = String(value?.format || '').toLowerCase();
  if (!Object.hasOwn(modes, format)) throw new Error('지원하지 않는 문서 형식입니다.');
  return { format, mode: modes[format], ...parseOfficeProposal(JSON.stringify(value), modes[format]) };
}

export const CHAT_OFFICE_GUIDE = `
Office documents in chat
When asked to create a PowerPoint presentation, Excel spreadsheet, Word or Hangul document, produce the complete document directly in this conversation as a fenced office JSON block. The app renders it as a downloadable document card; the user does not need to open the Office editor. Do not merely give instructions or claim to have saved a file on disk. The card creates the file when Download is pressed.
Use a top-level "format" field: pptx (default presentation), ppt, odp, xlsx (default spreadsheet), xls, ods, csv, tsv, docx (default word processing), doc, odt, rtf, txt, hwpx or hwp. Prefer modern formats unless the user requests another. Legacy formats may require the server conversion engine.
Use the conversation and provided source material to build complete content. For revisions, return a complete replacement office block. Never invent factual figures; clearly label hypothetical examples.
Presentation schema and design rules: ${officePrompt('pptx', '', '')[0].content}
Spreadsheet schema and rules: ${officePrompt('xlsx', '', '')[0].content}
Word/Hangul schema: {"format":"docx","title":"Document title","text":"Complete body with newline-separated paragraphs"}.
The schemas above go INSIDE a fenced office block, not a json block. Include format in every block. Brief prose outside the block is allowed. Example:
\`\`\`office
{"format":"xlsx","title":"Budget example","sheets":[{"name":"Budget","rows":[["Item","Amount"],["Example",10],["Total","=SUM(B2:B2)"]]}]}
\`\`\`
`;

export async function buildChatOffice(document) {
  const office = await import('./officeEditing.js');
  let bytes;
  if (document.mode === 'xlsx') return office.writeWorkbook(await office.createWorkbook(document.sheets), document.format);
  if (document.mode === 'pptx') bytes = await office.createPresentation(document.slides, document.title);
  else if (document.mode === 'hwpx') bytes = await office.createHangul(document.text);
  else bytes = office.createWord(document.text, document.title);
  return office.convertOfficeBytes(bytes, document.mode, document.format);
}
