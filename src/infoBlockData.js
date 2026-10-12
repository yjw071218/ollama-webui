const aliases = { statistics:'stats', metrics:'stats', kpi:'stats', stat:'stats', comparison:'compare', 'image-list':'media', imagelist:'media', list:'media', bars:'progress', dashboard:'panel' };
const types = new Set(['stats','steps','timeline','compare','progress','cards','proscons','funnel','callout','media','chart','panel']);
// Repair trailing commas outside strings only; never evaluate generated code.
export function cleanInfoJson(source) {
  const text = String(source).trim().replace(/^```(?:json|infographic)?\s*/i, '').replace(/\s*```$/, '');
  let out = '', quoted = false, escape = false;
  for (let i=0;i<text.length;i++) {
    const c=text[i];
    if (quoted) { out+=c; if(escape) escape=false; else if(c==='\\') escape=true; else if(c==='"') quoted=false; continue; }
    if(c==='"') quoted=true;
    if(c===',' && /^\s*[}\]]/.test(text.slice(i+1))) continue;
    out+=c;
  }
  return out;
}
export const safeSourceUrl = value => {
  try { const u = new URL(String(value)); return /^(https?:)$/.test(u.protocol) ? u.href : ''; } catch { return ''; }
};
export function parseInfoBlocks(source) {
  let data;
  try { data = JSON.parse(cleanInfoJson(source)); } catch { return null; }
  const normalize = (b, depth = 0) => {
    if (!b || typeof b !== 'object' || depth > 3) return null;
    const raw = String(b.type || b.kind || (b.blocks ? 'panel' : '')).toLowerCase();
    const type = aliases[raw] || raw;
    if (!types.has(type)) return null;
    const items = Array.isArray(b.items) ? b.items : Array.isArray(b.data) ? b.data : [];
    const result = { ...b, type, items: items.filter(x => x != null).slice(0, 30).map(it => typeof it === 'object' ? { ...it, text:it.text ?? it.description ?? it.body, label:it.label ?? it.title, image:it.image ?? it.imageUrl } : { title:String(it), label:String(it) }) };
    if (type === 'panel') { result.blocks = (Array.isArray(b.blocks) ? b.blocks : []).map(x => normalize(x, depth+1)).filter(Boolean); return result.blocks.length ? result : null; }
    if (type === 'chart') return b.chart || b.labels || b.series ? result : null;
    if (type === 'compare') { result.columns = (Array.isArray(b.columns) ? b.columns : []).filter(c => c && typeof c === 'object'); return result.columns.length >= 2 ? result : null; }
    if (type === 'proscons') return [...(Array.isArray(b.pros) ? b.pros : []), ...(Array.isArray(b.cons) ? b.cons : [])].length ? result : null;
    if (type === 'callout') return b.text || b.title ? result : null;
    return result.items.length ? result : null;
  };
  if (!data || typeof data !== 'object') return null;
  const sections = data.blocks || data.sections;
  const blocks = (Array.isArray(data) ? data : Array.isArray(sections) && (!data.type || data.type === 'infographic') ? sections : [data]).map(b => normalize(b)).filter(Boolean);
  return blocks.length ? { title: !data.type ? data.title || '' : '', subtitle: data.subtitle || '', sources:data.sources, blocks } : null;
}
