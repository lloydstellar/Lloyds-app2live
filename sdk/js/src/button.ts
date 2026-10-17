// <la2l-send-button>: a "Send to Live" button for any web page, with the LA2L logo. The first
// time, it asks for the code LA2L shows in Live; after that one click sends. Browser only; on a
// server (pre-rendering) the module loads and does nothing.
//
//   <script type="module" src="https://cdn.jsdelivr.net/npm/la2l@0.1.0/dist/button.min.js"></script>
//   <la2l-send-button app-name="Web808"></la2l-send-button>
//   <script type="module">
//     document.querySelector('la2l-send-button').sounds = async () => ({
//       title: 'Treinbeat', bpm: 92,
//       sounds: [{ name: 'Beat', audio: wavFromAudioBuffer(await render()), kind: 'loop', role: 'drums' }],
//     });
//   </script>

import { LA2L, type Delivery, type DeliveryStatus, type SendOptions, type SoundInput } from './client.js';
import { La2lError, type La2lErrorCode } from './errors.js';
import { LOGO } from './logo.js';

/**
 * The texts of the button. Set `button.texts` to replace any of them, for example in another
 * language. The texts of errors are empty: then the button shows LA2L's own English text, which
 * says exactly what went wrong. Give them a text to show yours instead.
 */
export const TEXTS = {
  send: 'Send to Live',
  sending: 'Sending {sounds}…',
  waiting: 'Waiting for Import in Live',
  inLive: 'In Live',
  partly: 'In Live: {done} of {total} sounds',
  sound: 'sound',
  sounds: 'sounds',
  pairTitle: 'Pair with LA2L in Live',
  pairText: 'In Live, click Pair app in LA2L and type the code it shows.',
  code: 'Code',
  pair: 'Pair',
  cancel: 'Cancel',
  noLa2l: 'No LA2L yet?',
  noSounds: 'There is nothing to send yet.',
  // Per error code: '' shows LA2L's own text.
  errorNotPaired: '',
  errorBadCode: '',
  errorRateLimited: '',
  errorServerFull: '',
  errorBadPackage: '',
  errorBadWav: '',
  errorExpired: '',
  errorImportFailed: '',
  errorNetwork: '',
  errorServer: '',
};
export type Texts = typeof TEXTS;

const ERROR_TEXT: Partial<Record<La2lErrorCode, keyof Texts>> = {
  not_paired: 'errorNotPaired',
  bad_code: 'errorBadCode',
  rate_limited: 'errorRateLimited',
  server_full: 'errorServerFull',
  bad_package: 'errorBadPackage',
  bad_wav: 'errorBadWav',
  expired: 'errorExpired',
  import_failed: 'errorImportFailed',
  network: 'errorNetwork',
  server: 'errorServer',
};

/** What the page gives the button: a send, or only the sounds. */
export type SoundsProvider = () => SendOptions | SoundInput[] | Promise<SendOptions | SoundInput[]>;

