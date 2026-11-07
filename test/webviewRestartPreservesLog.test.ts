// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Restarting a port (■ then ▶) must KEEP the pane's log AND, in follow
 * mode, land the viewport at the bottom — the restored history is a
 * backfill, not a flood to chase. Each split pane is independent: restarting
 * one pane must not move another's viewport. happy-dom has no layout, so
 * the suite stubs per-pane scroll geometry (rows counted per pane).
 * Related semantics that must keep holding: a live baud reconnect keeps the
 * buffer, and a scroll-locked pane still restarts at the bottom: x{25b6} means
 * rejoin the live tail.
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;

const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };
const ROW_H = 20;
const CLIENT_H = 300;

beforeAll(async () => {
  ({ fire, tick, posted } = await bootWebview());
});

afterEach(async () => {
  for (let guard = 0; guard < 12; guard++) {
    const closer = document.querySelector('.pane:not(.empty) .pane-close') as HTMLElement | null;
    if (!closer) break;
    closer.click();
  }
  await tick();
  posted.length = 0;
});

// -- per-pane scroll geometry (happy-dom has none) ------------------------------
const rowsByPane = new Map<HTMLElement, number>();
const scrollPos = new WeakMap<HTMLElement, number>();

const stubLayout = () => {
  for (const el of Array.from(document.querySelectorAll('.pane-log')) as HTMLElement[]) {
    if (rowsByPane.has(el)) continue; // already stubbed
    rowsByPane.set(el, 0);
    Object.defineProperty(el, 'scrollHeight', {
      configurable: true,
      get: () => (rowsByPane.get(el) ?? 0) * ROW_H,
    });
    Object.defineProperty(el, 'clientHeight', {
      configurable: true,
      get: () => CLIENT_H,
    });
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => scrollPos.get(el) ?? 0,
      set: (v: number) => {
        const max = Math.max(0, (rowsByPane.get(el) ?? 0) * ROW_H - CLIENT_H);
        scrollPos.set(el, Math.max(0, Math.min(v, max)));
        el.dispatchEvent(new Event('scroll'));
      },
    });
  }
};

const logOf = (title: string) => {
  const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
    (p) => (p.querySelector('.ph-port') as HTMLSelectElement | null)?.value === title,
  ) as HTMLElement | undefined;
  return pane?.querySelector('.pane-log') as HTMLElement;
};

const atBottom = (el: HTMLElement) =>
  el.scrollHeight - el.scrollTop - el.clientHeight < 2;

async function openPane(id: number, port: string) {
  fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
  fire({ type: 'sessionCreated', sessionId: id, kind: 'port', title: port, state: 'connected', settings: { ...S } });
  await tick();
  stubLayout();
}

const appendLines = async (id: number, port: string, n: number, tag: string) => {
  fire({ type: 'append', sessionId: id, dropCount: 0, lines: Array.from({ length: n }, (_, i) => `${tag}-${i}`) });
  const el = logOf(port);
  rowsByPane.set(el, (rowsByPane.get(el) ?? 0) + n);
  await tick();
};

const rows = () => document.querySelectorAll('.pane:not(.empty) .row-line').length;
const paneCount = () => document.querySelectorAll('.pane:not(.empty)').length;
const lastPost = (type: string) =>
  [...posted].reverse().find((m) => (m as { type: string }).type === type) as
    | Record<string, unknown>
    | undefined;

