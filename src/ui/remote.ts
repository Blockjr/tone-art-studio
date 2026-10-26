import {
  bridgeForHost,
  linkLabel,
  parseBridgeLink,
  tabletLink,
  withToken,
  type BridgeLink,
} from '../remote/link';
import type { BridgeStatus, RemoteBridge } from '../remote/bridge';
import { qrMatrix, qrPath } from '../remote/qr';
import { el } from './controls';

const ADDRESS_KEY = 'toneart.remote.address';
const TOKEN_KEY = 'toneart.remote.token';

interface BridgeInfo {
  urls?: { local?: string; lan?: string[]; public?: string | null };
  tokenRequired?: boolean;
  secure?: boolean;
}

function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* private mode: the field still works for this session */
  }
}

export class RemotePanel {
  private bridge: RemoteBridge;
  private root: HTMLElement;
  private statusLine: HTMLElement;
  private address: HTMLInputElement;
  private token: HTMLInputElement;
  private connectButton: HTMLButtonElement;
  private detectButton: HTMLButtonElement;
  private tabletLink: HTMLElement;
  private foundRow: HTMLElement;
  private modeTag: HTMLElement;
  private qrWrap: HTMLElement;
  private qrButton: HTMLButtonElement;
  private qrVisible = false;
  private qrTimer: number | null = null;

  constructor(bridge: RemoteBridge) {
    this.bridge = bridge;
    this.root = el('aside', 'agent remote-panel');

    const head = el('header', 'agent-head');
    const dot = el('span', 'agent-dot');
    dot.style.background = 'var(--blue)';
    dot.style.boxShadow = '0 0 10px rgba(77, 141, 255, 0.9)';
    const title = el('div', 'agent-title');
    title.append(el('strong', '', 'Tablet Remote'), el('span', '', 'LAN or internet bridge'));
    const close = el('button', 'tbtn tbtn-sm', '✕');
    close.addEventListener('click', () => this.close());
    head.append(dot, title, close);

    const body = el('div', 'agent-body');
    body.appendChild(
      el(
        'p',
        'agent-intro',
        'Run the bridge on the computer hosting this session. A tablet on the same Wi-Fi needs no internet at all; from another network, use a tunnel or forwarded port with an access token.',
      ),
    );

    const savedAddress = readStored(ADDRESS_KEY) || `${location.protocol}//${location.hostname || 'localhost'}:8787`;
    const savedToken = readStored(TOKEN_KEY);
    const initial = parseBridgeLink(savedAddress) ?? bridgeForHost(location.hostname);

    this.modeTag = el('span', 'remote-mode', linkLabel(initial.kind));

    this.address = el('input', 'remote-input');
    this.address.type = 'text';
    this.address.spellcheck = false;
    this.address.autocomplete = 'off';
    this.address.value = savedAddress;
    this.address.placeholder = '192.168.1.20:8787 or https://studio.example.com';
    this.address.setAttribute('aria-label', 'Bridge address');

    this.token = el('input', 'remote-input');
    this.token.type = 'password';
    this.token.autocomplete = 'off';
    this.token.value = savedToken;
    this.token.placeholder = 'bridge token (optional)';
    this.token.setAttribute('aria-label', 'Bridge access token');

    this.connectButton = el('button', 'agent-run', 'Connect');
    this.connectButton.addEventListener('click', () => {
      if (this.bridge.currentStatus === 'online') {
        this.bridge.disconnect();
        return;
      }
      this.connect();
    });

    this.detectButton = el('button', 'agent-run remote-detect', 'Detect');
    this.detectButton.title = 'Ask the bridge for its Wi-Fi and public addresses';
    this.detectButton.addEventListener('click', () => void this.detect());

    const buttons = el('div', 'remote-buttons');
    buttons.append(this.connectButton, this.detectButton);

    this.statusLine = el('div', 'agent-status', 'Offline');
    this.tabletLink = el('div', 'remote-tablet');
    this.foundRow = el('div', 'remote-found');
    this.qrWrap = el('div', 'remote-qr');
    this.qrButton = el('button', 'tbtn tbtn-sm remote-qr-toggle', 'QR code');
    this.qrButton.type = 'button';
    this.qrButton.title = 'Show a QR code the phone camera can scan';
    this.qrButton.addEventListener('click', () => this.toggleQr());

    const addressLabel = el('div', 'section-title');
    addressLabel.append(document.createTextNode('Bridge address '), this.modeTag);
    const tokenLabel = el('div', 'section-title', 'Access token');

    const steps = el('div', 'remote-steps');
    steps.append(
      el('div', 'section-title', 'How to connect'),
      el('p', 'agent-suggestion-detail', '1. On the studio computer run: npm run remote'),
      el('p', 'agent-suggestion-detail', '2. Same Wi-Fi or a phone hotspot: scan the QR code, or open the LAN address Detect finds.'),
      el('p', 'agent-suggestion-detail', '3. Away from the studio: set REMOTE_TOKEN, expose port 8787 (tunnel or port forward), then paste the https address here and on the tablet.'),
      el('p', 'agent-suggestion-detail', '4. Add the tablet page to the home screen once to keep an offline copy of the controller.'),
      el('p', 'agent-suggestion-detail', 'Nothing leaves your network unless you add a tunnel yourself.'),
    );

    body.append(
      addressLabel,
      this.address,
      tokenLabel,
      this.token,
      buttons,
      this.statusLine,
      this.tabletLink,
      this.qrWrap,
      this.foundRow,
      steps,
    );
    this.root.append(head, body);

    this.bridge.onStatus((status, detail) => this.renderStatus(status, detail));
    this.address.addEventListener('change', () => this.refreshTabletLink());
    this.token.addEventListener('change', () => {
      writeStored(TOKEN_KEY, this.token.value.trim());
      this.refreshTabletLink();
    });
  }