const CSS = `
:host { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 6px; font: var(--la2l-font, inherit); color: var(--la2l-text, inherit); }
button.send { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 18px 0 8px; border: 0; border-radius: var(--la2l-radius, 22px);
  background: var(--la2l-accent, #b4420e); color: var(--la2l-accent-text, #fff); font: inherit; font-weight: 650; cursor: pointer; }
button.send[aria-disabled=true] { opacity: .6; cursor: default; }
button.send:focus-visible, dialog button:focus-visible, dialog input:focus-visible { outline: 3px solid var(--la2l-focus, #1a73e8); outline-offset: 2px; }
button.send img { width: 30px; height: 30px; border-radius: 50%; background: #fff; }
.line { display: flex; gap: 6px; min-height: 1.3em; font-size: .9em; color: var(--la2l-muted, inherit); }
.status.bad { color: var(--la2l-bad, #b42318); }
.line.empty { display: none; }
dialog { max-width: 22rem; border: 1px solid var(--la2l-line, #d8d3c8); border-radius: 14px; padding: 18px 20px; color-scheme: var(--la2l-color-scheme, light);
  background: var(--la2l-dialog-background, #fff); color: var(--la2l-dialog-text, #1c1b18); font: var(--la2l-font, inherit); }
dialog::backdrop { background: rgb(0 0 0 / .35); }
dialog h2 { margin: 0 0 8px; font-size: 1.15em; }
dialog p { margin: 0 0 12px; }
dialog label { display: block; margin-bottom: 6px; font-weight: 600; }
dialog input { box-sizing: border-box; width: 100%; min-height: 44px; padding: 6px 12px; border: 1px solid var(--la2l-line, #d8d3c8); border-radius: 10px;
  background: var(--la2l-dialog-background, #fff); color: inherit; font: inherit; font-size: 1.3em; letter-spacing: .12em; text-transform: uppercase; }
dialog .problem { color: var(--la2l-bad, #b42318); min-height: 1.3em; margin: 8px 0 0; }
dialog .actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 12px; }
dialog .actions button { min-height: 40px; padding: 0 16px; border-radius: 10px; font: inherit; font-weight: 600; cursor: pointer;
  border: 1px solid var(--la2l-line, #d8d3c8); background: transparent; color: inherit; }
dialog .actions button[type=submit] { border: 0; background: var(--la2l-accent, #b4420e); color: var(--la2l-accent-text, #fff); }
dialog a { display: inline-block; margin-top: 12px; color: inherit; font-size: .9em; }
`;

const fill = (text: string, values: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => (k in values ? String(values[k]) : `{${k}}`));

// The styles go in as a constructed style sheet, which a strict Content-Security-Policy of the page
// allows; a <style> element is the fallback for older browsers.
function styleShadow(root: ShadowRoot): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch (e) {
    const style = document.createElement('style');
    style.textContent = CSS;
    root.append(style);
  }
}

// On a server, where pages are rendered before they reach a browser, there is no HTMLElement:
// the class is defined against an empty one there, and never registered.
const BaseElement: typeof HTMLElement = typeof HTMLElement === 'undefined' ? (class {} as unknown as typeof HTMLElement) : HTMLElement;

export class La2lSendButton extends BaseElement {
  static observedAttributes = ['app-name', 'server', 'app-id'];

