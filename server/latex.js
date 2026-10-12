import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile);
const commands=new Set(('documentclass usepackage begin end title author date maketitle tableofcontents section subsection subsubsection paragraph chapter part textbf textit texttt emph underline textcolor color colorbox fcolorbox pagecolor fontsize selectfont tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge centering raggedright raggedleft flushleft flushright noindent indent par newline linebreak newpage clearpage vspace hspace vfill hfill quad qquad item label ref pageref cite footnote url href caption multicolumn hline cline toprule midrule bottomrule cmidrule addlinespace textwidth linewidth columnwidth baselineskip rule setlength geometry pagestyle thispagestyle fancyhf fancyhead fancyfoot thepage today thanks abstract and appendix setmainfont setsansfont setmonofont setmainhangulfont setsanshangulfont frac dfrac tfrac sqrt sum prod int iint iiint lim log ln exp sin cos tan alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega infty partial nabla cdot times div pm mp leq geq neq approx equiv sim simeq propto in notin subset subseteq supset supseteq cup cap forall exists neg land lor to rightarrow leftarrow Rightarrow Leftarrow iff implies mapsto ldots cdots vdots ddots left right big Big bigg Bigg overline bar hat vec dot ddot tilde widehat widetilde underbrace overbrace mathbb mathcal mathbf mathrm mathit mathsf mathtt operatorname text boxed binom dbinom pmod mod bmod vert Vert lvert rvert lVert rVert langle rangle lfloor rfloor lceil rceil min max arg det dim gcd limits nolimits nonumber notag tag eqref substack overset underset stackrel boldsymbol phantom hphantom vphantom ensuremath setcounter addtocounter enumerate itemize description frame frametitle framesubtitle pause alert columns column centering raggedright').split(' '));
const packages=new Set('amsmath amssymb geometry xcolor graphicx hyperref booktabs array longtable multicol enumitem fancyhdr titlesec fontspec kotex'.split(' '));
const environments=new Set('document abstract center flushleft flushright itemize enumerate description quote quotation verse tabular tabular* longtable table table* figure figure* minipage multicols equation equation* align align* aligned gather gather* gathered multline multline* split cases matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix array displaymath math frame columns column'.split(' '));
export function validateLatex(source){
 if(typeof source!=='string'||source.length>200000||!source.trim().startsWith('\\documentclass'))throw new Error('완전한 LaTeX 문서가 필요합니다 (최대 200,000자).');
 if(source.includes('^^')||source.includes('\0'))throw new Error('LaTeX 문자 재해석은 지원하지 않습니다.');
 // Only literal commands from the documented rendering subset; no macro construction or I/O.
 const text=source.replace(/(?<!\\)%[^\n]*/g,'');
 for(const match of text.matchAll(/\\([a-zA-Z@]+|[^a-zA-Z])/g)){
   if(!commands.has(match[1])&&!['\\','%','&','$','#','_','{','}',' ', ',',';',':','!','(',')','[',']'].includes(match[1]))throw new Error('지원하지 않는 LaTeX 명령: '+match[0]);
 }
 for(const match of text.matchAll(/\\(documentclass|usepackage|begin|end)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g)){
   const values=match[2].split(',').map(v=>v.trim());
   const allowed=match[1]==='documentclass'?new Set(['article','report','book','beamer']):match[1]==='usepackage'?packages:environments;
   if(values.some(v=>!allowed.has(v)))throw new Error('지원하지 않는 LaTeX 패키지 또는 환경: '+match[2]);
 }
 // A missing literal argument must not be interpreted as a constructed file/class name.
 for(const match of text.matchAll(/\\(?:documentclass|usepackage|begin|end)\b/g))if(!/^\\\w+\s*(?:\[[^\]]*\]\s*)?\{[a-zA-Z*, ]+\}/.test(text.slice(match.index)))throw new Error('패키지·환경 이름을 직접 지정해 주세요.');
 return source;
}
let running=false;
export async function compileLatex(source){
 validateLatex(source);if(running)throw new Error('다른 PDF를 만드는 중입니다. 잠시 후 다시 시도해 주세요.');running=true;
 let directory;
 try{
  directory=await fs.mkdtemp(path.join(os.tmpdir(),'webui-latex-'));
  await fs.writeFile(path.join(directory,'document.tex'),source,'utf8');
  const bundled=fileURLToPath(new URL('../native/.tools/tectonic/tectonic.exe',import.meta.url));
  const executable=process.env.TECTONIC_PATH||(process.platform==='win32'?bundled:'tectonic');
  await execute(executable,['-X','compile','--untrusted','--outdir',directory,path.join(directory,'document.tex')],{cwd:directory,windowsHide:true,timeout:300000,maxBuffer:256*1024,env:{...process.env,TECTONIC_UNTRUSTED_MODE:'1'}});
  const data=await fs.readFile(path.join(directory,'document.pdf'));
  if(data.length>50*1024*1024)throw new Error('PDF가 50 MB를 초과했습니다.');
  return {data:data.toString('base64'),format:'pdf'};
 }catch(e){throw new Error(e.code==='ENOENT'?'서버에 Tectonic이 없습니다. scripts/setup-latex.ps1을 실행해 주세요.':`LaTeX PDF 생성 실패: ${String(e.stderr||e.stdout||e.message).slice(-2000)}`);}
 finally{running=false;if(directory&&path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('webui-latex-'))await fs.rm(directory,{recursive:true,force:true}).catch(()=>{});}
}
