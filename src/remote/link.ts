/**
 * Bridge addresses for the tablet remote.
 *
 * The remote works on three kinds of link and they are all the same protocol:
 * a loopback bridge on the studio machine, a LAN address over Wi-Fi, or a
 * public HTTPS/WSS address when the bridge is exposed through a tunnel or a
 * forwarded port. These helpers turn whatever the user types into a canonical
 * tablet page and WebSocket endpoint, and keep the access token out of the
 * display while still attaching it to the connection.
 */

export type LinkKind = 'local' | 'lan' | 'internet';

export interface BridgeLink {
  /** canonical http(s) base used for the tablet page */
  http: string;
  /** websocket endpoint the desktop and tablet connect to */
  ws: string;
  kind: LinkKind;
}

const SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/** Private IPv4 ranges plus names that only resolve on a local network. */
function kindOf(hostname: string): LinkKind {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) return 'local';
  if (host.endsWith('.local') || !host.includes('.')) return 'lan';
  const octets = host.split('.').map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    if (a === 10) return 'lan';
    if (a === 192 && b === 168) return 'lan';
    if (a === 172 && b >= 16 && b <= 31) return 'lan';
    if (a === 169 && b === 254) return 'lan';
  }
  return 'internet';
}

/**
 * Accepts the many shapes a user might paste: `192.168.1.20:8787`,
 * `http://studio.local:8787`, `ws://host:8787/ws`, or a full tunnel URL.
 * Paths are dropped because the bridge always serves its UI at the root.
 */
export function parseBridgeLink(input: string): BridgeLink | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (!SCHEMES.has(url.protocol) || !url.hostname) return null;

  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const http = `${secure ? 'https' : 'http'}://${url.host}`;
  const ws = `${secure ? 'wss' : 'ws'}://${url.host}/ws`;
  return { http, ws, kind: kindOf(url.hostname) };
}

/** Adds an access token to a URL without disturbing any existing query. */
export function withToken(target: string, token: string | null | undefined): string {
  const trimmed = (token ?? '').trim();
  if (!trimmed) return target;
  try {
    const url = new URL(target);
    url.searchParams.set('token', trimmed);
    return url.toString();
  } catch {
    return target;
  }
}

/** The address the bridge would use on the machine the desktop app runs on. */
export function bridgeForHost(hostname: string, port = 8787): BridgeLink {
  const host = hostname && hostname !== '0.0.0.0' && hostname !== '::' ? hostname : 'localhost';
  const link = parseBridgeLink(`http://${host}:${port}`);
  // `localhost` and `127.0.0.1` are always valid inputs; the fallback is only
  // here so the panel always has something to show.
  return link ?? { http: `http://localhost:${port}`, ws: `ws://localhost:${port}/ws`, kind: 'local' };
}

/** Page URL for a tablet, optionally carrying the token in the query. */
export function tabletLink(link: BridgeLink, token?: string): string {
  return withToken(link.http, token);
}

/**
 * Reconnect delay with exponential backoff and jitter: 0.6 s, 1.0 s, 1.7 s …
 * capped at 8 s. Jitter keeps several tablets from reconnecting in lockstep.
 */
export function reconnectDelay(attempt: number, random = Math.random()): number {
  const step = Math.max(1, Math.round(attempt));
  const base = Math.min(8000, 600 * Math.pow(1.7, step - 1));
  const jitter = 0.85 + Math.max(0, Math.min(1, random)) * 0.3;
  return Math.round(base * jitter);
}

export function linkLabel(kind: LinkKind): string {
  if (kind === 'local') return 'This computer';
  if (kind === 'lan') return 'Wi-Fi / LAN';
  return 'Internet';
}
