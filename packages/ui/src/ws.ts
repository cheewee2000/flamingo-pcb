/**
 * Flamingo UI - auto-reconnecting WebSocket client.
 *
 * Connects to the same-origin `/ws` endpoint (no hardcoded host/port -- the
 * Vite dev proxy forwards it to the real server in dev, and in production
 * the UI is served by that same server). On connect, and again on every
 * board change, the server pushes `{type:'board', board}`; edits go out as
 * `{type:'op', op}`. If the connection drops, reconnect after a fixed 1s
 * delay.
 */

import type { Board, Op } from '@flamingo/engine';

/**
 * Live autoroute status broadcast to every client (mirrors the server's
 * RouteStatus in autoroute.ts): a stream of `running` updates during a route,
 * then one terminal `done` or `failed`. `stage` is 'route' (main pass) or
 * 'retry' (escape-width re-route of the still-unrouted nets).
 */
export interface RouteStatus {
  state: 'running' | 'done' | 'failed';
  stage?: 'route' | 'retry';
  pass?: number;
  unrouted?: number;
  score?: number;
  message?: string;
}

export interface WsHandlers {
  onBoard: (board: Board) => void;
  onConnectionChange: (connected: boolean) => void;
  /** Optional: surface op rejections (e.g. to a toast/log). */
  onOpResult?: (result: { ok: boolean; error?: string }) => void;
  /** Optional: live autoroute progress (broadcast to all clients). */
  onRouteStatus?: (status: RouteStatus) => void;
}

type ServerMsg =
  | { type: 'board'; board: Board }
  | { type: 'opResult'; result: { ok: boolean; error?: string } }
  | { type: 'routeStatus'; status: RouteStatus };

const RECONNECT_DELAY_MS = 1000;

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}

/** Start (and maintain) a reconnecting WS connection. Returns a `sendOp` fn. */
export function connectWs(handlers: WsHandlers): { sendOp: (op: Op) => void } {
  let socket: WebSocket | null = null;

  function scheduleReconnect(): void {
    setTimeout(open, RECONNECT_DELAY_MS);
  }

  function open(): void {
    const ws = new WebSocket(wsUrl());
    socket = ws;

    ws.addEventListener('open', () => {
      handlers.onConnectionChange(true);
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'board') {
        handlers.onBoard(msg.board);
      } else if (msg.type === 'opResult') {
        handlers.onOpResult?.(msg.result);
      } else if (msg.type === 'routeStatus') {
        handlers.onRouteStatus?.(msg.status);
      }
    });

    const onDown = (): void => {
      if (socket === ws) socket = null;
      handlers.onConnectionChange(false);
      scheduleReconnect();
    };
    ws.addEventListener('close', onDown);
    ws.addEventListener('error', () => {
      // 'close' always follows 'error' for browser WebSocket, so reconnection
      // is scheduled there -- this handler just avoids an unhandled event.
    });
  }

  open();

  return {
    sendOp(op: Op): void {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'op', op }));
      }
    },
  };
}
