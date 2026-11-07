#!/usr/bin/env node
// Automated performance probe for the REAL webview (served by
// scripts/webview-preview.mjs), measured in a HEADED Chrome window —
// headless Chrome's rAF queue does not advance without a compositor
// beginFrame, which wedges scheduleRender and blinds every measurement
// (recorded in PR #23). The window pops up for a few seconds per scene and
// closes itself; on Windows the process tree is killed with taskkill /T /F
// because chrome.kill() leaves children behind.
//
//   node scripts/perf-probe.mjs [outJson]
//
// Scenes: single pane streaming, dual tagged panes streaming, scroll over a
// filled buffer. Metrics: append→paint (double-rAF), rAF frame gaps, long
// tasks. Red thresholds: append→paint p95 > 100 ms or > 5 gaps > 100 ms/3 s.
import { spawn, execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const PREVIEW_PORT = 8231;
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const STREAM_MS = 3000;
const BURST = 20; // lines per 100 ms tick ≈ a fast feeder
const OUT = resolve(process.argv[2] ?? '.frames/perf-report.json');

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : res(msg.result);
      }
    });
  }
  static connect(url) {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      ws.once('open', () => res(new Cdp(ws)));
      ws.once('error', rej);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch { /* gone */ } }
}

const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (e) {
      if (Date.now() > end) throw new Error(`timeout ${what}: ${e.message}`);
      await sleep(200);
    }
  }
};

const BOOT = `
  window.H = (m) => __host(m);
  window.__gaps = [];
  window.__longtasks = [];
  window.__gapProbe = null;
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longtasks.push(Math.round(e.duration)); })
      .observe({ entryTypes: ['longtask'] });
  } catch (e) { /* longtask unsupported */ }
  window.startGapProbe = () => {
    let last = performance.now();
    const cb = (t) => {
      const d = t - last; last = t;
      if (d > 32) window.__gaps.push(Math.round(d));
      window.__gapProbe = requestAnimationFrame(cb);
    };
    window.__gapProbe = requestAnimationFrame(cb);
  };
  window.stopGapProbe = () => { cancelAnimationFrame(window.__gapProbe); window.__gapProbe = null; };
  window.measureAppendPaint = async (sessionId, n) => {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      H({ type: 'append', sessionId, dropCount: 0, lines: ['probe ' + i + ' sensor poll ok [ERROR] x' + (i % 3 === 0 ? 'y' : 'n')] });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      samples.push(Math.round((performance.now() - t0) * 10) / 10);
    }
    return samples;
  };
  window.streamFor = (sessionId, ms, burst) => {
    let k = 0;
    const t = setInterval(() => {
      const lines = [];
      for (let i = 0; i < burst; i++) lines.push('stream ' + (k++) + ' sensor poll ok [ERROR] x' + (k % 7 === 0 ? 'y' : 'n'));
      H({ type: 'append', sessionId, dropCount: 0, lines });
    }, 100);
    setTimeout(() => clearInterval(t), ms);
  };
  window.fillBuffer = (sessionId, total, perTick) => {
    let done = 0;
    return new Promise((resolve) => {
      const t = setInterval(() => {
        const n = Math.min(perTick, total - done);
        if (n <= 0) { clearInterval(t); resolve(done); return; }
        const lines = [];
        for (let k = 0; k < n; k++) lines.push('fill ' + (done + k) + ' sensor poll ok [ERROR] occasional');
        H({ type: 'append', sessionId, dropCount: 0, lines });
        done += n;
      }, 16);
    });
  };
  window.scrollProbe = async (steps) => {
    const log = document.querySelector('.pane-log');
    const samples = [];
    for (let i = 0; i < steps; i++) {
      const t0 = performance.now();
      log.scrollTop = Math.round((log.scrollHeight - log.clientHeight) * (i / steps));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      samples.push(Math.round((performance.now() - t0) * 10) / 10);
    }
    return samples;
  };
`;

const ERR_TAG =
  "({ id: 't1', name: 'ERROR', pattern: '[ERROR]', isRegex: false, color: '#f14c4c', highlight: true, filter: false })";
const S = "{ baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' }";

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((arr.length - 1) * p))] : 0);
const sumGaps = (g) => ({ over32ms: g.filter((x) => x > 32).length, over100ms: g.filter((x) => x > 100).length, max: g.length ? Math.max(...g) : 0 });

