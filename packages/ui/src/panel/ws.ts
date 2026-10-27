/**
 * Panel view - WebSocket client for the panel channel (/ws?channel=panel).
 * Mirrors the board editor's client (../ws.ts): reconnects after a fixed
 * delay, receives `{type:'panel', view}` and `{type:'loading', loading}`,
 * sends `{type:'op', op}`.
 */

import type { PanelLoading, PanelOp, PanelView } from '@flamingo/panel';

export interface PanelWsHandlers {
  onView: (view: PanelView) => void;
  onConnectionChange: (connected: boolean) => void;
  onOpResult?: (result: { ok: boolean; error?: string }) => void;
  onLoading?: (loading: PanelLoading | null) => void;
}

type ServerMsg =
  | { type: 'panel'; view: PanelView }
  | { type: 'opResult'; result: { ok: boolean; error?: string } }
  | { type: 'loading'; loading: PanelLoading | null };

const RECONNECT_DELAY_MS = 1000;

export function connectPanelWs(handlers: PanelWsHandlers): { sendOp: (op: PanelOp) => boolean } {
  let socket: WebSocket | null = null;

  function open(): void {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws?channel=panel`);
    socket = ws;
    ws.addEventListener('open', () => handlers.onConnectionChange(true));
    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch {
        return;
      }
      if (msg.type === 'panel') handlers.onView(msg.view);
      else if (msg.type === 'opResult') handlers.onOpResult?.(msg.result);
      else if (msg.type === 'loading') handlers.onLoading?.(msg.loading);
    });
    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      handlers.onConnectionChange(false);
      setTimeout(open, RECONNECT_DELAY_MS);
    });
    ws.addEventListener('error', () => {
      // 'close' follows and schedules the reconnect.
    });
  }

  open();

  return {
    sendOp(op: PanelOp): boolean {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'op', op }));
      return true;
    },
  };
}
