/**
 * attachViewControls pointer bindings. The UI test suite runs in the node
 * environment (no jsdom), so we drive the handlers through a minimal
 * EventTarget-ish stub for the canvas + a stubbed global `window`, dispatching
 * plain mouse-event-shaped objects. This is enough to assert the pan gestures
 * (middle / right / space+left) and the context-menu suppression without a DOM.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachViewControls } from '../src/view.js';
import type { ViewTransform } from '../src/state.js';

type Listener = (ev: any) => void;

/** Minimal add/removeEventListener + dispatch, plus the canvas bits view.ts touches. */
class FakeEl {
  listeners = new Map<string, Set<Listener>>();
  classList = { add: vi.fn(), remove: vi.fn() };
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  getBoundingClientRect(): { left: number; top: number } {
    return { left: 0, top: 0 };
  }
  dispatch(type: string, ev: Record<string, unknown>): void {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

function mouseEvent(over: Record<string, unknown>): Record<string, unknown> {
  return { button: 0, clientX: 0, clientY: 0, preventDefault: vi.fn(), ...over };
}

const initialView: ViewTransform = { scale: 10, originPxX: 100, originPxY: 100, flipped: false };

describe('attachViewControls - pan gestures', () => {
  let canvas: FakeEl;
  let win: FakeEl;
  let view: ViewTransform;
  const setView = (v: ViewTransform) => {
    view = v;
  };

  beforeEach(() => {
    canvas = new FakeEl();
    win = new FakeEl();
    (globalThis as any).window = win;
    view = { ...initialView };
  });

  afterEach(() => {
    delete (globalThis as any).window;
  });

  it('right-button drag pans the view by the screen-space delta', () => {
    const controls = attachViewControls(canvas as unknown as HTMLCanvasElement, () => view, setView);

    const down = mouseEvent({ button: 2, clientX: 200, clientY: 150 });
    canvas.dispatch('mousedown', down);
    expect(down.preventDefault).toHaveBeenCalled();
    expect(controls.isPanning()).toBe(true);

    win.dispatch('mousemove', mouseEvent({ clientX: 230, clientY: 180 }));
    // panBy adds the raw px delta to the origin.
    expect(view.originPxX).toBe(130); // 100 + (230 - 200)
    expect(view.originPxY).toBe(130); // 100 + (180 - 150)

    win.dispatch('mouseup', mouseEvent({ button: 2 }));
    expect(controls.isPanning()).toBe(false);
  });

  it('middle-button drag still pans (unchanged)', () => {
    const controls = attachViewControls(canvas as unknown as HTMLCanvasElement, () => view, setView);
    canvas.dispatch('mousedown', mouseEvent({ button: 1, clientX: 0, clientY: 0 }));
    expect(controls.isPanning()).toBe(true);
    win.dispatch('mousemove', mouseEvent({ clientX: 10, clientY: 5 }));
    expect(view.originPxX).toBe(110);
    expect(view.originPxY).toBe(105);
    win.dispatch('mouseup', mouseEvent({ button: 1 }));
    expect(controls.isPanning()).toBe(false);
  });

  it('plain left-button down (no space held) does not start a pan', () => {
    const controls = attachViewControls(canvas as unknown as HTMLCanvasElement, () => view, setView);
    const down = mouseEvent({ button: 0, clientX: 50, clientY: 50 });
    canvas.dispatch('mousedown', down);
    expect(controls.isPanning()).toBe(false);
    expect(down.preventDefault).not.toHaveBeenCalled();
  });

  it('suppresses the canvas context menu so right-drag pans cleanly', () => {
    attachViewControls(canvas as unknown as HTMLCanvasElement, () => view, setView);
    const ctx = mouseEvent({});
    canvas.dispatch('contextmenu', ctx);
    expect(ctx.preventDefault).toHaveBeenCalled();
  });

  it('detach unbinds the contextmenu handler', () => {
    const controls = attachViewControls(canvas as unknown as HTMLCanvasElement, () => view, setView);
    controls.detach();
    const ctx = mouseEvent({});
    canvas.dispatch('contextmenu', ctx);
    expect(ctx.preventDefault).not.toHaveBeenCalled();
  });
});
