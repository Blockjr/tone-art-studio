import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`Timeout opening ${url}`));
    }, 4000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error(`Could not open ${url}`));
    });
  });
}

function nextMessage(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No ${type} frame`)), 4000);
    const onMessage = (event: MessageEvent): void => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      resolve(message);
    };
    socket.addEventListener('message', onMessage);
  });
}

describe('remote bridge server', () => {
  let child: ChildProcessWithoutNullStreams;
  let port = 0;
  const token = 'test-token-value';

  beforeAll(async () => {
    port = await freePort();
    child = spawn(process.execPath, ['server/remote.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        REMOTE_PORT: String(port),
        REMOTE_HOST: '127.0.0.1',
        REMOTE_TOKEN: token,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge did not start')), 6000);
      let output = '';
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        if (output.includes('tablet page')) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Bridge exited (${code}): ${output}`));
      });
    });
  }, 12000);

  afterAll(() => {
    child?.kill('SIGTERM');
  });

  it('serves the controller, its offline worker and address info', async () => {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('connect-dialog');
    expect(html).toContain('id="record"');
    expect(html).toContain('/app.js');

    const worker = await fetch(`http://127.0.0.1:${port}/service-worker.js`);
    expect(worker.status).toBe(200);
    expect(worker.headers.get('service-worker-allowed')).toBe('/');
    expect(await worker.text()).toContain('toneart-remote');

    const unauthorized = await fetch(`http://127.0.0.1:${port}/info`);
    expect(unauthorized.status).toBe(401);
    const info = (await (await fetch(`http://127.0.0.1:${port}/info?token=${token}`)).json()) as {
      tokenRequired: boolean;
      urls: { local: string; lan: string[] };
      port: number;
    };
    expect(info.tokenRequired).toBe(true);
    expect(info.port).toBe(port);
    expect(info.urls.local).toBe(`http://localhost:${port}`);
    expect(Array.isArray(info.urls.lan)).toBe(true);

    const health = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).json()) as { ok: boolean };
    expect(health.ok).toBe(true);
  });

  it('rejects a tablet without the token, then relays both ways with it', async () => {
    const denied = new WebSocket(`ws://127.0.0.1:${port}/ws?role=tablet`);
    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('No close')), 4000);
      denied.addEventListener('close', (event) => {
        clearTimeout(timer);
        resolve(event.code);
      });
    });
    expect(code).toBe(4401);

    const desktop = await open(`ws://127.0.0.1:${port}/ws?role=desktop&token=${token}`);
    const tablet = await open(`ws://127.0.0.1:${port}/ws?role=tablet&token=${token}`);

    const hello = await nextMessage(tablet, 'hello');
    expect(hello.role).toBe('tablet');

    desktop.send(JSON.stringify({ type: 'state', bpm: 101, tracks: [] }));
    const snapshot = await nextMessage(tablet, 'state');
    expect(snapshot.bpm).toBe(101);

    tablet.send(JSON.stringify({ type: 'command', kind: 'transport', action: 'toggle' }));
    const command = await nextMessage(desktop, 'command');
    expect(command.kind).toBe('transport');

    desktop.close();
    tablet.close();
  });
});