  private soundsProvider: SoundsProvider | null = null;
  private ownTexts: Partial<Texts> = {};
  private client: LA2L | null = null;
  private readonly root: ShadowRoot;
  private readonly button: HTMLButtonElement;
  private readonly label: HTMLSpanElement;
  private readonly line: HTMLSpanElement;
  private readonly statusLine: HTMLSpanElement;
  private readonly percent: HTMLSpanElement;
  private readonly dialog: HTMLDialogElement;
  private busy = false;
  private following: AbortController | null = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    styleShadow(this.root);
    this.button = Object.assign(document.createElement('button'), { type: 'button', className: 'send' });
    this.button.setAttribute('part', 'button');
    const logo = Object.assign(document.createElement('img'), { src: LOGO, alt: '', width: 30, height: 30 });
    logo.setAttribute('part', 'logo');
    this.label = document.createElement('span');
    this.button.append(logo, this.label);
    // The status is a live region for screen readers; the percentage beside it is not, so a long
    // upload does not announce every step of it.
    this.line = Object.assign(document.createElement('span'), { className: 'line empty' });
    this.line.setAttribute('part', 'status');
    this.statusLine = Object.assign(document.createElement('span'), { className: 'status' });
    this.statusLine.setAttribute('role', 'status');
    this.statusLine.setAttribute('aria-live', 'polite');
    this.percent = document.createElement('span');
    this.percent.setAttribute('aria-hidden', 'true');
    this.line.append(this.statusLine, this.percent);
    this.dialog = document.createElement('dialog');
    this.dialog.setAttribute('part', 'dialog');
    this.root.append(this.button, this.line, this.dialog);
    this.button.addEventListener('click', () => this.run());
    // Properties a page set before this element was defined (a script that ran first, a framework)
    // sit on the element itself, hiding the setters below; take them over.
    const self = this as unknown as Record<string, unknown>;
    for (const name of ['sounds', 'texts']) {
      if (Object.prototype.hasOwnProperty.call(self, name)) {
        const value = self[name];
        delete self[name];
        self[name] = value;
      }
    }
  }

  /** Called at the click: returns the sounds to send, or a whole send with title and bpm. */
  get sounds(): SoundsProvider | null {
    return this.soundsProvider;
  }
  set sounds(provider: SoundsProvider | null) {
    this.soundsProvider = typeof provider === 'function' ? provider : null;
  }

  /** Texts to replace, see TEXTS. */
  get texts(): Partial<Texts> {
    return this.ownTexts;
  }
  set texts(texts: Partial<Texts>) {
    this.ownTexts = texts && typeof texts === 'object' ? texts : {};
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  attributeChangedCallback(): void {
    this.client = null; // made again with the new settings at the next click
    this.render();
  }

  private t(): Texts {
    return Object.assign({}, TEXTS, this.ownTexts);
  }

  private render(): void {
    if (this.label) this.label.textContent = this.t().send;
  }

  /** The client of this button, made from its attributes. Without app-name, the page title. */
  get la2l(): LA2L {
    if (!this.client) {
      const appName = this.getAttribute('app-name') || document.title || 'Web app';
      this.client = new LA2L({ appName, server: this.getAttribute('server') || undefined, appId: this.getAttribute('app-id') || undefined });
    }
    return this.client;
  }

  private say(text: string, bad = false, percent = ''): void {
    this.statusLine.textContent = text;
    this.statusLine.classList.toggle('bad', bad);
    this.percent.textContent = percent;
    this.line.classList.toggle('empty', !text);
  }

  // An error in the words of the page when it gave them, else in LA2L's.
  private errorText(e: unknown): string {
    if (e instanceof La2lError) {
      const key = ERROR_TEXT[e.code];
      const own = key ? this.t()[key] : '';
      return own || e.message;
    }
    return e instanceof Error ? e.message : String(e);
  }

  private emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true, composed: true }));
  }

  private setBusy(busy: boolean): void {
    // Not disabled: a disabled button loses the focus, and the focus must come back here after the
    // code dialog.
    this.busy = busy;
    this.button.setAttribute('aria-disabled', String(busy));
  }

  // The sounds from the sounds property, or from whoever answers the la2l-request event. A listener
  // must call event.detail.provide() before it returns; it may give it a promise.
  private async collect(): Promise<SendOptions | null> {
    let provided: SendOptions | SoundInput[] | Promise<SendOptions | SoundInput[]> | null = null;
    if (this.soundsProvider) provided = this.soundsProvider();
    else {
      const detail = { provide: (v: SendOptions | SoundInput[] | Promise<SendOptions | SoundInput[]>) => (provided = v) };
      this.dispatchEvent(new CustomEvent('la2l-request', { detail, bubbles: true, composed: true }));
    }
    const value = await provided;
    if (!value) return null;
    return Array.isArray(value) ? { sounds: value } : value;
  }

  // A click: pair when needed, then send. When the token turns out to be revoked (Unpair in Live),
  // the code is asked again once, and the send follows.
  private async run(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!this.la2l.paired && !(await this.askCode())) return;
        const send = await this.collect();
        if (!send || !send.sounds || !send.sounds.length) {
          this.say(this.t().noSounds, true);
          return;
        }
        try {
          await this.sendNow(send);
          return;
        } catch (e) {
          if (!(e instanceof La2lError && e.code === 'not_paired') || attempt > 0) throw e;
          this.say('');
        }
      }
    } catch (e) {
      this.say(this.errorText(e), true);
      this.emit('la2l-error', e);
    } finally {
      this.setBusy(false);
    }
  }

  private async sendNow(send: SendOptions): Promise<void> {
    const t = this.t();
    if (this.following) this.following.abort();
    const n = send.sounds.length;
    this.say(fill(t.sending, { sounds: `${n} ${n === 1 ? t.sound : t.sounds}` }), false, '0%');
    const delivery = await this.la2l.send(
      Object.assign({}, send, {
        onProgress: (share: number, p: Parameters<NonNullable<SendOptions['onProgress']>>[1]) => {
          this.percent.textContent = `${Math.floor(share * 100)}%`;
          if (send.onProgress) send.onProgress(share, p);
        },
      })
    );
    this.say(t.waiting);
    this.emit('la2l-sent', delivery);
    this.follow(delivery);
  }

  // "Waiting for Import in Live" until it is in Live. The button can send again meanwhile.
  private follow(delivery: Delivery): void {
    const t = this.t();
    const stop = new AbortController();
    this.following = stop;
    delivery
      .imported({ signal: stop.signal })
      .then((st: DeliveryStatus) => {
        if (stop.signal.aborted) return;
        const done = st.sounds.filter((x) => x.status === 'imported').length;
        this.say(st.status === 'imported' ? t.inLive : fill(t.partly, { done, total: st.sounds.length }));
        this.emit('la2l-imported', st);
      })
      .catch((e: unknown) => {
        if (stop.signal.aborted || (e instanceof La2lError && e.code === 'aborted')) return;
        this.say(this.errorText(e), true);
        this.emit('la2l-error', e);
      });
  }

  /** Shows the code dialog. Resolves to true when the app is paired. */
  private askCode(): Promise<boolean> {
    const t = this.t();
    const d = this.dialog;
    d.replaceChildren();
    const form = document.createElement('form');
    const title = Object.assign(document.createElement('h2'), { textContent: t.pairTitle, id: 'la2l-pair-title' });
    d.setAttribute('aria-labelledby', 'la2l-pair-title');
    const text = Object.assign(document.createElement('p'), { textContent: t.pairText });
    const label = Object.assign(document.createElement('label'), { textContent: t.code, htmlFor: 'la2l-code' });
    const input = Object.assign(document.createElement('input'), { id: 'la2l-code', autocomplete: 'off', spellcheck: false, maxLength: 12, placeholder: 'K7P 42Q', required: true });
    input.setAttribute('autocapitalize', 'characters');
    const problem = Object.assign(document.createElement('p'), { className: 'problem' });
    problem.setAttribute('role', 'alert');
    const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: t.cancel });
    const ok = Object.assign(document.createElement('button'), { type: 'submit', textContent: t.pair });
    const actions = Object.assign(document.createElement('div'), { className: 'actions' });
    actions.append(cancel, ok);
    const link = Object.assign(document.createElement('a'), { href: 'https://lloydstellar.nl/la2l/', target: '_blank', rel: 'noopener', textContent: t.noLa2l });
    form.append(title, text, label, input, problem, actions, link);
    d.append(form);
    return new Promise((resolve) => {
      let paired = false;
      const close = () => {
        if (d.open) d.close();
      };
      d.addEventListener(
        'close',
        () => {
          this.button.focus();
          resolve(paired);
        },
        { once: true }
      );
      cancel.addEventListener('click', close);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        ok.disabled = true;
        problem.textContent = '';
        try {
          const { deviceName } = await this.la2l.pair(input.value);
          paired = true;
          this.emit('la2l-paired', { deviceName });
          close();
        } catch (e) {
          problem.textContent = this.errorText(e);
          input.focus();
        } finally {
          ok.disabled = false;
        }
      });
      d.showModal();
      input.focus();
    });
  }

  /** Unpairs this page: the server revokes the token. Rejects with `network` when it cannot be reached. */
  async unpair(): Promise<void> {
    await this.la2l.unpair();
    this.say('');
  }
}

if (typeof customElements !== 'undefined' && !customElements.get('la2l-send-button')) customElements.define('la2l-send-button', La2lSendButton);

declare global {
  interface HTMLElementTagNameMap {
    'la2l-send-button': La2lSendButton;
  }
}

export { LA2L } from './client.js';
export { La2lError } from './errors.js';
export { wavFromAudioBuffer, wavFromSamples, toWav } from './audio.js';