  mount(): void {
    document.body.appendChild(this.root);
  }

  toggle(): void {
    this.root.classList.toggle('is-open');
  }

  close(): void {
    this.root.classList.remove('is-open');
    this.hideQr();
  }

  private link(): BridgeLink | null {
    return parseBridgeLink(this.address.value);
  }

  private connect(): void {
    const link = this.link();
    if (!link) {
      this.setStatus('That address does not look like a bridge address.', 'var(--rose)');
      return;
    }
    writeStored(ADDRESS_KEY, this.address.value.trim());
    writeStored(TOKEN_KEY, this.token.value.trim());
    this.modeTag.textContent = linkLabel(link.kind);
    this.bridge.connect(withToken(link.ws, this.token.value));
    this.refreshTabletLink();
  }

  private refreshTabletLink(): void {
    const link = this.link();
    this.tabletLink.replaceChildren();
    if (!link) {
      this.renderQr();
      return;
    }

    const page = tabletLink(link, this.token.value.trim());
    const label = el('span', 'remote-tablet-url', page.replace(/([?&]token=)[^&]*/, '$1…'));
    const open = el('button', 'agent-run remote-open', 'Open tablet page');
    open.addEventListener('click', () => window.open(page, '_blank', 'noopener,noreferrer'));
    const copy = el('button', 'tbtn tbtn-sm', 'Copy');
    copy.title = 'Copy the tablet link';
    copy.addEventListener('click', () => {
      const text = page;
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text).then(
          () => this.setStatus('Tablet link copied.', 'var(--green)'),
          () => this.setStatus('Could not copy — select the link instead.', 'var(--amber)'),
        );
      } else {
        this.setStatus('Copy this link: ' + text, 'var(--dim)');
      }
    });
    this.tabletLink.append(label, open, copy, this.qrButton);
    this.renderQr();
  }

  /**
   * Shows the tablet link as a code the phone camera can read, so nobody has to
   * type an address and a token on a touch keyboard. The code is drawn here and
   * never uploaded, and it is hidden again on its own because it carries the
   * access token.
   */
  private toggleQr(): void {
    if (this.qrVisible) this.hideQr();
    else this.showQr();
  }

  private showQr(): void {
    this.qrVisible = true;
    if (this.qrTimer !== null) window.clearTimeout(this.qrTimer);
    this.qrTimer = window.setTimeout(() => {
      this.qrTimer = null;
      this.hideQr();
    }, 120_000);
    this.renderQr();
  }

  private hideQr(): void {
    this.qrVisible = false;
    if (this.qrTimer !== null) {
      window.clearTimeout(this.qrTimer);
      this.qrTimer = null;
    }
    this.renderQr();
  }

  private renderQr(): void {
    this.qrButton.textContent = this.qrVisible ? 'Hide QR' : 'QR code';
    this.qrButton.disabled = !this.link();
    this.qrWrap.classList.toggle('is-open', this.qrVisible);
    this.qrWrap.replaceChildren();
    if (!this.qrVisible) return;

    const link = this.link();
    if (!link) {
      this.qrWrap.textContent = 'Enter a bridge address first.';
      return;
    }

    const page = tabletLink(link, this.token.value.trim());
    let matrix: boolean[][];
    try {
      matrix = qrMatrix(page);
    } catch {
      this.qrWrap.textContent = 'This link is too long for a QR code — use Copy instead.';
      return;
    }

    const ns = 'http://www.w3.org/2000/svg';
    const quiet = 4;
    const span = matrix.length + quiet * 2;
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `${-quiet} ${-quiet} ${span} ${span}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code for the tablet link');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', qrPath(matrix));
    svg.appendChild(path);
    this.qrWrap.appendChild(svg);

    this.qrWrap.appendChild(
      el(
        'p',
        'remote-qr-note',
        link.kind === 'local'
          ? 'This address only works on the studio computer. Press Detect, or enter the computer’s Wi-Fi or hotspot address, before scanning.'
          : 'Scan with the phone camera. It carries the access token, so hide it once the phone is connected.',
      ),
    );
  }

  /** Asks the running bridge for the addresses it can be reached on. */
  private async detect(): Promise<void> {
    const link = this.link() ?? bridgeForHost(location.hostname);
    this.detectButton.disabled = true;
    this.setStatus('Looking for the bridge…', 'var(--amber)');
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(withToken(`${link.http}/info`, this.token.value), {
        signal: controller.signal,
        cache: 'no-store',
      });
      if (response.status === 401) {
        this.setStatus('Bridge found. Enter its REMOTE_TOKEN to list the addresses.', 'var(--amber)');
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = (await response.json()) as BridgeInfo;
      const urls = [info.urls?.local, ...(info.urls?.lan ?? []), info.urls?.public].filter(
        (url): url is string => Boolean(url),
      );

      this.foundRow.replaceChildren();
      if (urls.length === 0) {
        this.foundRow.textContent = 'The bridge answered but listed no addresses.';
      } else {
        for (const url of urls) {
          const parsed = parseBridgeLink(url);
          if (!parsed) continue;
          const chip = el('button', 'remote-address', `${linkLabel(parsed.kind)} · ${url.replace(/^https?:\/\//, '')}`);
          chip.type = 'button';
          chip.title = `Use ${url}`;
          chip.addEventListener('click', () => {
            this.address.value = parsed.http;
            writeStored(ADDRESS_KEY, parsed.http);
            this.modeTag.textContent = linkLabel(parsed.kind);
            this.refreshTabletLink();
            this.setStatus(`Address set to ${parsed.http}.`, 'var(--blue)');
          });
          this.foundRow.appendChild(chip);
        }
      }
      if (info.tokenRequired) {
        this.setStatus(
          info.secure
            ? 'Bridge found. It requires a token — enter the REMOTE_TOKEN value.'
            : 'Bridge found. This bridge requires an access token.',
          'var(--amber)',
        );
      } else {
        this.setStatus('Bridge found. Pick an address below.', 'var(--green)');
      }
    } catch {
      this.setStatus('No bridge answered at that address. Is npm run remote running?', 'var(--rose)');
    } finally {
      window.clearTimeout(timeout);
      this.detectButton.disabled = false;
      this.refreshTabletLink();
    }
  }

  private setStatus(text: string, color: string): void {
    this.statusLine.textContent = text;
    this.statusLine.style.color = color;
  }

  private renderStatus(status: BridgeStatus, detail: string): void {
    this.statusLine.textContent = detail;
    this.statusLine.style.color =
      status === 'online' ? 'var(--green)' : status === 'connecting' ? 'var(--amber)' : 'var(--dim-2)';
    this.connectButton.textContent = status === 'online' ? 'Disconnect' : 'Connect';
    this.refreshTabletLink();
  }
}
