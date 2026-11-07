// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Regression tests for the ■ (stop) button after a DOUBLE open. Field
 * report: with two panes open, pressing ■ on a pane sometimes does nothing
 * at all. The matrix below walks the paths a user can reach that state
 * through — plain double open, ＋-menu second pane, a live baud reconnect,
 * menus opened and closed — asserting each pane's ■ posts disconnect with
 * ITS OWN session id every time.
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;

const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

beforeAll(async () => {
  ({ fire, tick, posted } = await bootWebview());
});

afterEach(async () => {
  // Close every pane so the next test starts from the empty surface.
  for (let guard = 0; guard < 12; guard++) {
    const closer = document.querySelector('.pane:not(.empty) .pane-close') as HTMLElement | null;
    if (!closer) break;
    closer.click();
  }
  await tick();
  posted.length = 0;
});

const postTypes = () => posted.filter((m) => (m as { type: string }).type === 'disconnect');
const stopBtn = (idx: number) =>
  document.querySelectorAll<HTMLButtonElement>('.pane:not(.empty) .start-stop')[idx];

async function openPane(id: number, port: string) {
  fire({
    type: 'sessionCreated',
    sessionId: id,
    kind: 'port',
    title: port,
    state: 'connected',
    settings: { ...S },
  });
  await tick();
}

describe('stop button after a double open', () => {
  it('plain double open: each pane’s ■ posts disconnect for its own session', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
    await openPane(1, 'COM10');
    await openPane(2, 'COM12');

    posted.length = 0;
    (stopBtn(0) as HTMLButtonElement).click();
    (stopBtn(1) as HTMLButtonElement).click();
    expect(postTypes()).toEqual([
      expect.objectContaining({ type: 'disconnect', sessionId: 1 }),
      expect.objectContaining({ type: 'disconnect', sessionId: 2 }),
    ]);
  });

  it('second pane opened through the ＋ menu: both stops still wired', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
    await openPane(10, 'COM10');

    posted.length = 0;
    (document.querySelector('.add-monitor') as HTMLButtonElement).click();
    const item = document.querySelector('.add-menu .menu-item[data-path="COM12"]') as HTMLElement;
    item.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connect', port: 'COM12' }));
    await openPane(11, 'COM12');

    posted.length = 0;
    (stopBtn(0) as HTMLButtonElement).click();
    (stopBtn(1) as HTMLButtonElement).click();
    expect(postTypes()).toEqual([
      expect.objectContaining({ type: 'disconnect', sessionId: 10 }),
      expect.objectContaining({ type: 'disconnect', sessionId: 11 }),
    ]);
  });

  it('after a live baud reconnect: the pane keeps its wiring and ■ works', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
    await openPane(20, 'COM10');
    await openPane(21, 'COM12');

    // Change baud on pane 1 while connected → webview posts reconnect.
    const pane1 = document.querySelectorAll('.pane:not(.empty)')[0];
    const baud = pane1.querySelector('.ph-baud') as HTMLInputElement;
    baud.value = '9600';
    baud.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'reconnect', sessionId: 20 }),
    );

    posted.length = 0;
    (stopBtn(0) as HTMLButtonElement).click();
    (stopBtn(1) as HTMLButtonElement).click();
    expect(postTypes()).toEqual([
      expect.objectContaining({ type: 'disconnect', sessionId: 20 }),
      expect.objectContaining({ type: 'disconnect', sessionId: 21 }),
    ]);
  });

  it('menus opened and closed (＋, funnel): stops still wired', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
    await openPane(30, 'COM10');
    await openPane(31, 'COM12');

    (document.querySelector('.add-monitor') as HTMLButtonElement).click();
    (document.querySelector('.add-monitor') as HTMLButtonElement).click(); // toggle closed
    const funnel = document.querySelector('.filter-toggle') as HTMLButtonElement;
    funnel.click();
    funnel.click();

    posted.length = 0;
    (stopBtn(0) as HTMLButtonElement).click();
    (stopBtn(1) as HTMLButtonElement).click();
    expect(postTypes()).toEqual([
      expect.objectContaining({ type: 'disconnect', sessionId: 30 }),
      expect.objectContaining({ type: 'disconnect', sessionId: 31 }),
    ]);
  });
});