describe('restart keeps the log and lands at the bottom', () => {
  it('■ then ▶ preserves the buffered lines AND the tag bar', async () => {
    await openPane(1, 'COM10');
    await appendLines(1, 'COM10', 30, 'l');
    expect(rows()).toBeGreaterThan(0);

    // The pane carries a tag BEFORE the restart; the swap must bring the
    // chip bar back with the pane.
    fire({ type: 'tags', sessionId: 1, tags: [{ id: 't9', name: 'ERR', pattern: 'ERR', isRegex: false, color: '#ff0000', highlight: true, filter: true }] });
    await tick();
    expect(document.querySelectorAll('.pane:not(.empty) .pane-tags .chip').length).toBe(1);

    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    expect(lastPost('disconnect')).toEqual({ type: 'disconnect', sessionId: 1 });
    fire({ type: 'state', sessionId: 1, state: 'idle' });
    await tick();
    expect(rows()).toBeGreaterThan(0); // the log survives the stop
    expect(document.querySelectorAll('.pane:not(.empty) .pane-tags .chip').length).toBe(1);

    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    expect(lastPost('connect')?.port).toBe('COM10');
    const oldRows = rows();
    fire({ type: 'sessionCreated', sessionId: 2, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 2, state: 'connected' });
    stubLayout(); // the replacement pane's log element is new
    await tick();

    expect(paneCount()).toBe(1);
    expect(rows()).toBe(oldRows); // the log survives the swap
    expect(document.querySelector('.pane:not(.empty) .row-line')?.textContent).toContain('l-0');
    // The chip bar renders with the inherited tag right after the swap.
    const chip = document.querySelector('.pane:not(.empty) .pane-tags .chip') as HTMLElement | null;
    expect(chip?.textContent).toContain('ERR');
    const row = document.querySelector('.pane:not(.empty) .pane-tags') as HTMLElement;
    expect(row.style.display).toBe('flex');
  });

  it('a follow-mode pane lands AT THE BOTTOM after the restart', async () => {
    await openPane(20, 'COM10');
    await appendLines(20, 'COM10', 40, 'f');

    const rowsBefore = rowsByPane.get(logOf('COM10'))!;
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'state', sessionId: 20, state: 'idle' });
    await tick();
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'sessionCreated', sessionId: 21, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 21, state: 'connected' });
    stubLayout(); // the replacement pane's log element is new
    rowsByPane.set(logOf('COM10'), rowsBefore); // the inherited buffer size
    await tick();
    await tick();

    // The restored history is a backfill: a follow pane resumes pinned to
    // the newest line, in ONE step (not a catch-up sweep across it).
    const el = logOf('COM10');
    if (!atBottom(el)) {
      throw new Error('STATE ' + JSON.stringify({
        sh: el.scrollHeight, st: el.scrollTop, ch: el.clientHeight, stub: rowsByPane.has(el),
      }));
    }
  },);

  it('a pane that was scroll-locked before the stop restarts AT THE BOTTOM', async () => {
    // ▶ is "start again": the user is asking for the LIVE tail, so a scroll
    // lock acquired while browsing the stopped buffer does not survive it.
    await openPane(30, 'COM10');
    await appendLines(30, 'COM10', 40, 'k');
    // User scrolls up mid-buffer (Follow→locked via the reducer) — AFTER
    // the catch-up has settled, like a real user browsing a stopped pane
    // (a write during the animation window would be swallowed by the
    // programmatic flag).
    const el = logOf('COM10');
    let settled = false;
    for (let i = 0; i < 40 && !settled; i++) {
      await tick();
      settled = atBottom(el);
    }
    el.scrollTop = (rowsByPane.get(el)! - 30) * ROW_H; // 30 rows above the end — NOT the bottom
    await tick();
    const rowsBefore = rowsByPane.get(el)!;
    expect(el.scrollTop).toBeGreaterThan(0); // the manual scroll took hold
    expect(atBottom(el)).toBe(false); // genuinely away from the bottom

    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'state', sessionId: 30, state: 'idle' });
    await tick();
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'sessionCreated', sessionId: 31, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 31, state: 'connected' });
    stubLayout(); // the replacement pane's log element is new
    rowsByPane.set(logOf('COM10'), rowsBefore); // the inherited buffer size
    await tick();
    await tick();

    // Restart = rejoin the live tail, regardless of the pre-stop scroll.
    expect(atBottom(logOf('COM10'))).toBe(true);
  });

  it('the restarted pane renders its restored log SYNCHRONOUSLY (no blank flash)', async () => {
    await openPane(40, 'COM10');
    await appendLines(40, 'COM10', 30, 's');
    const oldRows = rows();

    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'state', sessionId: 40, state: 'idle' });
    await tick();
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    fire({ type: 'sessionCreated', sessionId: 41, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 41, state: 'connected' });
    stubLayout();
    // NO tick: the reveal happens synchronously with state handling, so the
    // restored log must ALREADY be painted (pre-rendered overscan rows with
    // correct spacers) — a blank frame here is the flicker the user saw.
    // The full window refines on the next rAF.
    expect(rows()).toBeGreaterThan(0);
    expect(document.querySelector('.pane:not(.empty) .row-line')?.textContent).toContain('s-0');
  });

  it('split panes are independent: restarting one leaves the other alone', async () => {
    await openPane(40, 'COM10');
    await openPane(41, 'COM12');
    await appendLines(40, 'COM10', 40, 'a');
    await appendLines(41, 'COM12', 40, 'b');
    const b = logOf('COM12');

    // Restart ONLY pane A (COM10). Pane B is settled at its own bottom.
    let bBottom = false;
    for (let i = 0; i < 40 && !bBottom; i++) {
      await tick();
      bBottom = atBottom(b);
    }
    expect(bBottom).toBe(true); // B's own catch-up converges
    (document.querySelectorAll('.pane:not(.empty) .start-stop')[0] as HTMLButtonElement).click();
    fire({ type: 'state', sessionId: 40, state: 'idle' });
    await tick();
    (document.querySelectorAll('.pane:not(.empty) .start-stop')[0] as HTMLButtonElement).click();
    fire({ type: 'sessionCreated', sessionId: 42, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 42, state: 'connected' });
    stubLayout();
    await tick();
    await tick();

    expect(paneCount()).toBe(2);
    // Independence: after A's restart, B is still pinned to ITS OWN bottom
    // with ITS OWN buffer. (B's last catch-up frame may land during A's
    // restart — that is B's motion, so the assertion is state-based, not
    // pixel-equality.)
    expect(atBottom(logOf('COM10'))).toBe(true); // A: pinned after restart
    expect(atBottom(b)).toBe(true); // B: still its own bottom
    expect(rowsByPane.get(b)).toBe(40); // B's buffer intact
  });
});
