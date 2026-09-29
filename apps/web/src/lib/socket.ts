import type { ClientMessage, ServerMessage } from "./types.js";

type Listener = (msg: ServerMessage) => void;

/**
 * The session's WebSocket. Reconnects with backoff; after a reconnect the server re-sends the
 * session view and topology, and open terminals are re-opened by their owners (onReconnect).
 */
export class SessionSocket {
  private ws: WebSocket | undefined;
  private listeners = new Set<Listener>();
  private reconnectHandlers = new Set<() => void>();
  private attempts = 0;
  private closed = false;
  private everOpen = false;
  private statusListeners = new Set<(connected: boolean) => void>();
  connected = false;

  constructor(private readonly url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/session/ws`) {
    this.connect();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.setConnected(true);
      this.attempts = 0;
      if (this.everOpen) for (const h of this.reconnectHandlers) h();
      this.everOpen = true;
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      for (const l of this.listeners) l(msg);
    };
    ws.onclose = () => {
      this.setConnected(false);
      if (this.closed) return;
      const delay = Math.min(10_000, 500 * 2 ** this.attempts++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private setConnected(value: boolean): void {
    this.connected = value;
    for (const l of this.statusListeners) l(value);
  }

  onStatus(listener: (connected: boolean) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => this.reconnectHandlers.delete(handler);
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
