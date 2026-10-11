/* HTMLMemo's self-contained page capture. Shared by the PWA and Chrome bridge. */
(() => {
  'use strict';
  const RESOURCE_LIMIT = 25 * 1024 * 1024;
  const CAPTURE_LIMIT = 150 * 1024 * 1024;
  const bytesToData = (bytes, type) => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return `data:${type || 'application/octet-stream'};base64,${btoa(binary)}`;
  };
  async function captureDocument(doc, options = {}) {
    const warnings = [];
    const cache = new Map();
    let totalBytes = 0;
    const source = doc.location?.href || options.url || doc.baseURI;
    const fetchResource = options.fetchResource || (async url => {
      const response = await fetch(url, {credentials: 'include', signal: AbortSignal.timeout(15000)});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      return {bytes: new Uint8Array(buffer), type: response.headers.get('content-type') || ''};
    });
    const absolute = (value, base) => { try { return new URL(value, base).href; } catch { return ''; } };
    const get = async (url, kind = 'data') => {
      if (url.startsWith('data:')) return url;
      if (!/^(https?:|blob:)/i.test(url)) throw new Error('지원하지 않는 리소스 주소');
      const key = kind + ':' + url;
      if (!cache.has(key)) cache.set(key, (async () => {
        const response = await fetchResource(url);
        const bytes = response.bytes instanceof Uint8Array ? response.bytes : new Uint8Array(response.bytes);
        if (bytes.length > RESOURCE_LIMIT) throw new Error('리소스가 25MB를 초과합니다.');
        totalBytes += bytes.length;
        if (totalBytes > CAPTURE_LIMIT) throw new Error('페이지 리소스가 150MB를 초과합니다.');
        return kind === 'text' ? new TextDecoder().decode(bytes) : bytesToData(bytes, response.type?.split(';')[0]);
      })());
      return cache.get(key);
    };
    const resource = async (value, base, label) => {
      const url = absolute(value, base);
      if (!url || url.startsWith('#') || url.startsWith('data:')) return value;
      try { return await get(url); }
      catch (error) { warnings.push(`${label}: ${url} (${error.message})`); return ''; }
    };
    async function inlineCSS(css, base, ancestors = new Set()) {
      // Imports must be resolved before url() rewriting so font/image URLs use
      // the importing stylesheet's own base URL, including nested imports.
      const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?["']?([^\s"'();]+)["']?\s*\)?\s*([^;]*);/gi)];
      for (const match of imports) {
        const url = absolute(match[1], base);
        let replacement = '';
        if (!ancestors.has(url)) {
          try { const text = await get(url, 'text'); const next = await inlineCSS(text, url, new Set([...ancestors, url])); replacement = match[2].trim() ? `@media ${match[2]}{${next}}` : next; }
          catch (error) { warnings.push(`스타일: ${url} (${error.message})`); }
        }
        css = css.replace(match[0], replacement);
      }
      const urls = [...css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gi)];
      for (const match of urls) {
        if (!match[2] || match[2].startsWith('#') || match[2].startsWith('data:')) continue;
        const data = await resource(match[2], base, '스타일 리소스');
        css = css.replace(match[0], data ? `url("${data}")` : 'url("")');
      }
      return css;
    }
    const clone = doc.documentElement.cloneNode(true);
    const originals = [doc.documentElement, ...doc.documentElement.querySelectorAll('*')];
    const copies = [clone, ...clone.querySelectorAll('*')];
    // Copy state that isn't represented in outerHTML (canvas, form values,
    // lazy-loaded images, shadow DOM). Process resources with bounded concurrency.
    let index = 0;
    const process = async () => {
      while (index < originals.length) {
        const current = index++; const original = originals[current]; const copy = copies[current];
        if (!copy || !copy.parentNode && copy !== clone) continue;
        const tag = original.tagName.toLowerCase();
        if (['script', 'noscript', 'object', 'embed'].includes(tag)) { copy.remove(); continue; }
        for (const attr of [...copy.attributes]) if (/^on/i.test(attr.name) || ['integrity', 'nonce', 'crossorigin', 'autofocus'].includes(attr.name)) copy.removeAttribute(attr.name);
        if (tag === 'base' || tag === 'meta' && /^(refresh|content-security-policy)$/i.test(copy.httpEquiv)) { copy.remove(); continue; }
        if (tag === 'link') {
              if ((original.getAttribute('rel') || '').split(/\s+/).includes('stylesheet')) {
            try {
              let text;
              try { text = [...original.sheet.cssRules].map(rule => rule.cssText).join('\n'); }
              catch { text = await get(original.href, 'text'); }
              const style = doc.createElement('style'); style.textContent = await inlineCSS(text, original.href);
              if (original.media) style.media = original.media;
              copy.replaceWith(style);
            } catch (error) { warnings.push(`스타일: ${original.href} (${error.message})`); copy.remove(); }
          } else copy.remove();
          continue;
        }
        if (tag === 'style') copy.textContent = await inlineCSS(original.textContent, doc.baseURI);
        if (original.hasAttribute('style')) copy.setAttribute('style', await inlineCSS(original.getAttribute('style'), doc.baseURI));
        if (tag === 'img') {
          const src = original.currentSrc || original.src || original.getAttribute('data-src');
          if (src) {
            let data = '';
            // Loaded cross-origin images can be tainted; the extension fetcher
            // handles them without a canvas conversion.
            try { data = await resource(src, doc.baseURI, '이미지'); } catch { /* resource reports failures */ }
            if (data) copy.setAttribute('src', data); else { copy.removeAttribute('src'); copy.alt = original.alt || '저장하지 못한 이미지'; }
          }
          copy.removeAttribute('srcset'); copy.removeAttribute('loading'); copy.removeAttribute('data-src'); copy.removeAttribute('data-srcset');
        }
        if (tag === 'picture') for (const item of copy.querySelectorAll('source')) item.remove();
        if (tag === 'canvas') {
          try { const image = doc.createElement('img'); image.src = original.toDataURL(); image.width = original.width; image.height = original.height; image.setAttribute('style', original.getAttribute('style') || ''); copy.replaceWith(image); }
          catch { warnings.push('보호된 캔버스는 저장하지 못했습니다.'); }
        }
        if (tag === 'input') {
          if (/^(password|file)$/i.test(original.type)) copy.setAttribute('value', '');
          else copy.setAttribute('value', original.value);
          if (original.checked) copy.setAttribute('checked', ''); else copy.removeAttribute('checked');
        }
        if (tag === 'textarea') copy.textContent = original.value;
        if (tag === 'option') { if (original.selected) copy.setAttribute('selected', ''); else copy.removeAttribute('selected'); }
        if (['video', 'audio', 'source', 'track'].includes(tag)) {
          copy.removeAttribute('src'); copy.removeAttribute('srcset'); copy.removeAttribute('autoplay');
          if (tag === 'video' && original.poster) copy.setAttribute('poster', await resource(original.poster, doc.baseURI, '동영상 포스터'));
        }
        if (tag === 'iframe') {
          try {
            if (!original.contentDocument?.documentElement) throw new Error('다른 출처의 프레임');
            if ((options.depth || 0) >= 3) throw new Error('프레임 중첩이 너무 깊습니다.');
            const nested = await captureDocument(original.contentDocument, {...options, depth: (options.depth || 0) + 1});
            copy.removeAttribute('src'); copy.setAttribute('srcdoc', nested.html); copy.setAttribute('sandbox', ''); warnings.push(...nested.warnings);
          } catch { const placeholder = doc.createElement('div'); placeholder.textContent = '외부 프레임 · ' + (original.title || original.src); placeholder.style.cssText = 'padding:16px;border:1px solid #ddd;color:#666;font-size:12px'; copy.replaceWith(placeholder); warnings.push(`외부 프레임: ${original.src}`); }
        }
        if (tag === 'image' && original.namespaceURI.includes('svg')) {
          const attr = original.getAttribute('href') ? 'href' : 'xlink:href'; const href = original.getAttribute(attr);
          if (href) copy.setAttribute(attr, await resource(href, doc.baseURI, 'SVG 이미지'));
        }
        if (original.shadowRoot) {
          const template = doc.createElement('template'); template.setAttribute('shadowrootmode', 'open');
          template.innerHTML = original.shadowRoot.innerHTML;
          for (const script of template.content.querySelectorAll('script')) script.remove();
          for (const style of template.content.querySelectorAll('style')) style.textContent = await inlineCSS(style.textContent, doc.baseURI);
          for (const image of template.content.querySelectorAll('img')) { image.src = await resource(image.getAttribute('src'), doc.baseURI, 'Shadow DOM 이미지'); image.removeAttribute('srcset'); }
          for (const element of template.content.querySelectorAll('*')) for (const attr of [...element.attributes]) if (/^on/i.test(attr.name)) element.removeAttribute(attr.name);
          for (const sheet of original.shadowRoot.adoptedStyleSheets || []) { const style = doc.createElement('style'); style.textContent = await inlineCSS([...sheet.cssRules].map(rule => rule.cssText).join('\n'), doc.baseURI); template.content.append(style); }
          copy.prepend(template);
        }
        if (tag === 'a') {
          const href = original.getAttribute('href');
          if (href && !href.startsWith('#')) { const url = absolute(href, doc.baseURI); if (/^(https?:|mailto:|tel:)/.test(url)) copy.setAttribute('href', url); else copy.removeAttribute('href'); }
          copy.removeAttribute('ping');
        }
        if (tag === 'form') { copy.removeAttribute('action'); copy.removeAttribute('method'); }
      }
    };
    await Promise.all(Array.from({length: 6}, process));
    const head = clone.querySelector('head');
    for (const sheet of doc.adoptedStyleSheets || []) { const style = doc.createElement('style'); style.textContent = await inlineCSS([...sheet.cssRules].map(rule => rule.cssText).join('\n'), doc.baseURI); head.append(style); }
    const charset = doc.createElement('meta'); charset.setAttribute('charset', 'utf-8'); head.prepend(charset);
    const viewport = {width: doc.documentElement.clientWidth || 1100, height: doc.documentElement.clientHeight || 800};
    return {html: '<!doctype html>\n' + clone.outerHTML, title: doc.title || new URL(source).hostname, url: source, viewport, warnings: [...new Set(warnings)], resources: cache.size};
  }
  globalThis.HTMLMemoCapture = {captureDocument, RESOURCE_LIMIT, CAPTURE_LIMIT};
})();