async function main() {
  const repo = process.cwd();
  rmSync(join(repo, '.frames', '.perf-profile'), { recursive: true, force: true });
  const preview = spawn(process.execPath, ['scripts/webview-preview.mjs', String(PREVIEW_PORT)], { cwd: repo, stdio: 'pipe' });
  // HEADED: the compositor drives rAF at full rate. The window shows for a
  // few seconds per scene — automated measurement, not a UI session.
  const chrome = spawn(CHROME, [
    '--remote-debugging-port=0',
    `--user-data-dir=${join(repo, '.frames', '.perf-profile')}`,
    '--no-first-run', '--window-size=1280,800', '--window-position=40,40',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromePid = chrome.pid;

  let cdp;
  try {
    await until(async () => {
      const r = await fetch(`http://127.0.0.1:${PREVIEW_PORT}/`);
      if (!r.ok) throw new Error('preview not ok');
    }, 20000, 'preview server');

    const { wsUrl } = await until(async () => {
      const buf = chrome.stderr.read();
      const text = buf ? buf.toString() : '';
      const m = text.match(/ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/[^\s]+/);
      if (!m) throw new Error('devtools not announced yet');
      return { wsUrl: m[0] };
    }, 20000, 'chrome devtools endpoint');

    cdp = await Cdp.connect(wsUrl);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('no page target');
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
      return r.result?.value;
    };

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 740, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PREVIEW_PORT}/` }, sessionId);
    await until(async () => {
      const r = await ev('typeof __host === "function" && document.readyState === "complete"');
      return r === true;
    }, 20000, 'page ready');
    await ev(BOOT);

    // Sanity: rows must exist after an append, or the rAF driver is blind.
    await ev(`H({ type: 'ports', ports: [{ path: 'COM10' }] }); H({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connected', settings: ${S} }); H({ type: 'append', sessionId: 1, dropCount: 0, lines: ['sanity row'] });`);
    await sleep(400);
    const sanityRows = await ev('document.querySelectorAll(".row-line").length');
    if (!sanityRows) throw new Error('rAF driver blind: zero rows rendered (headed Chrome should drive frames — check window visibility)');
    console.error(`[perf] sanity ok: ${sanityRows} rows rendered`);

    const results = {};

    // Scene 1: single pane streaming.
    await ev('window.__gaps = []; window.__longtasks = []; startGapProbe()');
    const appendSingle = await ev('measureAppendPaint(1, 25)');
    await ev(`streamFor(1, ${STREAM_MS}, ${BURST})`);
    await sleep(STREAM_MS + 300);
    await ev('stopGapProbe()');
    results['single-pane'] = {
      appendToPaint: { p50: pct(appendSingle, 0.5), p95: pct(appendSingle, 0.95), max: Math.max(...appendSingle) },
      gaps: sumGaps(await ev('window.__gaps')),
      longtasks: await ev('window.__longtasks'),
    };

    // Scene 2: dual tagged panes streaming.
    await ev(`H({ type: 'tags', sessionId: 1, tags: [${ERR_TAG}] });`);
    await ev(`H({ type: 'sessionCreated', sessionId: 2, kind: 'port', title: 'COM12', state: 'connected', settings: ${S} }); H({ type: 'tags', sessionId: 2, tags: [${ERR_TAG}] });`);
    await sleep(300);
    await ev('window.__gaps = []; window.__longtasks = []; startGapProbe()');
    const appendDual = await ev('measureAppendPaint(1, 25)');
    await ev(`streamFor(1, ${STREAM_MS}, ${BURST}); streamFor(2, ${STREAM_MS}, ${BURST});`);
    await sleep(STREAM_MS + 300);
    await ev('stopGapProbe()');
    results['dual-pane-tagged'] = {
      appendToPaint: { p50: pct(appendDual, 0.5), p95: pct(appendDual, 0.95), max: Math.max(...appendDual) },
      gaps: sumGaps(await ev('window.__gaps')),
      longtasks: await ev('window.__longtasks'),
    };

    // Scene 3: scroll a full 10k buffer.
    await ev('fillBuffer(1, 11500, 250)');
    await sleep(600);
    await ev('window.__longtasks = []');
    const scroll = await ev('scrollProbe(40)');
    results['scroll-full-buffer'] = {
      p50: pct(scroll, 0.5), p95: pct(scroll, 0.95), max: Math.max(...scroll),
      longtasks: await ev('window.__longtasks'),
    };

    const d = results['dual-pane-tagged'];
    results.verdict = {
      appendPaintP95_ms: d.appendToPaint.p95,
      longFrameGaps_3s: d.gaps.over100ms,
      red: d.appendToPaint.p95 > 100 || d.gaps.over100ms > 5,
    };
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
  } finally {
    cdp?.close();
    chrome.kill();
    // chrome.kill() leaves the child tree alive on Windows — finish the job.
    try {
      if (process.platform === 'win32' && chromePid) {
        execSync(`taskkill /pid ${chromePid} /T /F`, { stdio: 'ignore' });
      }
    } catch { /* already gone */ }
    preview.kill();
    try { rmSync(join(repo, '.frames', '.perf-profile'), { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
