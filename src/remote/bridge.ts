import type { RemoteCommand, RemoteState } from './remote';

export type BridgeStatus = 'offline' | 'connecting' | 'online';

export class RemoteBridge {
  private socket: WebSocket | null = null;
  private url = '';
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private manualClose = true;
  private status: BridgeStatus = 'offline';

  private commandHandler: ((command: RemoteCommand) => void) | null = null;
  private statusHandler: ((status: BridgeStatus, detail: string) => void) | null = null;

  onCommand(handler: (command: RemoteCommand) => void): void {
    this.commandHandler = handler;
  }

  onStatus(handler: (status: BridgeStatus, detail: string) => void): void {
    this.statusHandler = handler;
  }

  get currentUrl(): string {
    return this.url;
  }

  connect(url: string): void {
    if (!/^wss?:\/\//i.test(url)) {
      this.setStatus('offline', 'URL must start with ws:// or wss://');
      return;
    }
    this.disconnect();
    this.url = url;
    this.manualClose = false;
    this.attempts = 0;
    this.open();
  }

  disconnect(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setStatus('offline', 'Disconnected');
  }

  send(state: RemoteState): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(state));
    }
  }

  private open(): void {
    this.setStatus('connecting', `Connecting to ${this.url}…`);
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch {
      this.setStatus('offline', 'Could not open the bridge connection');
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempts = 0;
      this.setStatus('online', `Connected to ${this.url}`);
    });

    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'command') {
          this.commandHandler?.(message as RemoteCommand);
        }
      } catch {
        /* ignore malformed frames */
      }
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      if (this.manualClose) {
        this.setStatus('offline', 'Disconnected');
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (this.socket === socket) {
        this.setStatus('offline', 'Bridge connection failed');
      }
    });
  }

  private scheduleReconnect(): void {
    this.attempts += 1;
    const delay = Math.min(8000, 600 * this.attempts);
    this.setStatus('connecting', `Reconnecting in ${(delay / 1000).toFixed(1)}s…`);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.manualClose) this.open();
    }, delay);
  }

  private setStatus(status: BridgeStatus, detail: string): void {
    this.status = status;
    this.statusHandler?.(status, detail);
  }

  get currentStatus(): BridgeStatus {
    return this.status;
  }
}
