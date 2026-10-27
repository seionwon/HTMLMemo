import {HELP_GROUPS,HELP_TOPICS} from './help-content.js';
import {escapeHTML as esc,icon} from './utils.js';
import {APP_VERSION} from './version.js';

const byId=new Map(HELP_TOPICS.map(topic=>[topic.id,topic]));
const groupTitle=id=>HELP_GROUPS.find(group=>group.id===id)?.title||'';
const normalize=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/\s+/gu,' ').trim();
const termsFor=query=>[...new Set(normalize(String(query||'').slice(0,200)).split(/[\s,"“”‘’]+/u).filter(Boolean))].slice(0,12);
function readableSection(section){return [section.title,...section.paragraphs||[],...(section.steps||[]).flatMap(step=>[step.title,step.text]),...section.bullets||[],section.notice?.title,section.notice?.text,...section.table?.headings||[],...(section.table?.rows||[]).flat()].filter(Boolean).join(' ');}
const index=HELP_TOPICS.map(topic=>{
  const body=[topic.summary,...topic.sections.map(readableSection)].join(' ');
  return {topic,body,title:normalize(topic.title),keywords:normalize(topic.keywords),summary:normalize(topic.summary),text:normalize([groupTitle(topic.group),topic.title,topic.keywords,body].join(' '))};
});

export function searchHelp(query=''){
  const terms=termsFor(query),phrase=normalize(query);
  return index.filter(entry=>terms.every(term=>entry.text.includes(term))).map(entry=>{
    const positions=terms.map(term=>normalize(entry.body).indexOf(term)).filter(position=>position>=0),at=positions.length?Math.min(...positions):0,start=Math.max(0,at-45);
    return {topic:entry.topic,snippet:(start?'…':'')+entry.body.slice(start,start+160)+(entry.body.length>start+160?'…':''),score:(phrase&&entry.title===phrase?100:0)+terms.reduce((score,term)=>score+(entry.title.includes(term)?20:0)+(entry.keywords.includes(term)?8:0)+(entry.summary.includes(term)?4:0),0)};
  }).sort((a,b)=>b.score-a.score);
}
export function highlightHelp(text,query=''){
  const terms=termsFor(query).sort((a,b)=>b.length-a.length);if(!terms.length)return esc(text);
  const pattern=new RegExp(terms.map(term=>term.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'giu');
  let result='',cursor=0;const source=String(text||'');
  for(const match of source.matchAll(pattern)){result+=esc(source.slice(cursor,match.index))+'<mark>'+esc(match[0])+'</mark>';cursor=match.index+match[0].length;}
  return result+esc(source.slice(cursor));
}

export function openHelp({modal,onBack=()=>{},onClose=()=>{}}){
  let selected=HELP_TOPICS[0].id,query='',results=false;
  modal(`<section class="help-browser" aria-label="HTMLMemo 도움말"><header class="help-header"><button id="help-back-settings" type="button" class="text-button">${icon('back',16)} 설정</button><h2>HTMLMemo 도움말</h2><button type="button" class="icon-button" data-dialog-close aria-label="도움말 닫기">${icon('close')}</button></header><div class="help-search-area"><label for="help-search">도움말 검색</label><div class="help-search-field">${icon('search',18)}<input id="help-search" type="search" maxlength="200" autocomplete="off" placeholder="예: 동기화, 북마크, 데이터 복원"><button id="help-search-clear" type="button" class="icon-button" aria-label="검색어 지우기" hidden>${icon('close',16)}</button></div><p id="help-search-status" role="status" aria-live="polite"></p></div><label class="help-mobile-picker" for="help-topic-select">항목 바로가기<select id="help-topic-select" aria-label="도움말 항목 선택"></select></label><div class="help-layout"><nav id="help-nav" aria-label="도움말 목차"></nav><div id="help-content" class="help-content" tabindex="-1"></div></div><footer class="help-footer">HTMLMemo ${esc(APP_VERSION)} · 도움말 제목과 본문에서 검색합니다.</footer></section>`,dialog=>{
    const root=dialog.querySelector('.help-browser'),q=selector=>root.querySelector(selector),content=q('#help-content'),search=q('#help-search'),picker=q('#help-topic-select');
    dialog.onclose=onClose;q('#help-back-settings').onclick=onBack;
    const text=value=>highlightHelp(value,query);
    const choose=(id,{clear=false}={})=>{
      if(!byId.has(id))return;selected=id;results=false;
      if(clear){query='';search.value='';}
      render();q('#help-article-title')?.focus({preventScroll:true});
    };
    const clear=()=>{query='';search.value='';results=false;render();search.focus();};
    const sectionHTML=section=>`<section class="help-section"><h4>${text(section.title)}</h4>${(section.paragraphs||[]).map(paragraph=>`<p>${text(paragraph)}</p>`).join('')}${section.steps?`<ol class="help-steps">${section.steps.map(step=>`<li><strong>${text(step.title)}</strong><p>${text(step.text)}</p></li>`).join('')}</ol>`:''}${section.bullets?`<ul class="help-bullets">${section.bullets.map(item=>`<li>${text(item)}</li>`).join('')}</ul>`:''}${section.table?`<div class="help-table-scroll"><table><thead><tr>${section.table.headings.map(heading=>`<th scope="col">${text(heading)}</th>`).join('')}</tr></thead><tbody>${section.table.rows.map(row=>`<tr>${row.map((cell,i)=>i?`<td>${text(cell)}</td>`:`<th scope="row">${text(cell)}</th>`).join('')}</tr>`).join('')}</tbody></table></div>`:''}${section.notice?`<aside class="help-note" data-tone="${esc(section.notice.tone)}"><strong>${text(section.notice.title)}</strong><p>${text(section.notice.text)}</p></aside>`:''}</section>`;
    function render(){
      const matches=searchHelp(query),ids=new Set(matches.map(entry=>entry.topic.id)),navigation=q('#help-nav'),scroll=navigation.scrollTop;
      q('#help-search-clear').hidden=!query;
      q('#help-search-status').textContent=query?`검색 결과 ${matches.length}개`:`따라 하기 · 기능별 안내 · 데이터 보관 · 문제 해결 ${HELP_TOPICS.length}편`;
      q('#help-nav').innerHTML=HELP_GROUPS.map(group=>{
        const topics=HELP_TOPICS.filter(topic=>topic.group===group.id&&ids.has(topic.id));
        return topics.length?`<section class="help-nav-group"><h3>${esc(group.title)}</h3>${topics.map(topic=>`<button type="button" data-help-open="${topic.id}"${!results&&selected===topic.id?' aria-current="page"':''}>${text(topic.title)}</button>`).join('')}</section>`:'';
      }).join('')||'<p class="help-nav-empty">다른 검색어로 찾아보세요.</p>';
      navigation.scrollTop=scroll;
      const current=navigation.querySelector('[aria-current="page"]');
      if(current&&navigation.clientHeight){const top=current.offsetTop,bottom=top+current.offsetHeight;if(top<navigation.scrollTop)navigation.scrollTop=Math.max(0,top-8);else if(bottom>navigation.scrollTop+navigation.clientHeight)navigation.scrollTop=bottom-navigation.clientHeight+8;}
      picker.innerHTML='<option value="">항목을 선택하세요</option>'+HELP_GROUPS.map(group=>{
        const topics=HELP_TOPICS.filter(topic=>topic.group===group.id&&ids.has(topic.id));
        return topics.length?`<optgroup label="${esc(group.title)}">${topics.map(topic=>`<option value="${topic.id}">${esc(topic.title)}</option>`).join('')}</optgroup>`:'';
      }).join('');picker.disabled=!matches.length;picker.value=!results&&ids.has(selected)?selected:'';
      if(query&&results){
        content.innerHTML=`<section class="help-results" aria-labelledby="help-results-title"><h3 id="help-results-title">${matches.length?'검색 결과':'검색 결과가 없습니다'}</h3><p>${matches.length?'항목을 선택하면 자세한 설명을 읽을 수 있습니다.':'단어를 줄이거나 다른 표현을 사용해 보세요. 예: 저장, 복원, 동기화'}</p>${matches.length?`<ul>${matches.map(({topic,snippet})=>`<li><button type="button" class="help-result" data-help-open="${topic.id}"><span class="help-eyebrow">${esc(groupTitle(topic.group))}</span><strong>${text(topic.title)}</strong><span class="help-result-snippet">${text(snippet)}</span></button></li>`).join('')}</ul>`:'<button id="help-empty-clear" type="button" class="secondary-button">검색어 지우고 목차 보기</button>'}</section>`;
      }else{
        const topic=byId.get(selected)||HELP_TOPICS[0],visible=matches.map(entry=>entry.topic),at=visible.findIndex(item=>item.id===topic.id),previous=visible[at-1],next=visible[at+1];
        content.innerHTML=`<article class="help-article">${query?`<button type="button" id="help-results-back" class="text-button">${icon('back',15)} 검색 결과로</button>`:''}<p class="help-eyebrow">${esc(groupTitle(topic.group))}</p><h3 id="help-article-title" tabindex="-1">${text(topic.title)}</h3><p class="help-lead">${text(topic.summary)}</p>${topic.sections.map(sectionHTML).join('')}${topic.related?.length?`<aside class="help-related"><h4>이어서 보기</h4><div>${topic.related.map(id=>`<button type="button" class="text-button" data-help-related="${esc(id)}">${esc(byId.get(id)?.title||'')}</button>`).join('')}</div></aside>`:''}${topic.references?.length?`<details class="help-references"><summary>공식 참고 자료 · 인터넷 연결 시 열기</summary><ul>${topic.references.filter(ref=>/^https:\/\//.test(ref.url)).map(ref=>`<li><a href="${esc(ref.url)}" target="_blank" rel="noopener noreferrer">${esc(ref.label)} ${icon('external',12)}</a></li>`).join('')}</ul></details>`:''}<nav class="help-page-nav" aria-label="이전과 다음 도움말">${previous?`<button type="button" class="secondary-button" data-help-open="${previous.id}">← 이전 안내<span>${esc(previous.title)}</span></button>`:'<span></span>'}${next?`<button type="button" class="secondary-button" data-help-open="${next.id}">다음 안내 →<span>${esc(next.title)}</span></button>`:'<span></span>'}</nav></article>`;
      }
      root.querySelectorAll('[data-help-open]').forEach(button=>button.onclick=()=>choose(button.dataset.helpOpen));
      root.querySelectorAll('[data-help-related]').forEach(button=>button.onclick=()=>choose(button.dataset.helpRelated,{clear:true}));
      const back=q('#help-results-back');if(back)back.onclick=()=>{results=true;render();search.focus();};
      const emptyClear=q('#help-empty-clear');if(emptyClear)emptyClear.onclick=clear;
      content.scrollTop=0;
    }
    const find=()=>{query=search.value.slice(0,200).trim();results=!!query;render();};
    search.oninput=event=>{if(!event.isComposing)find();};search.oncompositionend=find;search.onsearch=find;q('#help-search-clear').onclick=clear;
    picker.onchange=()=>choose(picker.value);
    root.onkeydown=event=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'){event.preventDefault();event.stopPropagation();search.focus();search.select?.();return;}
      if(event.key==='Escape'&&query){event.preventDefault();event.stopPropagation();clear();return;}
      if(event.key==='ArrowDown'&&event.target===search&&results){const first=q('#help-results-title')&&q('.help-results [data-help-open]');if(first){event.preventDefault();first.focus();}}
    };
    render();q('#help-article-title')?.focus({preventScroll:true});
  });
}
