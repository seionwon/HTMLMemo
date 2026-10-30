import {markdownit} from '../vendor/markdown-it.js';
import {escapeHTML} from './utils.js';

function markdownURL(value,source) {
  if(value.startsWith('#'))return value;
  try{
    const url=new URL(value.startsWith('//')?'https:'+value:value,source||undefined);
    return ['http:','https:','mailto:','tel:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null;
  }catch{return null;}
}
// One offline parser; each document gets its own heading IDs and link state.
const parser=markdownit({html:false,breaks:true,linkify:false,typographer:false,maxNesting:32});
parser.renderer.rules.link_open=(tokens,index,options,env,self)=>{
  const token=tokens[index];let href=markdownURL(token.attrGet('href')||'',env.source);
  if(href?.startsWith('#'))try{const id=env.headings.get(decodeURIComponent(href.slice(1)));if(id)href='#'+encodeURIComponent(id);}catch{/* A malformed fragment remains inert navigation text. */}
  env.links.push(!!href);if(!href)return '<span>';
  token.attrSet('href',href);token.attrSet('rel','noopener noreferrer');
  return self.renderToken(tokens,index,options);
};
parser.renderer.rules.link_close=(tokens,index,options,env)=>env.links.pop()?'</a>':'</span>';
parser.renderer.rules.image=(tokens,index,options,env,self)=>{
  const token=tokens[index],src=token.attrGet('src')||'',alt=self.renderInlineAsText(token.children||[],options,env),label=escapeHTML(alt||'이미지');
  if(/^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z\d+/=\s]+$/i.test(src))return '<img src="'+escapeHTML(src)+'" alt="'+escapeHTML(alt)+'">';
  const href=markdownURL(src,env.source);
  // External images remain useful offline as links, without broken image boxes
  // or an implicit request to a third-party server. Respect an enclosing link.
  if(href&&/^https?:/i.test(href)&&!env.links.some(Boolean))return '<a class="markdown-image-link" href="'+escapeHTML(href)+'" rel="noopener noreferrer">'+label+' (이미지)</a>';
  return label;
};

export function renderMarkdown(text,source='') {
  const env={source,links:[],headings:new Map()},tokens=parser.parse(text,env),ids=new Set(),nextSuffix=new Map();let heading='';
  // The parser stops block parsing at its nesting limit. Preserve all input
  // rather than silently omitting the remainder of an unusually deep block.
  if(tokens.some(token=>token.level>=31))return {html:'<p>'+escapeHTML(text).replace(/\r\n?/g,'\n').replace(/\n/g,'<br>\n')+'</p>',heading:''};
  for(let i=0;i<tokens.length;i++)if(tokens[i].type==='heading_open'){
    const label=parser.renderer.renderInlineAsText(tokens[i+1]?.children||[],parser.options,env).trim();
    if(!heading)heading=label;
    const base=Array.from(label.toLowerCase().replace(/[^\p{L}\p{N}\p{M}_\s-]/gu,'').trim().replace(/\s+/g,'-')).slice(0,100).join('')||'section';
    let n=nextSuffix.get(base)||0,alias=n?base+'-'+n:base;while(ids.has(alias))alias=base+'-'+(++n);ids.add(alias);nextSuffix.set(base,n+1);
    const id='md-'+alias;env.headings.set(alias,id);tokens[i].attrSet('id',id);
  }
  for(let i=2;i<tokens.length;i++)if(tokens[i].type==='inline'&&tokens[i-1].type==='paragraph_open'&&tokens[i-2].type==='list_item_open'){
    const first=tokens[i].children?.[0];
    if(first?.type==='text'&&/^\[[ xX]\]\s+/.test(first.content)){
      first.content=first.content.replace(/^\[([ xX])\]\s+/,(_,mark)=>mark===' '?'☐ ':'☑ ');tokens[i-2].attrSet('class','markdown-task');
    }
  }
  return {html:parser.renderer.render(tokens,parser.options,env),heading};
}
