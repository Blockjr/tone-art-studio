// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemotePanel } from '../src/ui/remote';
import type { BridgeStatus, RemoteBridge } from '../src/remote/bridge';

function fakeBridge(): RemoteBridge {
  return {
    currentStatus: 'offline' as BridgeStatus,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn(),
    onStatus: vi.fn(),
    onCommand: vi.fn(),
  } as unknown as RemoteBridge;
}

function openPanel(address: string, token = ''): RemotePanel {
  const panel = new RemotePanel(fakeBridge());
  panel.mount();
  panel.toggle();

  const inputs = document.querySelectorAll<HTMLInputElement>('.remote-panel .remote-input');
  inputs[0].value = address;
  inputs[0].dispatchEvent(new Event('change'));
  inputs[1].value = token;
  inputs[1].dispatchEvent(new Event('change'));
  return panel;
}

function qrButton(): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>('.remote-qr-toggle')!;
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('remote panel QR code', () => {
  it('draws the tablet link on demand and hides it again', () => {
    openPanel('http://192.168.1.20:8787', 'secret-token');

    const empty = document.querySelector('.remote-qr')!;
    expect(empty.querySelector('svg')).toBeNull();
    expect(empty.classList.contains('is-open')).toBe(false);
    expect(qrButton().disabled).toBe(false);

    qrButton().click();
    const wrap = document.querySelector('.remote-qr')!;
    expect(wrap.classList.contains('is-open')).toBe(true);

    const svg = wrap.querySelector('svg')!;
    // 29 modules for this link plus a four-module quiet zone on each side.
    expect(svg.getAttribute('viewBox')).toBe('-4 -4 37 37');
    const path = svg.querySelector('path')!;
    expect((path.getAttribute('d') ?? '').length).toBeGreaterThan(100);
    expect(wrap.querySelector('.remote-qr-note')?.textContent).toMatch(/access token/i);

    // The same button closes it again.
    qrButton().click();
    expect(document.querySelector('.remote-qr svg')).toBeNull();
    expect(qrButton().textContent).toBe('QR code');
  });

  it('warns when the address only resolves on the studio computer', () => {
    openPanel('http://localhost:8787', 'secret-token');
    qrButton().click();

    const note = document.querySelector('.remote-qr-note')!;
    expect(note.textContent).toMatch(/only works on the studio computer/i);
  });

  it('leaves no code behind when the panel is closed', () => {
    const panel = openPanel('http://10.0.0.5:8787', 'secret-token');
    qrButton().click();
    expect(document.querySelector('.remote-qr svg')).not.toBeNull();

    panel.close();
    expect(document.querySelector('.remote-qr svg')).toBeNull();
    expect(document.querySelector('.remote-qr')!.classList.contains('is-open')).toBe(false);
  });

  it('refuses to draw a code for an address that is not a bridge link', () => {
    openPanel('http://192.168.1.20:8787');
    const inputs = document.querySelectorAll<HTMLInputElement>('.remote-panel .remote-input');
    inputs[0].value = 'not a link';
    inputs[0].dispatchEvent(new Event('change'));

    expect(document.querySelector('.remote-qr-toggle')).toBeNull();
    expect(document.querySelector('.remote-qr svg')).toBeNull();
  });
});
