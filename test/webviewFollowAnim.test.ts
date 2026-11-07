// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Smooth-follow animation: in follow mode the viewport EASES toward the
 * bottom (a per-frame exponential catch-up) instead of jumping on every
 * append. happy-dom has no layout, so this suite stubs the log element's
 * scroll geometry and records every scrollTop write. Semantics pinned:
 *   - a flood's catch-up happens across SEVERAL frames (monotonic, no jump)
 *     and CONVERGES at the bottom once the flood pauses
 *   - the animation's own writes never trip Follow→locked (programmatic
 *     suppression) — a mid-catch-up animation must not lock the pane
 *   - a USER scroll away from the bottom stops the catch-up and locks —
 *     the classic interrupt stays instant, and a flood while locked must
 *     not drag the viewport
 *   - toggling locked→follow restarts the catch-up
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;

const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };
const ROW_H = 20;
const CLIENT_H = 300;
const LAYOUT = { rows: 0 };
let scrollTopVal = 0;
/** Every scrollTop write the page made, in order. */
let writes: number[] = [];

beforeAll(async () => {
  const h = await bootWebview();
  fire = h.fire;
  tick = h.tick;
  posted = h.posted;
});

afterEach(async () => {
  for (let guard = 0; guard < 12; guard++) {
    const closer = document.querySelector('.pane:not(.empty) .pane-close') as HTMLElement | null;
    if (!closer) break;
    closer.click();
  }
  await tick();
  posted.length = 0;
  LAYOUT.rows = 0;
  scrollTopVal = 0;
  writes = [];
});

const log = () => document.querySelector('.pane-log') as HTMLElement;

/** happy-dom has no layout: pin the scroll geometry to the row count and
 * record every scrollTop write (each write fires the scroll event, like a
 * real browser). */
const stubLayout = () => {
  const el = log();
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => LAYOUT.rows * ROW_H,
  });
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => CLIENT_H,
  });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => scrollTopVal,
    set: (v: number) => {
      const max = Math.max(0, LAYOUT.rows * ROW_H - CLIENT_H);
      scrollTopVal = Math.max(0, Math.min(v, max));
      writes.push(scrollTopVal);
      el.dispatchEvent(new Event('scroll'));
    },
  });
};

const openPane = async (id: number) => {
  fire({ type: 'ports', ports: [{ path: 'COM10' }] });
  fire({ type: 'sessionCreated', sessionId: id, kind: 'port', title: 'COM10', state: 'connected', settings: { ...S } });
  await tick();
  stubLayout();
};

const appendLines = async (id: number, n: number, tag: string) => {
  fire({ type: 'append', sessionId: id, dropCount: 0, lines: Array.from({ length: n }, (_, i) => `${tag}-${i}`) });
  LAYOUT.rows += n;
  await tick();
};

const atBottom = () => log().scrollHeight - scrollTopVal - CLIENT_H < 2;

async function settle(maxFrames = 80) {
  for (let i = 0; i < maxFrames; i++) {
    await tick();
    if (atBottom()) return true;
  }
  return atBottom();
}

describe('smooth follow', () => {
  it('a single flood eases toward the bottom across SEVERAL frames (no jump)', async () => {
    await openPane(1);
    writes.length = 0;
    // One 120-line burst: the target jumps ~2100px. A jump-write lands in
    // one step at the bottom; the catch-up's FIRST write stays well short
    // of it (how many frames a tick advances varies by runner — Node timer
    // clustering — so the count itself is not assertable).
    await appendLines(1, 120, 'l');
    const target = LAYOUT.rows * ROW_H - CLIENT_H;
    expect(target).toBeGreaterThan(0);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toBeLessThan(target);
    expect(await settle()).toBe(true);
    // Monotonic descent, never overshooting the bottom.
    expect(writes.every((v, i) => i === 0 || v >= writes[i - 1])).toBe(true);
  });

  it('repeated floods keep up and stay at the bottom', async () => {
    await openPane(1);
    for (let round = 0; round < 4; round++) {
      await appendLines(1, 60, `l${round}`);
    }
    expect(await settle()).toBe(true);
    expect(document.querySelectorAll('.row-line').length).toBeGreaterThan(0);
  });

  it('the animation’s own writes never trip Follow→locked', async () => {
    await openPane(2);
    for (let round = 0; round < 3; round++) {
      await appendLines(2, 60, `m${round}`);
    }
    await settle();
    // The scroll-lock button still reads "follow" — mid-catch-up scroll
    // events (programmatic writes) must not flip the reducer to locked.
    const lockBtn = document.querySelector('button[title^="Viewport follows"]') as HTMLButtonElement | null;
    expect(lockBtn).toBeTruthy();
  });

  it('a USER scroll away from the bottom locks instantly and a flood cannot drag the viewport', async () => {
    await openPane(3);
    for (let round = 0; round < 4; round++) {
      await appendLines(3, 60, `u${round}`);
    }
    // The user grabs the scrollbar mid-catch-up (a write the page did not
    // make is indistinguishable here — so bypass the setter and dispatch).
    scrollTopVal = 0;
    log().dispatchEvent(new Event('scroll'));
    await tick();
    const lockBtn = document.querySelector('button[title^="Scroll locked"]') as HTMLButtonElement | null;
    expect(lockBtn).toBeTruthy();
    const frozen = scrollTopVal;
    writes.length = 0;
    await appendLines(3, 30, 'f');
    expect(scrollTopVal).toBe(frozen);
    expect(writes).toEqual([]);
  });

  it('toggling locked→follow restarts the catch-up to the bottom', async () => {
    await openPane(4);
    for (let round = 0; round < 3; round++) {
      await appendLines(4, 60, `t${round}`);
    }
    const followBtn = document.querySelector('button[title^="Viewport follows"]') as HTMLButtonElement;
    followBtn.click(); // → locked
    await tick();
    const lockedBtn = document.querySelector('button[title^="Scroll locked"]') as HTMLButtonElement;
    writes.length = 0;
    lockedBtn.click(); // → follow again
    expect(await settle()).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
  });
});
