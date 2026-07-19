/**
 * Flamingo UI - transient toast notifications.
 *
 * A fixed bottom-center stack of dismissable messages, newest on top, capped
 * at MAX_VISIBLE. Errors linger longer than info. Click a toast to dismiss it
 * early. Pure DOM (no framework); styling lives in style.css under `.toast*`.
 * main.ts uses this to surface op rejections streamed back over the websocket,
 * and it's reusable by any later feature that needs a non-blocking notice.
 */

export type ToastKind = 'error' | 'info';

const MAX_VISIBLE = 4;
const DISMISS_MS: Record<ToastKind, number> = { error: 6000, info: 3000 };
// Matches the .toast opacity transition in style.css -- remove after the fade.
const FADE_MS = 200;

let container: HTMLElement | null = null;

function ensureContainer(): HTMLElement {
  if (container && container.isConnected) return container;
  const el = document.createElement('div');
  el.className = 'toast-stack';
  document.body.appendChild(el);
  container = el;
  return el;
}

/** Show a transient notice. Auto-dismisses (errors 6s, info 3s); click to dismiss early. */
export function showToast(message: string, kind: ToastKind = 'info'): void {
  const stack = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

  let done = false;
  const dismiss = (): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    toast.classList.add('toast-leaving');
    setTimeout(() => toast.remove(), FADE_MS);
  };
  toast.addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, DISMISS_MS[kind]);

  // Newest on top: prepend, then trim the oldest beyond the cap.
  stack.prepend(toast);
  while (stack.children.length > MAX_VISIBLE) {
    stack.lastElementChild?.remove();
  }
}
