// Bibliographic records, not generated citations. No user-controlled host.
export const academicQuery = text => /논문|학술|선행\s*연구|연구\s*(자료|결과)|\b(papers?|doi|scholarly|peer.review|journal|bibliograph\w*)\b/i.test(String(text));
const clean = value => String(value || '').replace(/<[^>]*>/g, '').slice(0, 4000);
export function scholarlyRecord(work) {
  if (!work || !/^10\.\d{4,9}\/\S+$/i.test(work.DOI || '') || !Array.isArray(work.title) || !work.title[0]) return null;
  const authors = (Array.isArray(work.author) ? work.author : []).map(a => [a.given,a.family].filter(Boolean).join(' ') || a.name).filter(Boolean);
  const year = work.published?.['date-parts']?.[0]?.[0] || work.issued?.['date-parts']?.[0]?.[0] || null;
  return { title:clean(work.title[0]), url:`https://doi.org/${encodeURI(work.DOI)}`, doi:work.DOI, authors, year,
    journal:clean(work['container-title']?.[0]), bibliographicVerified:true,
    snippet:[authors.join(', '),year,clean(work['container-title']?.[0]),`DOI: ${work.DOI}`,work.abstract ? `Abstract: ${clean(work.abstract)}` : 'Metadata only; findings and full text have not been verified.'].filter(Boolean).join(' · ') };
}
export async function searchScholarly(query, { fetcher = fetch, limit = 5 } = {}) {
  const doi = String(query).match(/\b10\.\d{4,9}\/[^\s<>"\]]+/i)?.[0]?.replace(/[.,;]+$/, '');
  const url = new URL(doi ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` : 'https://api.crossref.org/works');
  if (!doi) { url.searchParams.set('query.bibliographic', String(query).slice(0, 500)); url.searchParams.set('rows', String(Math.max(1, Math.min(8, Number(limit) || 5)))); }
  const response = await fetcher(url, { signal:AbortSignal.timeout(12000), headers:{ Accept:'application/json', 'User-Agent':'OllamaWebUI/2 (bibliographic lookup)' } });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Bibliographic lookup failed (${response.status})`);
  const data = await response.json();
  return (doi ? [data.message] : data.message?.items || []).map(scholarlyRecord).filter(Boolean);
}
