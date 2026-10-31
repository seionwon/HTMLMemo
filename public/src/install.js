export const PUBLIC_APP_URL = 'https://seionwon.github.io/LibreMemo/';
export const LEGACY_PUBLIC_APP_URL = 'https://seionwon.github.io/HTMLMemo/';

// Keep sharing the address that is actually serving this copy during the
// repository rename. Local files use the new canonical public address.
export function publicAppURL(location = globalThis.location) {
  try {
    const url = new URL(location?.href);
    if (url.origin === 'https://seionwon.github.io' &&
        /^\/(?:HTMLMemo|LibreMemo)\/(?:index\.html)?$/.test(url.pathname)) {
      return new URL('./', url).href;
    }
  } catch { /* A local or non-browser caller has no public deployment URL. */ }
  return PUBLIC_APP_URL;
}

export function isIOS(navigator) {
  return /iPad|iPhone|iPod/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function installableLocation(location) {
  return location.protocol === 'https:' ||
    (location.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname));
}

export function installationURL(location) {
  if (location.protocol !== 'https:') return PUBLIC_APP_URL;
  const url = new URL('./', location.href);
  url.username = ''; url.password = ''; url.search = ''; url.hash = '';
  return url.href;
}

// The same app button opens the native prompt when available. iOS requires
// the browser Share menu, so the button gives instructions for that platform.
export class InstallController {
  constructor({window, navigator, location, matchMedia, onChange = () => {}, onGuide = () => {}}) {
    Object.assign(this, {window, navigator, location, matchMedia, onChange, onGuide});
    this.deferred = null; this.busy = false;
    this.installed = !!navigator.standalone || !!matchMedia('(display-mode: standalone)').matches;
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault(); this.deferred = event; this.changed();
    });
    window.addEventListener('appinstalled', () => {
      this.installed = true; this.deferred = null; this.changed();
    });
    matchMedia('(display-mode: standalone)').addEventListener?.('change', event => {
      if (event.matches) { this.installed = true; this.changed(); }
    });
    this.changed();
  }

  changed() {
    this.onChange({installed: this.installed, busy: this.busy, ready: !!this.deferred});
  }

  async install() {
    if (this.busy) return;
    if (this.installed) { this.onGuide('installed'); return; }
    if (!installableLocation(this.location)) { this.onGuide('local'); return; }
    if (isIOS(this.navigator)) { this.onGuide('ios'); return; }
    if (!this.deferred) { this.onGuide('browser'); return; }
    const event = this.deferred;
    this.deferred = null; this.busy = true; this.changed();
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice?.outcome;
    } finally {
      this.busy = false; this.changed();
    }
  }
}
