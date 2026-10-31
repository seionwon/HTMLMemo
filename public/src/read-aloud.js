// Ported from MemoSuite MemoReadAloud.tsx (UI) and readAloudRuntime.ts (browser engine).
// See docs/tts-source.md for provenance and the iframe/lifecycle adapters.
import {currentSection,textIndex,resolveTextAnchor,rangeFromOffsets} from './document.js';

// The imported HTML can itself contain an application shell. Read its prose pane,
// never its navigation, including navigation nested inside <main>.
const READING_CHROME = 'nav, aside, [role="navigation"], [role="complementary"], [role="menu"], [role="menubar"], [role="toolbar"], #htmlmemo-annotation-layer, .toc, #toc, .sidebar, #sidebar, .book-toc, #book-toc, .book-sidebar, #book-sidebar, .table-of-contents, #table-of-contents, [data-toc], [data-sidebar]';
export function isReadAloudChrome(element) { return !!element?.closest(READING_CHROME); }
export function readAloudRoot(doc) {
  const selectors=['[data-tts-root]', '[data-book-content]', '.wm-doc', 'main, [role="main"]', '#main-content, #book-content, .main-content, .book-content', 'article'];
  for (const selector of selectors) {
    const root=[...doc.querySelectorAll(selector)].find(el=>!isReadAloudChrome(el)&&!el.closest('[hidden], [aria-hidden="true"]'));
    if(root)return root;
  }
  return doc.body;
}
/** Resolve a TTS boundary without scanning all later text nodes per sentence. */
export function readAloudPosition(parts,offset,isEnd=false) {
  let lo=0,hi=parts.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(isEnd?parts[mid].start<offset:parts[mid].start<=offset)lo=mid+1;else hi=mid;}
  if(!parts.length)return null;
  if(!lo)return {node:parts[0].node,offset:parts[0].offset,part:0};
  const part=lo-1,pt=parts[part];
  return {node:pt.node,offset:pt.offset+Math.max(0,Math.min(offset-pt.start,pt.length)),part};
}
export function createReadAloud(reader) {
  const U = reader.host.ownerDocument, W = U.defaultView, D = reader.doc, R = D.defaultView;
  const CSS = R.CSS, NodeFilter = R.NodeFilter, SpeechSynthesisUtterance = W.SpeechSynthesisUtterance;
  const events = new W.AbortController();
  const listen = (target, type, fn, capture=false) => target.addEventListener(type, fn, {capture, signal:events.signal});
  const mount = U.getElementById('app') || U.body;
  let highlightSheet;
  try {
    highlightSheet = new R.CSSStyleSheet();
    highlightSheet.replaceSync('::highlight(mstts){background:#7b61ff33;text-decoration:underline 2px #7b61ff66;}');
    D.adoptedStyleSheets=[...D.adoptedStyleSheets,highlightSheet];
  } catch {}
  function visibleRect(rect) {const frame=reader.frame.getBoundingClientRect();return {top:frame.top+rect.top*reader.zoom,bottom:frame.top+rect.bottom*reader.zoom,height:rect.height*reader.zoom};}
  function viewBounds() {return reader.viewport.getBoundingClientRect();}

  if (!('speechSynthesis' in W)) return;                       // no engine → no button at all
  var ROOT = readAloudRoot(D);
  if (!ROOT) return;
  var T = {play:'소리내어 읽기',pause:'일시정지',prev:'이전 문장',next:'다음 문장',speed:'읽는 속도',settings:'낭독 설정',stop:'정지',close:'플레이어 닫기',lang:'언어',voice:'음성',voice_auto:'자동 (UI 언어)',voice_none:'이 언어의 설치된 음성이 없어 브라우저 기본 음성으로 읽습니다.',hint:'선택한 언어의 음성 하나로 끝까지 읽습니다 — 본문 속 다른 언어 단어도 포함해서요.'};
  var lb = function (k, d) { return T[k] || d; };
  var BOOK_LANG = String(U.documentElement.lang || 'ko').split('-')[0];

  var UTTER_TAG = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW',
    es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ru: 'ru-RU', pt: 'pt-BR', it: 'it-IT' };
  var LANG_LABEL = { ko: '한국어', en: 'English', ja: '日本語', 'zh-CN': '简体中文', 'zh-TW': '繁體中文',
    es: 'Español', fr: 'Français', de: 'Deutsch', ru: 'Русский', pt: 'Português', it: 'Italiano' };
  var RATES = [0.8, 1, 1.25, 1.5, 2];
  var RATE_KEY = 'msuite_tts_rate', LANG_KEY = 'htmlmemo_tts_lang_' + reader.metadata.id;
  var voiceKey = function (l) { return 'msuite_tts_voice_' + l; };
  var ls = function (k) { try { return W.localStorage.getItem(k); } catch (e) { return null; } };
  var lsSet = function (k, v) { try { W.localStorage.setItem(k, v); reader.callbacks?.onPreferenceChange?.(); } catch (e) { /* private mode */ } };

  // ── Voice quality gate (twin of MemoReadAloud) ──
  var JUNK = /espeak|eloquence|\bdesktop\b|compact|albert|bad news|bahh|bells|boing|bubbles|cellos|wobble|good news|jester|organ|superstar|trinoids|whisper|zarvox|junior|kathy|ralph|fred|grandma|grandpa|rocko|shelley|\beddy\b|\bflo\b|\breed\b|\bsandy\b/i;
  var PREMIUM = /natural|neural|premium|enhanced|google|siri|향상|프리미엄/i;
  function rankOf(v) {
    var n = v.name || '';
    if (/natural|neural/i.test(n)) return 4;
    if (/google/i.test(n)) return 3;
    if (/premium|enhanced|siri|향상|프리미엄/i.test(n)) return 2;
    return v.localService ? 0 : 1;
  }
  function voicesForLang(all, lang) {
    var tag = (UTTER_TAG[lang] || 'en-US').toLowerCase(), primary = tag.split('-')[0];
    var norm = function (l) { return String(l || '').replace('_', '-').toLowerCase(); };
    var exact = all.filter(function (v) { return norm(v.lang).indexOf(tag) === 0; });
    var loose = all.filter(function (v) { return norm(v.lang).split('-')[0] === primary && exact.indexOf(v) < 0; });
    var usable = exact.concat(loose).filter(function (v) { return !JUNK.test(v.name || ''); });
    var premium = usable.filter(function (v) { return PREMIUM.test(v.name || ''); });
    return (premium.length ? premium : usable).sort(function (a, b) { return rankOf(b) - rankOf(a); });
  }

  // ── LaTeX → speech (twin of utils/texSpeech.ts) ──
  var GREEK = { alpha: ['알파', 'alpha'], beta: ['베타', 'beta'], gamma: ['감마', 'gamma'], delta: ['델타', 'delta'],
    epsilon: ['엡실론', 'epsilon'], zeta: ['제타', 'zeta'], eta: ['에타', 'eta'], theta: ['세타', 'theta'],
    iota: ['요타', 'iota'], kappa: ['카파', 'kappa'], lambda: ['람다', 'lambda'], mu: ['뮤', 'mu'], nu: ['뉴', 'nu'],
    xi: ['크시', 'xi'], pi: ['파이', 'pi'], rho: ['로', 'rho'], sigma: ['시그마', 'sigma'], tau: ['타우', 'tau'],
    upsilon: ['웁실론', 'upsilon'], phi: ['피', 'phi'], chi: ['카이', 'chi'], psi: ['프사이', 'psi'], omega: ['오메가', 'omega'],
    Gamma: ['대문자 감마', 'capital gamma'], Delta: ['대문자 델타', 'capital delta'], Theta: ['대문자 세타', 'capital theta'],
    Lambda: ['대문자 람다', 'capital lambda'], Pi: ['대문자 파이', 'capital pi'], Sigma: ['대문자 시그마', 'capital sigma'],
    Phi: ['대문자 피', 'capital phi'], Psi: ['대문자 프사이', 'capital psi'], Omega: ['대문자 오메가', 'capital omega'] };
  var SYMS = { pm: [' 플러스마이너스 ', ' plus or minus '], mp: [' 마이너스플러스 ', ' minus or plus '],
    times: [' 곱하기 ', ' times '], cdot: [' 곱하기 ', ' times '], div: [' 나누기 ', ' divided by '],
    infty: ['무한대', 'infinity'], le: [' 작거나 같다 ', ' is less than or equal to '], leq: [' 작거나 같다 ', ' is less than or equal to '],
    ge: [' 크거나 같다 ', ' is greater than or equal to '], geq: [' 크거나 같다 ', ' is greater than or equal to '],
    ne: [' 같지 않다 ', ' is not equal to '], neq: [' 같지 않다 ', ' is not equal to '], approx: [' 약 ', ' approximately '],
    equiv: [' 합동 ', ' is equivalent to '], to: [' 에서 ', ' to '], rightarrow: [' 에서 ', ' to '],
    Rightarrow: [' 이면 ', ' implies '], 'in': [' 는 다음의 원소 ', ' in '], subset: [' 는 다음의 부분집합 ', ' is a subset of '],
    cup: [' 합집합 ', ' union '], cap: [' 교집합 ', ' intersection '], partial: ['편미분 ', 'partial '],
    nabla: ['나블라 ', 'nabla '], cdots: [' 등등 ', ' and so on '], dots: [' 등등 ', ' and so on '], ldots: [' 등등 ', ' and so on '],
    sin: ['사인 ', 'sine '], cos: ['코사인 ', 'cosine '], tan: ['탄젠트 ', 'tangent '], cot: ['코탄젠트 ', 'cotangent '],
    sec: ['시컨트 ', 'secant '], csc: ['코시컨트 ', 'cosecant '], log: ['로그 ', 'log '], ln: ['자연로그 ', 'natural log '],
    exp: ['지수함수 ', 'exponential '], max: ['최댓값 ', 'max '], min: ['최솟값 ', 'min '] };
  var UNI = [['±', ' 플러스마이너스 ', ' plus or minus '], ['×', ' 곱하기 ', ' times '], ['÷', ' 나누기 ', ' divided by '],
    ['≤', ' 작거나 같다 ', ' is less than or equal to '], ['≥', ' 크거나 같다 ', ' is greater than or equal to '],
    ['≠', ' 같지 않다 ', ' is not equal to '], ['≈', ' 약 ', ' approximately '], ['∞', ' 무한대 ', ' infinity '],
    ['√', ' 루트 ', ' square root of '], ['∑', ' 합 ', ' sum '], ['∫', ' 적분 ', ' integral '], ['∂', ' 편미분 ', ' partial '],
    ['π', ' 파이 ', ' pi '], ['²', ' 제곱', ' squared'], ['³', ' 세제곱', ' cubed']];
  // 아래 기호 규칙은 utils/texSpeech.ts와 같다(두 엔진을 재 보고 정한 것 — 그쪽 주석 참고).
  // 가운뎃점은 낱말을 잇는 부호이고("매주·매달"), 곱셈은 양옆이 홀로 선 수식 조각일 때뿐이다.
  var MIDDOT_MATH = /(^|[^0-9A-Za-z가-힣])(\d+|[A-Za-z])[ \t]*[·⋅‧・][ \t]*(?=(?:\d+|[A-Za-z])(?![0-9A-Za-z가-힣]))/g;
  // 자판 기호에 이름을 붙인다 — 그러지 않으면 "⇧⌘S 로 저장"이 "S로 저장"이 된다.
  var KEYS = [[/⌘/g, ' 커맨드 ', ' command '], [/⇧/g, ' 시프트 ', ' shift '], [/⌥/g, ' 옵션 ', ' option '],
    [/⌃/g, ' 컨트롤 ', ' control '], [/[⏎↵]/g, ' 엔터 ', ' enter '], [/⌫/g, ' 백스페이스 ', ' backspace '],
    [/⇥/g, ' 탭 ', ' tab '], [/⎋/g, ' 이에스씨 ', ' escape ']];
  function atomPair(op) {
    return new RegExp('(^|[^0-9A-Za-z가-힣])(\\d+|[A-Za-z])[ \\t]*' + op + '[ \\t]*(?=(?:\\d+|[A-Za-z])(?![0-9A-Za-z가-힣]))', 'g');
  }
  // 수식이면 낱말로, 아니면 쉼표(또는 지움)로 — [math, ko말, en말, 나머지, 나머지 ko, 나머지 en]
  var CONTEXTUAL = [
    [atomPair('→'), ' 에서 ', ' to ', /[ \t]*→[ \t]*/g, ', ', ', '],
    [atomPair('='), ' 는 ', ' equals ', /[ \t]*=[ \t]*/g, null, null],
    [atomPair('>'), ' 크다 ', ' is greater than ', /[ \t]+>[ \t]+/g, ', ', ', '],
    [atomPair('<'), ' 작다 ', ' is less than ', /[ \t]+<[ \t]+/g, ', ', ', '],
    [/(\d)[ \t]*~[ \t]*(?=\d)/g, ' 에서 ', ' to ', /~/g, null, null],
    [/(\w)[ \t]*@[ \t]*(?=\w)/g, ' 골뱅이 ', ' at ', /@/g, null, null]];
  // 숫자+단위 → 한글 수사. 규칙과 애매한 단위 처리는 utils/texSpeech.ts와 같다(그쪽 주석 참고).
  var SINO_UNITS = ['학년','교시','학기','주차','개월','인분','세기','퍼센트','단계','번지','분기',
    '부','장','절','편','항','조','호','급','종','형','년','월','일','분','초','원','층',
    '회','차','등','위','주','쪽','면','도','점','인','문항','교'];
  var NATIVE_UNITS = ['번째','시간','가지','켤레','군데','봉지','상자','다발','송이','조각','방울',
    '개','명','분들','마리','대','권','잔','병','그릇','살','시','달','벌','자루','채','척',
    '통','곳','줄','판','그루','쌍','칸','배','자리','종류','걸음','번'];
  var NATIVE_NUM = ['','한','두','세','네','다섯','여섯','일곱','여덟','아홉','열',
    '열한','열두','열세','열네','열다섯','열여섯','열일곱','열여덟','열아홉','스무'];
  var SINO_DIGIT = ['','일','이','삼','사','오','육','칠','팔','구'];
  function sinoNum(n) {
    if (n <= 0 || n > 99) return '';
    if (n < 10) return SINO_DIGIT[n];
    var t = Math.floor(n / 10), o = n % 10;
    return (t === 1 ? '십' : SINO_DIGIT[t] + '십') + (o ? SINO_DIGIT[o] : '');
  }
  var SHEET_CUES = /(종이|사진|카드|티켓|명함|복사|인쇄|전지|색종이|우표|지폐|서류|프린트|A4|a4)[^가-힣]{0,4}$/;
  var ALL_UNITS = SINO_UNITS.concat(NATIVE_UNITS).sort(function (a, b) { return b.length - a.length; });
  var UNIT_RE = new RegExp('(^|[^0-9.,:/-])(\\d{1,2})[ \\t]*(' + ALL_UNITS.join('|') + ')', 'g');
  var SINO_SET = {}, NATIVE_SET = {};
  for (var si = 0; si < SINO_UNITS.length; si++) SINO_SET[SINO_UNITS[si]] = 1;
  for (var ni = 0; ni < NATIVE_UNITS.length; ni++) NATIVE_SET[NATIVE_UNITS[ni]] = 1;
  function speakKoreanCounters(s) {
    return s.replace(UNIT_RE, function (m, lead, digits, unit, off, full) {
      var n = parseInt(digits, 10);
      if (!n) return m;
      var before = full.slice(0, off + lead.length), after = full.slice(off + m.length);
      var sino = !!SINO_SET[unit] && !NATIVE_SET[unit];
      if (unit === '장') sino = !SHEET_CUES.test(before);
      else if (unit === '번') sino = !/^(씩|이나|밖에|\s*더)/.test(after);
      else if (unit === '대') sino = /^\s*\d/.test(after);
      else if (NATIVE_SET[unit] && SINO_SET[unit]) sino = false;
      if (/제$/.test(before)) sino = true;
      var word = sino ? sinoNum(n) : (n <= 20 ? NATIVE_NUM[n] : '');
      return word ? lead + word + ' ' + unit : m;
    });
  }
  // 한자·가나는 한글 음으로 (한국어로 읽을 때만). 한자 표는 발행할 때 그 책에 실제로 쓰인
  // 글자만 window.__MSTTS_HANJA로 실어 준다 — 1만 자짜리 표를 통째로 넣을 수는 없으므로.
  var KANA_COMBO = 'きゃ캬きゅ큐きょ쿄ぎゃ갸ぎゅ규ぎょ교しゃ샤しゅ슈しょ쇼じゃ자じゅ주じょ조ちゃ차ちゅ추ちょ초ぢゃ자ぢゅ주ぢょ조にゃ냐にゅ뉴にょ뇨ひゃ햐ひゅ휴ひょ효びゃ뱌びゅ뷰びょ뵤ぴゃ퍄ぴゅ퓨ぴょ표みゃ먀みゅ뮤みょ묘りゃ랴りゅ류りょ료';
  var KANA_BASE = 'あ아い이う우え에お오か카が가き키ぎ기く쿠ぐ구け케げ게こ코ご고さ사ざ자し시じ지す스ず즈せ세ぜ제そ소ぞ조た타だ다ち치ぢ지つ츠づ즈て테で데と토ど도な나に니ぬ누ね네の노は하ば바ぱ파ひ히び비ぴ피ふ후ぶ부ぷ푸へ헤べ베ぺ페ほ호ぼ보ぽ포ま마み미む무め메も모や야ゆ유よ요ら라り리る루れ레ろ로わ와ゐ이ゑ에を오ゔ부';
  function flatMap(flat, keyLen) {
    var m = {}, i;
    for (i = 0; i < flat.length; i += keyLen + 1) m[flat.substr(i, keyLen)] = flat.charAt(i + keyLen);
    return m;
  }
  var KANA1 = flatMap(KANA_BASE, 1), KANA2 = flatMap(KANA_COMBO, 2);
  var HANJA = flatMap(String(W.__MSTTS_HANJA || ''), 1);
  var HAN_BASE = 0xAC00;
  function withFinal(s, jong) {
    var i = s.length - 1, code = s.charCodeAt(i) - HAN_BASE;
    if (code >= 0 && code < 11172 && code % 28 === 0) return s.slice(0, i) + String.fromCharCode(HAN_BASE + code + jong);
    return s;
  }
  function cjkToHangul(s) {
    if (!/[\u3040-\u30FF\u3400-\u9FFF\uF900-\uFAFF]/.test(s)) return s;
    var out = '', i, ch, code, kana, next, nk, two, one;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i); code = s.charCodeAt(i);
      kana = code >= 0x30A1 && code <= 0x30F6 ? String.fromCharCode(code - 0x60) : ch;   // 가타카나 → 히라가나
      next = s.charAt(i + 1);
      nk = next && next.charCodeAt(0) >= 0x30A1 && next.charCodeAt(0) <= 0x30F6 ? String.fromCharCode(next.charCodeAt(0) - 0x60) : next;
      two = nk ? KANA2[kana + nk] : null;
      if (two) { out += two; i++; continue; }
      one = KANA1[kana];
      if (one) { out += one; continue; }
      if (kana === 'ん') { out = withFinal(out, 4); continue; }
      if (kana === 'っ') { out = withFinal(out, 19); continue; }
      if (ch === 'ー' || ch === '々') continue;
      out += HANJA[ch] || ch;
    }
    return out;
  }
  // 애플 음성은 이모지 이름을 통째로 읽는다(🔁 = "미디어 반복 재생을 의미하는 시계 방향 화살표").
  var PICTO = /[\p{Extended_Pictographic}✓✔✗✘★☆️‍\u{1F3FB}-\u{1F3FF}]/gu;
  function pick(pair, ko) { return ko ? pair[0] : pair[1]; }
  function readGroup(s, i) {
    while (s.charAt(i) === ' ') i++;
    if (s.charAt(i) === '{') {
      var depth = 1, j = i + 1, out = '';
      while (j < s.length && depth > 0) {
        var ch = s.charAt(j);
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (!depth) break; }
        out += ch; j++;
      }
      return [out, j + 1];
    }
    if (s.charAt(i) === '\\') {
      var k = i + 1;
      while (k < s.length && /[a-zA-Z]/.test(s.charAt(k))) k++;
      var end = k === i + 1 ? i + 2 : k;
      return [s.slice(i, end), end];
    }
    return [s.charAt(i) || '', i + 1];
  }
  function powerWord(exp, ko) {
    var e = String(exp).trim();
    if (ko) return e === '2' ? ' 제곱' : e === '3' ? ' 세제곱' : ' 의 ' + e + ' 승';
    return e === '2' ? ' squared' : e === '3' ? ' cubed' : ' to the power ' + e;
  }
  function texSpeak(tex, lang) {
    var ko = String(lang || '').indexOf('ko') === 0;
    var src = String(tex || '').replace(/\\left|\\right|\\displaystyle|\\limits|[~]/g, '').replace(/\\[,;:!]/g, ' ');
    var out = '', i = 0, N = src.length, g;
    while (i < N) {
      var c = src.charAt(i);
      if (c === '\\') {
        var j = i + 1;
        while (j < N && /[a-zA-Z]/.test(src.charAt(j))) j++;
        var cmd = src.slice(i + 1, j);
        i = j;
        if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac') {
          var a = readGroup(src, i); i = a[1];
          var b = readGroup(src, i); i = b[1];
          var A = texSpeak(a[0], lang), B = texSpeak(b[0], lang);
          out += ko ? ' ' + B + ' 분의 ' + A + ' ' : ' ' + A + ' over ' + B + ' ';
        } else if (cmd === 'sqrt') {
          var n = '';
          if (src.charAt(i) === '[') { var e0 = src.indexOf(']', i); n = src.slice(i + 1, e0); i = e0 + 1; }
          g = readGroup(src, i); i = g[1];
          var S = texSpeak(g[0], lang);
          out += n ? (ko ? ' ' + n + '제곱근 ' + S + ' ' : ' ' + n + 'th root of ' + S + ' ')
                   : (ko ? ' 루트 ' + S + ' ' : ' square root of ' + S + ' ');
        } else if (cmd === 'int' || cmd === 'sum' || cmd === 'prod' || cmd === 'lim' || cmd === 'oint') {
          var lo = '', hi = '';
          while (src.charAt(i) === '_' || src.charAt(i) === '^') {
            var which = src.charAt(i); i++;
            g = readGroup(src, i); i = g[1];
            if (which === '_') lo = texSpeak(g[0], lang); else hi = texSpeak(g[0], lang);
          }
          if (cmd === 'lim') {
            var m = ko ? lo.match(/^(.+?) 에서 (.+)$/) : null;
            out += ko ? (m ? ' ' + m[1] + '가 ' + m[2] + '로 갈 때 극한, ' : ' ' + lo + ' 일 때 극한, ')
                      : ' limit as ' + lo + ' of ';
          } else {
            var nm = cmd === 'int' ? ['적분', 'integral'] : cmd === 'oint' ? ['폐곡선 적분', 'contour integral']
                   : cmd === 'sum' ? ['합', 'sum'] : ['곱', 'product'];
            if (lo || hi) out += ko ? ' ' + lo + '부터 ' + hi + '까지 ' + nm[0] + ', ' : ' ' + nm[1] + ' from ' + lo + ' to ' + hi + ' of ';
            else out += ' ' + pick(nm, ko) + ' ';
          }
        } else if (cmd === 'text' || cmd === 'mathrm' || cmd === 'mathbf' || cmd === 'mathit' || cmd === 'operatorname' || cmd === 'mathbb' || cmd === 'mathcal') {
          g = readGroup(src, i); i = g[1];
          out += ' ' + g[0] + ' ';
        } else if (cmd === 'vec' || cmd === 'hat' || cmd === 'bar' || cmd === 'dot' || cmd === 'tilde') {
          g = readGroup(src, i); i = g[1];
          var W2 = { vec: ['벡터', 'vector'], hat: ['햇', 'hat'], bar: ['바', 'bar'], dot: ['도트', 'dot'], tilde: ['틸데', 'tilde'] }[cmd];
          out += ko ? ' ' + W2[0] + ' ' + texSpeak(g[0], lang) + ' ' : ' ' + texSpeak(g[0], lang) + ' ' + W2[1] + ' ';
        } else if (cmd === 'begin') {
          g = readGroup(src, i); i = g[1];
          var endMark = '\\end{' + g[0] + '}';
          var e1 = src.indexOf(endMark, i);
          if (/matrix|cases|array|align/.test(g[0])) {
            out += ko ? ' 행렬 ' : ' matrix ';
            i = e1 >= 0 ? e1 + endMark.length : N;
          }
        } else if (cmd === 'end') {
          g = readGroup(src, i); i = g[1];
        } else if (GREEK[cmd]) { out += ' ' + pick(GREEK[cmd], ko) + ' '; }
        else if (SYMS[cmd]) { out += pick(SYMS[cmd], ko); }
        else if (cmd === '') { i++; }
        else { out += ' ' + cmd + ' '; }
      } else if (c === '^') {
        i++; g = readGroup(src, i); i = g[1];
        out += powerWord(texSpeak(g[0], lang), ko);
      } else if (c === '_') {
        i++; g = readGroup(src, i); i = g[1];
        out += ' ' + texSpeak(g[0], lang) + ' ';
      } else if (c === '=') { out += ko ? ' 는 ' : ' equals '; i++; }
      else if (c === '<') { out += ko ? ' 작다 ' : ' is less than '; i++; }
      else if (c === '>') { out += ko ? ' 크다 ' : ' is greater than '; i++; }
      else if (c === '+') { out += ko ? ' 더하기 ' : ' plus '; i++; }
      else if (c === '-') { out += ko ? ' 마이너스 ' : ' minus '; i++; }
      else if (c === '/') { out += ko ? ' 나누기 ' : ' over '; i++; }
      else if (c === '{' || c === '}') { i++; }
      else { out += c; i++; }
    }
    return out.replace(/\s+/g, ' ').trim();
  }
  function verbalize(s, lang) {
    var ko = String(lang || '').indexOf('ko') === 0, out = String(s || ''), prev = '', i;
    if (ko) out = speakKoreanCounters(cjkToHangul(out));   // 한자·가나 → 한글 음, 숫자+단위 → 한글 수사
    for (i = 0; i < KEYS.length; i++) out = out.replace(KEYS[i][0], ko ? KEYS[i][1] : KEYS[i][2]);
    while (out !== prev) { prev = out; out = out.replace(MIDDOT_MATH, function (m, lead, atom) { return lead + atom + (ko ? ' 곱하기 ' : ' times '); }); }
    out = out.replace(/[ \t]*[·⋅‧・•][ \t]*/g, function (m, off, full) { return String(full).slice(0, off).trim() ? ', ' : ' '; });
    for (i = 0; i < CONTEXTUAL.length; i++) {
      (function (c) {
        var word = ko ? c[1] : c[2], restTo = ko ? c[4] : c[5], p = '';
        while (out !== p) {
          p = out;
          // 그룹이 하나인 규칙도 있다 — 둘째 인자가 문자열이 아니면 그것은 offset이다.
          out = out.replace(c[0], function (m, a, b) { return (typeof b === 'string' ? a + b : a) + word; });
        }
        out = out.replace(c[3], restTo === null ? ' ' : restTo);
      })(CONTEXTUAL[i]);
    }
    for (i = 0; i < UNI.length; i++) out = out.split(UNI[i][0]).join(ko ? UNI[i][1] : UNI[i][2]);
    return out.replace(PICTO, ' ');
  }
  function isNoise(s) {
    var t = String(s || '').replace(/\s+/g, '');
    if (t.length < 9) return false;
    var mathish = 0;
    for (var i = 0; i < t.length; i++) if (/[0-9=+\-*/^_()<>|,.±×÷≤≥≠√∑∫∂π{}\[\]]/.test(t.charAt(i))) mathish++;
    var words = String(s).split(/\s+/).filter(function (w) { return /[a-zA-Z가-힣]{3,}/.test(w); });
    return mathish / t.length > 0.5 && words.length <= 1;
  }

  // ── Reading index over the RENDERED text (twin of buildIndex) ──
  // The nav sidebar (.toc) is skipped: it is a duplicate of the headings, and reading the whole
  // contents list before the book is not what anyone wants.
  // A code BOX (pre) stays silent — reading a whole listing aloud is noise. INLINE code is NOT
  // skipped: it is part of the sentence ("현재 src에 있다면" must not lose the word), so only a
  // <code> that sits inside a <pre> is rejected (see acceptNode).
  var SKIP = 'script, style, noscript, button, input, textarea, select, [hidden], #htmlmemo-annotation-layer, [data-memo-panel], [data-tts-skip], pre, .toc, .mstts-player, .wm-nav-btn, .wm-pdf-float';
  // A skipped island may still hold the one thing that IS prose (a widget's finished piece),
  // marked [data-tts-keep]. The NEAREST marker decides — same rule as the in-app player, kept in
  // sync with it.
  function skipped(el, inSelection = false) {
    if (!el || isReadAloudChrome(el) || el.closest('[hidden], [aria-hidden="true"]')) return true;
    if (!inSelection && ROOT === D.body && el.closest('header, footer')) return true;
    var sk = el.closest(SKIP);
    if (!sk) return false;
    var keep = el.closest('[data-tts-keep]');
    return !(keep && sk.contains(keep));
  }
  // Crossing into a new BLOCK ends the sentence. Without this a heading (which has no full stop)
  // runs into the paragraph below it as ONE sentence, and a sentence can span a SKIPPED block
  // (a code box): the DOM range then covers the whole box, and the follow-scroll yanks the view up
  // to the top of that range before the next sentence brings it back.
  var BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, pre, td, th, dt, dd, figcaption, section, article, div, nav, aside, header, footer, main, details, summary, table, tr';
  function blockOf(n) { var e = n.parentElement; return e ? e.closest(BLOCK) : null; }
  function buildIndex(root, range = null) {
    var parts = [], mathRanges = [], text = '', prevBlock = null;
    var walker = D.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var pe = n.parentElement;
        if (!pe || skipped(pe,!!range)) return NodeFilter.FILTER_REJECT;
        if (pe.closest('.katex')) return pe.closest('annotation') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var n;
    while ((n = walker.nextNode())) {
      if (range && !range.intersectsNode(n)) continue;
      var from = range && range.startContainer === n ? range.startOffset : 0;
      var to = range && range.endContainer === n ? range.endOffset : n.data.length;
      if (to <= from) continue;
      var data = n.data.slice(from,to), pe2 = n.parentElement;
      var blk = blockOf(n);
      if (prevBlock && blk !== prevBlock) text += '\n';   // block boundary = sentence boundary
      prevBlock = blk;
      if (pe2 && pe2.closest('annotation')) mathRanges.push({ start: text.length, end: text.length + data.length, tex: data });
      parts.push({ node: n, start: text.length, offset:from, length:to-from, diagram:!!pe2.closest('svg') });
      text += data;
    }
    return { text: text, parts: parts, mathRanges: mathRanges };
  }
  // isEnd: a range END that falls exactly on a node boundary must stay in the node it closes —
  // resolving it to the START of the next node made ranges reach across the gap (into whatever
  // follows a skipped code block), which is what produced the giant highlight + scroll jump.
  function posAt(parts, offset, isEnd) { return readAloudPosition(parts,offset,isEnd); }
  function splitSentences(text, allowShort = false) {
    var seg = [], re = /[^.!?…。\n]+[.!?…。]*\s*/g, m;
    while ((m = re.exec(text))) {
      var raw = m[0], t = raw.trim();
      if (t.length >= (allowShort ? 1 : 2) && /[\p{L}\p{N}]/u.test(t)) {
        seg.push({ start: m.index + (raw.length - raw.replace(/^\s+/, '').length), end: m.index + raw.replace(/\s+$/, '').length });
      }
      if (seg.length > 6000) break;
    }
    // A dot INSIDE a token is not a full stop: 'apps/server/.env', '1.2.3', 'e.g.' would otherwise be
    // cut mid-word ("설정은 apps/server/." then "env 파일에…"). A real terminator is followed by
    // whitespace or the end of the text, so glue a segment to the next one when it is not.
    var out = [];
    for (var i = 0; i < seg.length; i++) {
      var cur = seg[i];
      while (i + 1 < seg.length) {
        var after = text.charAt(cur.end);
        if (!after || /\s/.test(after)) break;
        i++;
        cur = { start: cur.start, end: seg[i].end };
      }
      out.push({ start: cur.start, end: cur.end, text: text.slice(cur.start, cur.end) });
      if (out.length > 4000) break;
    }
    return out;
  }
  function caretAt(x, y) {
    if (typeof D.caretPositionFromPoint === 'function') {
      var p = D.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (typeof D.caretRangeFromPoint === 'function') {
      var r = D.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  // ── State ──
  var state = 'idle';                   // idle | ready | playing | paused
  var run = null;                       // { sents, i, stopped }
  var idx = null;
  var activeUtterance = null, startTimer = null;
  var pausedAt = null, pausedTarget = null, pausedSelection = null;
  var selectionScope = null;             // pinned DOM range; never expands to the document
  var rate = (function () { var v = Number(ls(RATE_KEY)); return RATES.indexOf(v) >= 0 ? v : 1; })();
  var lang = (function () { var v = ls(LANG_KEY); return v && UTTER_TAG[v] ? v : (UTTER_TAG[BOOK_LANG] ? BOOK_LANG : 'en'); })();
  var languageChoice = ls(LANG_KEY) || 'auto';
  var voiceURI = ls(voiceKey(lang)) || 'auto';
  var voices = [];
  function loadVoices() { try { voices = W.speechSynthesis.getVoices() || []; } catch (e) { voices = []; } }
  loadVoices();
  if (W.speechSynthesis.addEventListener) listen(W.speechSynthesis,'voiceschanged',function () { loadVoices(); if (panel) fillPanel(); });
  function resolveVoice() {
    var list = voicesForLang(voices, lang);
    if (voiceURI && voiceURI !== 'auto') {
      for (var i = 0; i < voices.length; i++) if (voices[i].voiceURI === voiceURI) return voices[i];
    }
    return list.length ? list[0] : null;
  }
  let diagramPaint=null, diagramRanges=[], diagramResize=null, diagramFrame=null;
  function clearPaint() {
    try { if (CSS && CSS.highlights) CSS.highlights['delete']('mstts'); } catch (e) { /* ignore */ }
    if(diagramFrame!==null)R.cancelAnimationFrame?.(diagramFrame);diagramFrame=null;
    diagramResize?.disconnect();diagramResize=null;diagramPaint?.remove();diagramPaint=null;diagramRanges=[];
  }
  function drawDiagramPaint() {
    diagramFrame=null;if(!diagramPaint)return;
    const boxes=[],seen=new Set(),zoom=Math.max(.2,Number(reader.zoom)||1);
    for(const range of diagramRanges){
      if(!range.startContainer.isConnected||!range.endContainer.isConnected)continue;
      for(const rect of range.getClientRects()){
        if(!(rect.width>0&&rect.height>0))continue;
        const key=[rect.left,rect.top,rect.width,rect.height].join(',');if(seen.has(key))continue;seen.add(key);
        const box=D.createElement('div');
        box.style.cssText=`all:initial!important;display:block!important;position:fixed!important;left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height+2/zoom}px!important;box-sizing:border-box!important;background:#7b61ff1f!important;box-shadow:inset 0 -${1/zoom}px 0 #7b61ff99!important;pointer-events:none!important;`;
        boxes.push(box);
      }
    }
    diagramPaint.replaceChildren(...boxes);
  }
  function refreshDiagramPaint() {
    if(!diagramPaint||diagramFrame!==null)return;
    if(R.requestAnimationFrame)diagramFrame=R.requestAnimationFrame(drawDiagramPaint);else drawDiagramPaint();
  }
  function paintSentence(start, end) {
    const groups=[], ranges=[[],[]];
    let from=start, diagram=idx.parts[start.part].diagram;
    for (let i=start.part+1;i<=end.part;i++) {
      const part=idx.parts[i];
      if (part.diagram===diagram) continue;
      const previous=idx.parts[i-1];
      groups.push({from,to:{node:previous.node,offset:previous.offset+previous.length},diagram});
      from={node:part.node,offset:part.offset};diagram=part.diagram;
    }
    groups.push({from,to:end,diagram});
    for (const group of groups) {
      const range=D.createRange();range.setStart(group.from.node,group.from.offset);range.setEnd(group.to.node,group.to.offset);
      ranges[Number(group.diagram)].push(range);
    }
    clearPaint();
    if(ranges[0].length)CSS.highlights.set('mstts',new R.Highlight(...ranges[0]));
    if(ranges[1].length){
      // Native SVG Custom Highlights can paint over/clip glyphs even without a
      // decoration. Draw outside SVG so viewBox scaling cannot thicken the line.
      diagramRanges=ranges[1];diagramPaint=D.createElement('div');diagramPaint.setAttribute('data-htmlmemo-ui','');diagramPaint.setAttribute('data-htmlmemo-tts-paint','');diagramPaint.setAttribute('aria-hidden','true');
      diagramPaint.style.cssText='all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483646!important;';D.documentElement.append(diagramPaint);drawDiagramPaint();
      if(R.ResizeObserver){diagramResize=new R.ResizeObserver(refreshDiagramPaint);const targets=new Set(diagramRanges.flatMap(range=>[range.startContainer.parentElement,range.endContainer.parentElement]));for(const target of targets)diagramResize.observe(target);}
    }
  }
  listen(D,'scroll',refreshDiagramPaint,true);
  if(R.addEventListener)listen(R,'resize',refreshDiagramPaint);

  // ── Player DOM ──
  var bar = null, panel = null, btnPlay = null, cnt = null, btnRate = null, savedPosition = null;
  function makeBtn(label, title, onClick) {
    var b = U.createElement('button');
    b.type = 'button'; b.className = 'mstts-btn'; b.textContent = label;
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
    return b;
  }
  function buildBar() {
    bar = U.createElement('div');
    bar.className = 'mstts-player';bar.setAttribute('data-memo-readaloud','');bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','낭독');
    bar.style.left = '12px'; bar.style.bottom = '12px';
    if(savedPosition){bar.style.left=savedPosition.x+'px';bar.style.top=savedPosition.y+'px';bar.style.bottom='auto';}
    var grip = U.createElement('span'); grip.className = 'mstts-grip'; grip.textContent = '⠿'; grip.setAttribute('aria-hidden', 'true');
    bar.appendChild(grip);
    btnPlay = makeBtn('▶', lb('play', 'Read aloud'), pauseResume); bar.appendChild(btnPlay);
    bar.appendChild(makeBtn('⏮', lb('prev', 'Previous sentence'), function () { jumpBy(-1); }));
    bar.appendChild(makeBtn('⏭', lb('next', 'Next sentence'), function () { jumpBy(1); }));
    btnRate = makeBtn(rate + '×', lb('speed', 'Reading speed'), cycleRate);
    btnRate.style.fontSize = '10px'; btnRate.style.fontWeight = '700';
    bar.appendChild(btnRate);
    var gear=makeBtn('⚙', lb('settings', 'Read-aloud settings'), togglePanel);gear.setAttribute('data-tts-gear','');bar.appendChild(gear);
    bar.appendChild(makeBtn('⏹', lb('stop', 'Stop'), stop));
    cnt = U.createElement('span'); cnt.className = 'mstts-count'; bar.appendChild(cnt);
    var closer=makeBtn('✕', lb('close', 'Close the player'), close);closer.style.fontSize='11px';bar.appendChild(closer);
    // Drag by the bar itself (buttons stop propagation), mirroring the in-app player.
    var drag = null;
    bar.addEventListener('pointerdown', function (e) {
      // A pointerdown that lands on a CONTROL must not start a drag: setPointerCapture on the bar
      // retargets the following click to the bar, so every button would go dead (same guard the
      // in-app player has — 'button, [data-tts-panel]').
      if (e.target && e.target.closest && e.target.closest('button, select, option, .mstts-panel')) return;
      var r = bar.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.style.left = r.left + 'px'; bar.style.top = r.top + 'px'; bar.style.bottom = 'auto';
      try { bar.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    });
    bar.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var x = Math.max(4, Math.min(W.innerWidth - bar.offsetWidth - 4, e.clientX - drag.dx));
      var y = Math.max(4, Math.min(W.innerHeight - bar.offsetHeight - 4, e.clientY - drag.dy));
      bar.style.left = x + 'px'; bar.style.top = y + 'px';savedPosition={x,y};
      if (panel) placePanel();
    });
    bar.addEventListener('pointerup', function () { drag = null; });
    mount.appendChild(bar);
    render();
  }
  function placePanel() {
    if (!panel || !bar) return;
    for(const trigger of panel.querySelectorAll('.mstts-select-trigger[aria-expanded=true]'))trigger.click();
    const r=bar.getBoundingClientRect(),above=Math.max(0,r.top-16),below=Math.max(0,W.innerHeight-r.bottom-16);
    const useBelow=above<panel.scrollHeight+2&&below>above;
    panel.style.maxHeight=(useBelow?below:above)+'px';
    panel.style.left=Math.max(8,Math.min(r.left,W.innerWidth-panel.offsetWidth-8))+'px';
    panel.style.top=(useBelow?r.bottom+8:Math.max(8,r.top-panel.offsetHeight-8))+'px';
  }
  // DOM adapter for MemoSuite Select.tsx (size="sm"). Same trigger, chevron and option layout.
  function mountSelect(select, label) {
    const wrap=U.createElement('div');wrap.className='mstts-select';
    const button=U.createElement('button');button.type='button';button.className='mstts-select-trigger';
    button.setAttribute('aria-label',label);button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const caption=U.createElement('span');caption.className='mstts-select-label';
    const chevron=U.createElementNS('http://www.w3.org/2000/svg','svg');chevron.setAttribute('width','16');chevron.setAttribute('height','16');chevron.setAttribute('viewBox','0 0 24 24');chevron.setAttribute('fill','none');chevron.setAttribute('stroke','currentColor');chevron.setAttribute('stroke-width','2');
    const path=U.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d','m6 9 6 6 6-6');chevron.append(path);button.append(caption,chevron);wrap.append(button);
    let menu=null;
    function shut() {menu?.remove();menu=null;button.setAttribute('aria-expanded','false');}
    function show() {
      if(menu){shut();return;}
      for(const other of panel?.querySelectorAll('.mstts-select-trigger[aria-expanded=true]')||[])if(other!==button)other.click();
      menu=U.createElement('div');menu.className='mstts-select-menu';menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);
      for(const option of select.options){
        const item=U.createElement('button');item.type='button';item.className='mstts-select-item';item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));item.textContent=option.textContent;
        if(option.selected){const check=U.createElement('span');check.textContent='✓';item.append(check);}
        item.onclick=()=>{select.value=option.value;caption.textContent=option.textContent;shut();select.dispatchEvent(new W.Event('change'));if(button.isConnected)button.focus();};menu.append(item);
      }
      wrap.append(menu);button.setAttribute('aria-expanded','true');
      const r=button.getBoundingClientRect(),width=Math.min(W.innerWidth-16,Math.max(180,r.width));
      menu.style.left=Math.max(8,Math.min(r.left,W.innerWidth-width-8))+'px';menu.style.width=width+'px';
      const below=Math.max(0,W.innerHeight-r.bottom-12),above=Math.max(0,r.top-12),useBelow=below>=Math.min(menu.scrollHeight,240)||below>above;
      menu.style.maxHeight=Math.min(320,useBelow?below:above)+'px';
      if(useBelow){menu.style.top=r.bottom+4+'px';}else menu.style.bottom=W.innerHeight-r.top+4+'px';
      (menu.querySelector('[aria-selected=true]')||menu.firstChild)?.focus();
    }
    caption.textContent=select.selectedOptions[0]?.textContent||select.options[0]?.textContent||'';
    button.onclick=show;
    wrap.onkeydown=e=>{if(e.key==='Escape'&&menu){e.preventDefault();e.stopPropagation();shut();button.focus();}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();if(!menu){show();return;}const items=[...menu.children];let at=items.indexOf(U.activeElement);at=e.key==='Home'?0:e.key==='End'?items.length-1:(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[at]?.focus();}};
    return wrap;
  }

  function fillPanel() {
    if (!panel) return;
    panel.textContent = '';
    var list = voicesForLang(voices, lang);
    var rowL = U.createElement('div'); rowL.className = 'mstts-row';
    var lblL = U.createElement('span'); lblL.textContent = lb('lang', 'Language'); rowL.appendChild(lblL);
    var selL = U.createElement('select');
    var autoLanguage=U.createElement('option');autoLanguage.value='auto';autoLanguage.textContent='UI 언어 ('+(LANG_LABEL[BOOK_LANG]||BOOK_LANG)+')';autoLanguage.selected=languageChoice==='auto';selL.append(autoLanguage);
    Object.keys(UTTER_TAG).forEach(function (k) {
      if (!voicesForLang(voices, k).length && k !== lang) return;      // only languages this browser can speak
      var o = U.createElement('option'); o.value = k; o.textContent = LANG_LABEL[k] || k;
      if (k === languageChoice) o.selected = true;
      selL.appendChild(o);
    });
    selL.addEventListener('change', function () {
      languageChoice=selL.value;lang=languageChoice==='auto'?(UTTER_TAG[BOOK_LANG]?BOOK_LANG:'en'):languageChoice;lsSet(LANG_KEY,languageChoice);
      voiceURI = ls(voiceKey(lang)) || 'auto';
      fillPanel();
    });
    rowL.appendChild(mountSelect(selL,lb('lang','Language'))); panel.appendChild(rowL);
    var rowV = U.createElement('div'); rowV.className = 'mstts-row';
    var lblV = U.createElement('span'); lblV.textContent = lb('voice', 'Voice'); rowV.appendChild(lblV);
    var selV = U.createElement('select');
    var oAuto = U.createElement('option'); oAuto.value = 'auto'; oAuto.textContent = lb('voice_auto', 'Automatic');
    if (voiceURI === 'auto') oAuto.selected = true;
    selV.appendChild(oAuto);
    list.forEach(function (v) {
      var o = U.createElement('option'); o.value = v.voiceURI; o.textContent = v.name;
      if (v.voiceURI === voiceURI) o.selected = true;
      selV.appendChild(o);
    });
    selV.addEventListener('change', function () { voiceURI = selV.value; lsSet(voiceKey(lang), voiceURI); });
    rowV.appendChild(mountSelect(selV,lb('voice','Voice'))); panel.appendChild(rowV);
    if (!list.length) {
      var h0 = U.createElement('div'); h0.className = 'mstts-hint';
      h0.textContent = lb('voice_none', 'No installed voice for this language — the browser default will read.');
      panel.appendChild(h0);
    }
    var h = U.createElement('div'); h.className = 'mstts-hint';
    h.textContent = lb('hint', 'Reads everything with one voice in the chosen language.');
    panel.appendChild(h);
    if (T.hint2) {
      var h2 = U.createElement('div'); h2.className = 'mstts-hint'; h2.textContent = T.hint2;
      panel.appendChild(h2);
    }
    placePanel();
  }
  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = U.createElement('div');
    panel.className = 'mstts-panel';panel.setAttribute('data-tts-panel','');panel.setAttribute('data-memo-readaloud','');
    panel.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    // A sibling avoids inheriting the draggable bar's touch-action:none.
    // Settings can scroll normally with a finger in a short viewport.
    mount.appendChild(panel);
    fillPanel();
  }
  function closePanel() { if (panel) { panel.remove(); panel = null; } }
  function render() {
    if (!bar) return;
    bar.dataset.ttsScope = selectionScope ? 'selection' : 'document';
    bar.setAttribute('aria-label',selectionScope ? '선택한 텍스트 낭독' : '낭독');
    btnPlay.textContent = state === 'playing' ? '⏸' : '▶';
    btnPlay.title = state === 'playing' ? lb('pause', 'Pause') : lb('play', 'Read aloud');btnPlay.setAttribute('aria-label',btnPlay.title);
    btnPlay.setAttribute('aria-pressed',String(state === 'playing'));
    btnRate.textContent = rate + '×';
    cnt.textContent = state !== 'ready' && run && run.sents.length ? (Math.min(run.i + 1, run.sents.length) + '/' + run.sents.length) : '';
  }

  // ── Transport ──
  function clearStartTimer() {if(startTimer !== null){W.clearTimeout(startTimer);startTimer = null;}}
  function cancelSpeech() {
    // Invalidate BEFORE cancel(): some engines report cancellation synchronously.
    activeUtterance = null;clearStartTimer();
    try { W.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }
  function resumeEngine() {
    // Neither cancel() nor speak() clears the native engine's paused state.
    // Keep speak() in the user's gesture, but release a stranded native pause first.
    if (W.speechSynthesis.paused) W.speechSynthesis.resume();
  }
  function pauseReading() {
    if (run) run.stopped = true;
    state = 'paused';resetPause();render();cancelSpeech();
    // A transient/detached selection must never leave a canceled run showing Pause.
    try { pausedAt = readingPosition(); } catch (e) { /* use the current view on Play */ }
    pausedSelection = selectedPosition();
  }
  function failSpeech(message) {
    if (run && idx && run.sents.length) pauseReading();
    else {cancelSpeech();state = 'ready';clearPaint();render();}
    reader.callbacks?.onNotice?.(message || '음성을 재생하지 못했습니다. ▶를 눌러 같은 문장에서 다시 시도하세요.');
  }
  function cycleRate() {
    closePanel();
    rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
    lsSet(RATE_KEY, String(rate));
    render();
    // Applies from the NEXT sentence — each sentence is its own utterance (same as in-app).
  }
  function firstVisibleSentence(sents, index) {
    var bounds=viewBounds(),threshold=bounds.top+Math.min(80,bounds.height*.12),frame=reader.frame.getBoundingClientRect(),boxes=new WeakMap();
    for (var i = 0; i < sents.length; i++) {
      var p = posAt(index.parts, sents[i].start);
      var el = p && p.node.parentElement;
      if(el&&!boxes.has(el))boxes.set(el,frame.top+el.getBoundingClientRect().bottom*reader.zoom);
      if(el&&boxes.get(el)>threshold)return i;
    }
    return 0;
  }
  function readingPosition() {
    return {root:readAloudRoot(D),top:Number(reader.scrollTop)||0,left:Number(reader.scrollLeft)||0};
  }
  function samePosition(a, b) {
    return !!a && !!b && a.root === b.root && Math.abs(a.top-b.top)<1 && Math.abs(a.left-b.left)<1;
  }
  function selectedPosition() {
    try {
      var sel = D.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      var r = sel.getRangeAt(0), root = readAloudRoot(D);
      if (!root.contains(r.startContainer)) return null;
      return {node:r.startContainer,offset:r.startOffset,endNode:r.endContainer,endOffset:r.endOffset};
    } catch (e) { return null; }
  }
  function sameSelection(a, b) {
    return a === b || !!a && !!b && a.node === b.node && a.offset === b.offset && a.endNode === b.endNode && a.endOffset === b.endOffset;
  }
  function resetPause() { pausedAt = pausedTarget = pausedSelection = null; }
  function scopeIsCurrent() {
    if (!selectionScope) return true;
    try {
      var scope=selectionScope;
      return !reader.disposed && !reader.host.hidden && scope.proseRoot===readAloudRoot(D) && scope.section===currentSection(D) &&
        scope.root.contains(scope.first) && scope.root.contains(scope.last) && scope.range.toString()===scope.raw;
    } catch (e) {return false;}
  }
  function invalidateSelection() {
    stop();run=idx=null;
    reader.callbacks?.onNotice?.('선택한 글이 바뀌었거나 다른 장으로 이동했습니다. 글을 다시 선택해 읽어주세요.');
  }
  function readingIndex() {
    ROOT=selectionScope?.root||readAloudRoot(D);
    if (!scopeIsCurrent()) {invalidateSelection();return null;}
    return buildIndex(ROOT,selectionScope?.range);
  }
  function openSelection(anchor) {
    if (!anchor?.quote?.trim() || reader.disposed || reader.host.hidden) return false;
    try {
      var proseRoot=readAloudRoot(D),section=currentSection(D),index=reader.searchCache?.().get()||textIndex(D),resolved=resolveTextAnchor(index,anchor);
      var range=resolved && rangeFromOffsets(D,resolved.start,resolved.end,index);
      var root=range && proseRoot.contains(range.startContainer) && proseRoot.contains(range.endContainer) ? proseRoot : D.body;
      if ((anchor.section||'')!==section || !range || !root.contains(range.startContainer) || !root.contains(range.endContainer)) throw new Error('Missing selection');
      if (!splitSentences(buildIndex(root,range).text,true).length) {
        reader.callbacks?.onNotice?.('선택한 부분에 읽을 수 있는 본문이 없습니다.');return false;
      }
      stop();run=idx=null;
      ROOT=root;selectionScope={root,proseRoot,section,range,first:range.startContainer,last:range.endContainer,raw:range.toString()};
      if (!bar) buildBar();
      state='ready';render();pauseResume();return true;
    } catch (e) {
      reader.callbacks?.onNotice?.('선택한 글의 위치를 찾지 못했습니다. 글을 다시 선택해 주세요.');return false;
    }
  }
  function beginReading(index, sents, at) {
    if (run) run.stopped = true;
    cancelSpeech();idx = index;resetPause();
    if (!sents.length) {run = null;clearPaint();state = 'ready';render();return;}
    run = {sents:sents,i:at,stopped:false};
    state = 'playing';render();speakFrom(at);
  }
  function startReading() {
    var index = readingIndex();if(!index)return;
    var sents = splitSentences(index.text,!!selectionScope);
    beginReading(index, sents, selectionScope ? 0 : firstVisibleSentence(sents, index));
  }
  function resumeReading() {
    var position = readingPosition();
    ROOT = position.root;
    // Rebuild on an explicit Play so a new/lazy chapter never uses old text or DOM ranges.
    var index = readingIndex();if(!index)return;
    var sents = splitSentences(index.text,!!selectionScope);
    var unchanged = run && idx && (selectionScope || samePosition(pausedAt, position)) && idx.text === index.text;
    var at = unchanged ? Math.min(run.i, sents.length-1) : selectionScope ? 0 : firstVisibleSentence(sents, index);
    if (pausedTarget && samePosition(pausedTarget.position, position)) {
      var target = pausedTarget.point, textTarget = target.node.nodeType === 3;
      var child = !textTarget && target.node.childNodes[target.offset];
      var part = index.parts.find(function (p) {return textTarget ? p.node === target.node : child && (child === p.node || child.contains(p.node));});
      if (part) {
        var flat = part.start + (textTarget ? Math.max(0,Math.min(target.offset-part.offset,part.length)) : 0);
        var selected = sents.findIndex(function (sent) {return flat < sent.end;});
        if (selected >= 0) at = selected;
      }
    }
    beginReading(index, sents, at);
  }
  function speakFrom(i) {
    var ctx = run;
    if (!ctx || ctx.stopped) return;
    if (!scopeIsCurrent()) {invalidateSelection();return;}
    if (i >= ctx.sents.length) {
      if(reader.pdf&&!selectionScope){reader.pdf.nextSpeechPage(()=>run===ctx&&!ctx.stopped).then(moved=>{if(run!==ctx||ctx.stopped)return;if(moved)startReading();else stop();}).catch(()=>failSpeech());return;}
      stop(); return;
    }
    ctx.i = i; render();
    var sent = ctx.sents[i];
    // Paint the sentence + follow it without bobbing (twin of the in-app band rule).
    try {
      if (!idx) idx = readingIndex();
      if (!idx) return;
      // The sentence carries its own offsets into idx.text. Searching by TEXT (indexOf) matched the
      // FIRST occurrence, so a repeated sentence sent the highlight back up the page and the next
      // one brought it down again.
      if (CSS && CSS.highlights && R.Highlight) {
        var s = posAt(idx.parts, sent.start, false), e = posAt(idx.parts, sent.end, true);
        if (s && e) {
          var r = D.createRange();
          r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset);
          paintSentence(s,e);
          // The FIRST client rect (the sentence's first line), not the union: a union spanning a
          // block boundary is hundreds of pixels tall and would scroll to somewhere nobody is reading.
          var rl = r.getClientRects();
          var rect = rl && rl.length ? rl[0] : r.getBoundingClientRect();
          if (rect.height > 0) {
            rect=visibleRect(rect);var bounds=viewBounds(),viewH=bounds.height;
            var outAbove = rect.top < bounds.top + Math.min(72, viewH * 0.12);
            var outBelow = rect.bottom > bounds.top + viewH * 0.72;
            if (outAbove || outBelow) reader.scrollTop += rect.top - bounds.top - viewH * 0.3;
          }
        }
      }
    } catch (err) { /* painting is best-effort */ }
    // What is SPOKEN can differ from what is shown: formulas become words, unicode math is
    // verbalized, and a segment that is pure symbol soup is announced as "formula".
    var speakText = sent.text;
    try {
      var mrs = (idx && idx.mathRanges ? idx.mathRanges : []).filter(function (r2) { return r2.start < sent.end && r2.end > sent.start; })
        .sort(function (a, b) { return b.start - a.start; });
      for (var k = 0; k < mrs.length; k++) {
        var s0 = Math.max(mrs[k].start, sent.start) - sent.start;
        var e0 = Math.min(mrs[k].end, sent.end) - sent.start;
        speakText = speakText.slice(0, s0) + ' ' + texSpeak(mrs[k].tex, lang) + ' ' + speakText.slice(e0);
      }
      speakText = verbalize(speakText, lang).replace(/\s+/g, ' ').trim();
      if (isNoise(speakText)) speakText = lang.indexOf('ko') === 0 ? '수식.' : 'Formula.';
      speakText = speakText.slice(0, 1000);
    } catch (err2) { /* fall back to the raw sentence */ }
    // 읽을 것이 남지 않은 문장(이모지만 있던 줄 등)은 건너뛴다 — 빈 발화는 onend가 오지 않아
    // 재생이 멈춰 서는 엔진이 있다.
    if (!speakText) { if (!ctx.stopped) speakFrom(i + 1); return; }
    var u;
    try {
      u = new SpeechSynthesisUtterance(speakText);
      u.lang = UTTER_TAG[lang] || 'en-US';
      var v = resolveVoice();
      if (v) u.voice = v;
      u.rate = rate;activeUtterance = u;
      var current = function () {return state === 'playing' && run === ctx && !ctx.stopped && activeUtterance === u;};
      u.onstart = u.onresume = function () {if(current())clearStartTimer();};
      u.onend = function () {
        if (!current()) return;
        clearStartTimer();activeUtterance = null;speakFrom(i + 1);
      };
      u.onerror = function () {if(current())failSpeech();};
      u.onpause = function () {
        if (!current()) return;
        try {resumeEngine();} catch (e) {failSpeech();}
      };
      // A silent/failed native start must not leave a permanently misleading Pause.
      // Never retry automatically: the next explicit Play retries this sentence.
      startTimer = W.setTimeout(function () {
        if(current())failSpeech('음성 시작 응답이 없습니다. 브라우저·기기의 음성 설정을 확인한 뒤 ▶를 눌러 다시 시도하세요.');
      },8000);
      resumeEngine();W.speechSynthesis.speak(u);
    } catch (err3) {if(!u || activeUtterance === u)failSpeech();}
  }
  function jump(to) {
    closePanel();
    if (!run) return;
    if (!scopeIsCurrent()) {invalidateSelection();return;}
    resetPause();
    var target = Math.min(Math.max(0, to), run.sents.length - 1);
    run.stopped = true;                 // silence the old run FIRST so its onend can't advance
    cancelSpeech();
    run = { sents: run.sents, i: target, stopped: false };
    state = 'playing'; render();
    speakFrom(target);
  }
  function jumpBy(delta) {
    if (run) { jump(run.i + delta); return; }
    var index = readingIndex();if(!index)return;
    var sents = splitSentences(index.text,!!selectionScope);
    if (!sents.length) return;
    idx = index;
    var at = selectionScope ? 0 : firstVisibleSentence(sents, index);
    run = { sents: sents, i: at, stopped: true };
    jump(at + delta);
  }
  var pdfPlayGeneration=0;
  function pauseResume() {
    closePanel();
    if(reader.pdf&&!selectionScope&&state!=='playing'){
      const generation=++pdfPlayGeneration,expected=state;
      reader.pdf.prepareSpeech().then(hasText=>{if(generation!==pdfPlayGeneration||state!==expected||reader.disposed)return;if(!hasText){reader.callbacks?.onNotice?.('이 쪽에는 읽을 수 있는 텍스트가 없습니다.');return;}if(state==='ready')startReading();else if(state==='paused')resumeReading();}).catch(()=>failSpeech());return;
    }
    try {
      if (state === 'ready') startReading();
      // Pause cancels and remembers the view; Play uses a new reading position when it changed.
      // Without navigation the same sentence is repeated. Native pause()/resume() is
      // unreliable on phones. Button intent belongs to our state; native paused is checked
      // only to release a stranded engine before a new utterance.
      else if (state === 'playing') pauseReading();
      else if (state === 'paused') resumeReading();
    } catch (e) {failSpeech();}
  }
  function stop() {                     // ⏹ stops the voice, keeps the bar (back to 'ready')
    pdfPlayGeneration++;
    closePanel();
    resetPause();
    if (run) run.stopped = true;
    cancelSpeech(); clearPaint();
    state = 'ready'; render();
  }
  function close() {                    // ✕ puts the player away
    closePanel();
    resetPause();
    if (run) run.stopped = true;
    cancelSpeech(); clearPaint();
    run = idx = selectionScope = null; state = 'idle';
    if (bar) { bar.remove(); bar = null; }
    render();
  }

  listen(D,'selectionchange',function () {
    if (state !== 'paused' || selectionScope) return;
    var target = selectedPosition();
    if (sameSelection(target, pausedSelection)) return;
    pausedSelection = target;
    if (target) {pausedTarget = {point:target,position:readingPosition(),selection:true};clearPaint();}
    else if (pausedTarget && pausedTarget.selection) pausedTarget = null;
  });

  // Playing clicks jump immediately; paused clicks only choose the next Play's sentence.
  listen(D,'click', function (e) {
    if (state !== 'playing' && state !== 'paused') return;
    var t = e.target;
    var root = state === 'paused' ? readAloudRoot(D) : ROOT;
    if (!t || !root.contains(t)) return;
    if (t.closest('a, button, input, textarea, select, summary, .mstts-player, .mstts-panel')) return;
    if (skipped(t)) return;
    var sel = D.getSelection();
    if (sel && !sel.isCollapsed) return;
    var pt = caretAt(e.clientX, e.clientY);
    if (!pt || pt.node.nodeType !== 3) return;
    if (selectionScope && (!scopeIsCurrent() || !idx?.parts.some(part=>part.node===pt.node && pt.offset>=part.offset && pt.offset<=part.offset+part.length))) return;
    if (state === 'paused') {pausedTarget = {point:pt,position:readingPosition(),selection:false};clearPaint();return;}
    if (!run || !idx) return;
    var part = null;
    for (var i = 0; i < idx.parts.length; i++) if (idx.parts[i].node === pt.node) { part = idx.parts[i]; break; }
    if (!part) return;
    var flat = part.start + pt.offset - part.offset;
    for (var k = 0; k < run.sents.length; k++) if (flat <= run.sents[k].end) { jump(k); return; }
  }, true);

  // Lifecycle is owned by HTMLMemo; no listener or voice survives a tab switch/dispose.
  listen(W,'pagehide',close);
  const dismissSettings = e => {if(panel && !e.target.closest?.('[data-tts-panel],[data-tts-gear],[role=listbox]'))closePanel();};
  listen(U,'pointerdown',dismissSettings,true);listen(D,'pointerdown',dismissSettings,true);
  listen(W,'resize',()=>{refreshDiagramPaint();if(!bar)return;const r=bar.getBoundingClientRect();bar.style.left=Math.max(4,Math.min(r.left,W.innerWidth-r.width-4))+'px';bar.style.top=Math.max(4,Math.min(r.top,W.innerHeight-r.height-4))+'px';bar.style.bottom='auto';if(panel)placePanel();});
  return {
    toggle() { if(state !== 'idle') {close();return;} buildBar();state='ready';render(); },
    openSelection,
    isPlaying:()=>state==='playing',
    refreshPaint:refreshDiagramPaint,
    close,
    escape() {if(state==='idle')return false;if(panel)closePanel();else close();return true;},
    dispose() {close();events.abort();if(highlightSheet)D.adoptedStyleSheets=D.adoptedStyleSheets.filter(s=>s!==highlightSheet);},
  };
}
