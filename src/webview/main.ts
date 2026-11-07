declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

import { LineDecision, matchLine, isTagPatternValid } from '../shared/tagMatching';
import { FilterMode, Tag } from '../shared/tag';
import { makeTag, patchedTag, sanitizeTags, withoutTag } from '../shared/tagList';
import { icon, IconName } from './icons';
import { scrollReducer, ScrollState } from '../shared/scrollState';
import { BAUD_RATE_PRESETS, DEFAULT_BAUD_RATE } from '../shared/baudPresets';
import { formatLineText } from '../shared/lineText';
import { HostToWebview, SerialParams, WebviewToHost } from '../shared/protocol';
import { buildFindRegex, FindOccurrence, scanOccurrences, stepIndex } from './findCore';
import { computeRenderWindow } from './windowMath';
import { rowHeightFor } from './rowHeight';
import { handleHostMessage, HostRouterContext } from './hostRouter';
import {
  DEFAULT_PORT_SETTINGS,
  PaneActionButtons,
  PaneDom,
  PaneSession,
  PortSettings,
  RenderedRow,
} from './paneTypes';

const vscode = acquireVsCodeApi();
const post = (msg: WebviewToHost) => vscode.postMessage(msg);

/** Icon-only controls carry their tooltip as a real accessible name too —
 * title alone is a weak name for assistive tech. */
function setTip(el: HTMLElement, text: string): void {
  el.title = text;
  el.setAttribute('aria-label', text);
}

const panesArea = document.getElementById('panes') as HTMLDivElement;

/**
 * Layout: there is no global toolbar. Every pane carries its own serial
 * config and actions in its bar, plus its OWN copy of the global controls
 * (add monitor, refresh, filter, timestamps, log dir, open file, tag,
 * manage) and a per-pane status readout; the empty-state row carries one
 * too. Nothing re-parents on focus — focus only steers Ctrl+F, the API
 * clear, and transient status messages. ＋ opens a port quick-pick.
 */

/** Per-pane DOM. Config controls exist only on port panes. */
const sessions: PaneSession[] = [];
let focusedId: number | undefined;
// A pane's ▶ restarts itself: the old pane closes only after the new session
// actually connects. Two-phase tracking keeps a failed open from stranding
// the request (an unrelated session must never close the old pane).
let pendingReplaceOldId: number | undefined;
let pendingReplaceNewId: number | undefined;

let showTimestamps = false;
let recentBauds: number[] = [];
/** The most recently used port — the start bar re-selects it after the
 * last pane closes, so closing a monitor keeps your context. */
let lastUsedPort = '';
let lastPorts: { path: string; description?: string }[] = [];

function focusedSession(): PaneSession | undefined {
  return sessions.find((s) => s.id === focusedId);
}

// Every pane (and the empty row) carries its OWN copy of the global
// controls; the registries let state changes restyle all copies at once.
const controlRegistry = {
  tagButtons: new Set<HTMLButtonElement>(),
  filterToggles: new Set<HTMLButtonElement>(),
  timestampsButtons: new Set<HTMLButtonElement>(),
  logDirButtons: new Set<HTMLButtonElement>(),
};
let emptyStatus: HTMLSpanElement | undefined;
let emptyAddMenu: HTMLDivElement | undefined;
let emptyRefreshStartSelect: (() => void) | undefined;
let startPortSelect!: HTMLSelectElement;

function unregisterControls(ctlRefs?: PaneDom['ctlRefs']): void {
  if (!ctlRefs) {
    return;
  }
  controlRegistry.tagButtons.delete(ctlRefs.tagBtn);
  controlRegistry.filterToggles.delete(ctlRefs.filterToggleBtn);
  controlRegistry.timestampsButtons.delete(ctlRefs.timestampsBtn);
  controlRegistry.logDirButtons.delete(ctlRefs.logDirBtn);
}

/** Builds one copy of the global controls: ＋ port menu, refresh, filter,
 * timestamps, log dir, open file, tag, manage, and a status readout. */
function buildGlobalControls(owner: PaneSession | undefined): {
  seg: HTMLDivElement;
  status: HTMLSpanElement;
  /** ＋ lives inside this wrap together with its port quick-pick menu. */
  addWrap: HTMLSpanElement;
  addMonitorBtn: HTMLButtonElement;
  refreshBtn: HTMLButtonElement;
  filterToggleBtn: HTMLButtonElement;
  timestampsBtn: HTMLButtonElement;
  logDirBtn: HTMLButtonElement;
  tagBtn: HTMLButtonElement;
} {
  const seg = document.createElement('div');
  seg.className = 'global-seg';
  const mkBtn = (cls: string, glyph: string, title: string) => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = glyph;
    setTip(b, title);
    seg.appendChild(b);
    return b;
  };

  // ＋ with its own port quick-pick, plus the refresh — both ride LEFT of
  // the wide start/stop button, outside the global segment (the ＋ is for
  // opening a SECOND monitor; the empty row disables it, ADR-0005 amended).
  const addWrap = document.createElement('span');
  addWrap.className = 'menu-wrap';
  const addMonitorBtn = document.createElement('button');
  addMonitorBtn.className = 'icon-btn add-monitor';
  addMonitorBtn.innerHTML = icon('plus');
  setTip(addMonitorBtn, 'Add a monitor — pick a port');
  addMonitorBtn.disabled = !owner || owner.isEmpty === true; // ＋ only opens a SECOND monitor
  const addMenu = document.createElement('div');
  addMenu.className = 'menu add-menu';
  addWrap.append(addMonitorBtn, addMenu);
  addMonitorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!owner) {
      return; // first monitor comes from the start bar, not ＋
    }
    toggleAddMenu(addMenu);
  });

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'icon-btn refresh-btn';
  refreshBtn.innerHTML = icon('refresh');
  setTip(refreshBtn, 'Refresh port list');
  refreshBtn.addEventListener('click', () => {
    post({ type: 'refreshPorts' });
  });

  // Filter mode menu (funnel glyph).
  const filterWrap = document.createElement('span');
  filterWrap.className = 'menu-wrap';
  const filterToggleBtn = document.createElement('button');
  filterToggleBtn.className = 'icon-btn filter-toggle';
  setTip(filterToggleBtn, 'Filter');
  filterToggleBtn.innerHTML = icon('funnel');
  const filterMenu = document.createElement('div');
  filterMenu.className = 'menu filter-menu';
  filterWrap.append(filterToggleBtn, filterMenu);
  seg.appendChild(filterWrap);
  filterToggleBtn.disabled = !owner || owner.isEmpty === true; // nothing to filter yet
  filterToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!owner || owner.isEmpty === true) {
      return; // no pane, nothing to filter — never open a dead menu
    }
    if (filterMenu.style.display === 'block') {
      filterMenu.style.display = 'none';
      return;
    }
    renderFilterMenu(filterMenu, owner);
    filterMenu.style.display = 'block';
  });

  const timestampsBtn = mkBtn('icon-btn timestamps', icon('clock'), 'Timestamps: off');
  timestampsBtn.addEventListener('click', () => {
    post({ type: 'setTimestamps', enabled: !showTimestamps });
  });

  const logDirBtn = mkBtn('icon-btn log-dir', icon('folder'), 'Choose a log directory: every logged session writes a new .log file (right-click to clear)');
  logDirBtn.addEventListener('click', () => {
    post({ type: 'chooseLogDirectory' });
  });
  logDirBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    post({ type: 'clearLogDirectory' });
  });

  const openLogFileBtn = mkBtn('icon-btn open-log-file', icon('folder-open'), 'Open a log file in a read-only pane');
  openLogFileBtn.addEventListener('click', () => {
    post({ type: 'openLogFile' });
  });

  const tagBtn = mkBtn('icon-btn create-tag', icon('tag'), 'Create a tag from the selected text');
  tagBtn.disabled = true;
  tagBtn.addEventListener('click', () => {
    const selected = window.getSelection()?.toString().trim() ?? '';
    const f = focusedSession();
    if (!selected || !f) {
      return;
    }
    applyTagEdit(f, [...f.tags, makeTag(f.tags, selected)]);
  });
  // Keep the selection alive: clicking the button must not collapse it.
  tagBtn.addEventListener('mousedown', (e) => e.preventDefault());

  const manageToggleBtn = mkBtn('icon-btn manage-toggle', icon('gear'), 'Manage tags');
  manageToggleBtn.disabled = !owner || owner.isEmpty === true; // tags live on panes (ADR-0006)
  manageToggleBtn.addEventListener('click', () => {
    manageOpen = !manageOpen;
    renderManagePanel();
  });

  const status = document.createElement('span');
  status.className = 'pane-status';
  status.setAttribute('role', 'status'); // connection changes announce politely
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Idle';
  seg.appendChild(status);

  controlRegistry.tagButtons.add(tagBtn);
  controlRegistry.filterToggles.add(filterToggleBtn);
  controlRegistry.timestampsButtons.add(timestampsBtn);
  controlRegistry.logDirButtons.add(logDirBtn);

  return { seg, status, addWrap, addMonitorBtn, refreshBtn, filterToggleBtn, timestampsBtn, logDirBtn, tagBtn };
}

function toggleAddMenu(menu: HTMLDivElement): void {
  if (menu.style.display === 'block') {
    menu.style.display = 'none';
    return;
  }
  renderAddMenu(menu);
  menu.style.display = 'block';
  // Refresh the cached list in the background; reopening shows it.
  post({ type: 'refreshPorts' });
}

/** Baud quick-pick content: recently used rates first, then every preset. */
function renderBaudMenuInto(menu: HTMLDivElement, input: HTMLInputElement): void {
  menu.textContent = '';
  const push = (b: number, recent: boolean) => {
    // buttons, not divs: keyboard focus + Enter activation for free
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item' + (recent ? ' recent' : '');
    item.textContent = (String(b) === input.value.trim() ? '✔︎ ' : '') + String(b);
    item.title = recent ? 'Recently used' : '';
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      input.value = String(b);
      input.dispatchEvent(new Event('change'));
      menu.classList.remove('visible');
    });
    menu.appendChild(item);
  };
  const header = (label: string) => {
    const h = document.createElement('div');
    h.className = 'menu-header';
    h.textContent = label;
    menu.appendChild(h);
  };
  let shown = 0;
  if (recentBauds.length) {
    header('Recent');
    for (const b of recentBauds) {
      push(b, true);
      shown++;
    }
    header('Presets');
  }
  for (const b of BAUD_RATE_PRESETS) {
    if (recentBauds.includes(b)) {
      continue;
    }
    push(b, false);
    shown++;
  }
  if (shown === 0) {
    header('No presets');
  }
}

const mkSelect = (options: string[], value: string, cls: string, ctlTitle: string) => {
  const sel = document.createElement('select');
  sel.className = `ph-ctl ${cls}`;
  sel.title = ctlTitle;
  for (const o of options) {
    const e = document.createElement('option');
    e.value = o;
    e.textContent = o;
    sel.appendChild(e);
  }
  sel.value = value;
  return sel;
};

/** A bar subdivision that wraps as a whole block: on narrow panels the
 * bar breaks BETWEEN groups, never inside one, and groups never shrink. */
function newBarGroup(): HTMLSpanElement {
  const g = document.createElement('span');
  g.className = 'bar-group';
  return g;
}

/** Fresh pane-action buttons for ONE bar (send toggle, clear, log, export,
 * follow, find, close). Handlers are attached by the caller; per-pane
 * titles are set by refreshPaneControls — the empty row mounts its set
 * disabled, so the two states share the full bar shape (ADR-0006). */
function buildPaneActionButtons(): PaneActionButtons {
  const mk = (cls: string, glyph: string, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pbtn ${cls}`;
    b.innerHTML = glyph;
    setTip(b, title);
    return b;
  };
  const sendToggle = mk('send-toggle', icon('keyboard'), 'Show the send bar');
  const clearBtn = mk('clear-btn', icon('trash'), 'Clear');
  const logBtn = mk('log-btn', icon('circle'), 'Log to file: off');
  const exportBtn = mk('export-btn', icon('export'), 'Export');
  const scrollBtn = mk('scroll-btn', icon('arrow-down'), 'Viewport follows new lines — click to lock');
  const findBtn = mk('find-btn', icon('search'), 'Find in this pane (Ctrl+F)');
  const close = mk('pane-close', icon('close'), 'Close this pane');
  return { sendToggle, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close };
}

interface SerialConfigControls {
  baudWrap: HTMLSpanElement;
  baudInput: HTMLInputElement;
  paramsToggle: HTMLButtonElement;
  params: HTMLSpanElement;
  dbSel: HTMLSelectElement;
  paritySel: HTMLSelectElement;
  sbSel: HTMLSelectElement;
  leSel: HTMLSelectElement;
}

/** The serial config block shared by every pane bar AND the empty-state
 * start bar: a baud quick-pick (▾ menu with recents + presets) plus the
 * rarely-used params (data bits, parity, stop bits, line ending) collapsed
 * behind a ☰ toggle. Toggle behavior is self-contained; callers wire their
 * own change semantics. One builder, so the two surfaces cannot drift. */
function buildSerialConfigControls(
  cfg: { baudRate: number; dataBits: number; stopBits: number; parity: string },
  lineEnding: string,
): SerialConfigControls {
  const baudWrap = document.createElement('span');
  baudWrap.className = 'menu-wrap';
  const baudInput = document.createElement('input');
  baudInput.className = 'ph-ctl ph-baud';
  baudInput.value = String(cfg.baudRate);
  setTip(baudInput, 'Baud rate');
  baudInput.inputMode = 'numeric';
  baudInput.setAttribute('autocomplete', 'off');
  const baudToggle = document.createElement('button');
  baudToggle.className = 'pbtn baud-toggle';
  baudToggle.innerHTML = icon('chevron-down');
  setTip(baudToggle, 'Quick-pick baud rate');
  const baudMenu = document.createElement('div');
  baudMenu.className = 'menu baud-menu';
  baudWrap.append(baudInput, baudToggle, baudMenu);
  baudToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (baudMenu.classList.contains('visible')) {
      baudMenu.classList.remove('visible');
      return;
    }
    renderBaudMenuInto(baudMenu, baudInput);
    baudMenu.classList.add('visible');
  });

  const paramsToggle = document.createElement('button');
  paramsToggle.className = 'pbtn params-toggle';
  paramsToggle.innerHTML = icon('lines');
  setTip(paramsToggle, 'Serial params (data bits, parity, stop bits, line ending)');
  const params = document.createElement('span');
  params.className = 'pane-params';
  params.style.display = 'none';
  const dbSel = mkSelect(['8', '7', '6', '5'], String(cfg.dataBits), 'ph-db', 'Data bits');
  const paritySel = mkSelect(['none', 'even', 'odd', 'mark', 'space'], cfg.parity, 'ph-parity', 'Parity');
  const sbSel = mkSelect(['1', '1.5', '2'], String(cfg.stopBits), 'ph-sb', 'Stop bits');
  const leSel = mkSelect(['LF', 'CRLF', 'CR', 'None'], lineEnding, 'ph-le', 'Line ending');
  params.append(dbSel, paritySel, sbSel, leSel);
  paramsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    params.style.display = params.style.display === 'none' ? 'flex' : 'none';
    paramsToggle.classList.toggle('on', params.style.display === 'flex');
  });

  return { baudWrap, baudInput, paramsToggle, params, dbSel, paritySel, sbSel, leSel };
}

function renderAddMenu(menu: HTMLDivElement): void {
  menu.textContent = '';
  const header = document.createElement('div');
  header.className = 'menu-header';
  header.textContent = 'Add monitor — pick a port';
  menu.appendChild(header);
  if (!lastPorts.length) {
    const hint = document.createElement('div');
    hint.className = 'menu-item hint';
    hint.textContent = 'No ports detected — press 🔄 to refresh';
    menu.appendChild(hint);
    return;
  }
  for (const p of lastPorts) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'menu-item';
    item.dataset.path = p.path;
    item.textContent = p.description ? `${p.path} — ${p.description}` : p.path;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = 'none';
      startFromMenu(p.path);
    });
    menu.appendChild(item);
  }
}

// Virtualized rendering: fixed-height rows, spacer divs hold the scrolled
// distance so only the visible window (plus overscan) exists in the DOM.
const OVERSCAN_ROWS = 20;
let rowHeightPx = 20;
const pendingRenders = new Set<PaneSession>();
let renderScheduled = false;

// CSS Custom Highlight API (Chromium ≥105, guaranteed in VS Code's webview);
// guarded lookups keep TypeScript's DOM lib happy.
type HighlightLike = { new (...ranges: Range[]): unknown };
const highlightCtor = (window as unknown as { Highlight?: HighlightLike }).Highlight;
const highlightRegistry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;

function measureRowHeight(logEl: HTMLElement): void {
  // Derive the row height from the editor font size and publish it to CSS —
  // see rowHeight.ts for why the two must be one integer value.
  const fontSize = parseFloat(window.getComputedStyle(logEl).fontSize) || 13;
  const h = rowHeightFor(fontSize);
  document.documentElement.style.setProperty('--sm-row-h', `${h}px`);
  const probe = document.createElement('div');
  probe.className = 'row-line';
  probe.style.visibility = 'hidden';
  probe.textContent = 'X';
  logEl.appendChild(probe);
  rowHeightPx = probe.offsetHeight || h;
  probe.remove();
}

function renderText(entry: { text: string; ts?: number }): string {
  return formatLineText(entry, showTimestamps);
}

function renderWindowFor(s: PaneSession): void {
  pendingRenders.delete(s);
  const logEl = s.dom.log;
  const total = s.visibleIndexes.length;
  const { first, last } = computeRenderWindow(logEl.scrollTop, logEl.clientHeight, rowHeightPx, total, OVERSCAN_ROWS);

  const rows: RenderedRow[] = [];
  for (let p = first; p < last; p++) {
    const lineIndex = s.visibleIndexes[p];
    const colors = s.decisions[lineIndex].highlightColors;
    rows.push({
      lineIndex,
      text: renderText(s.lineStore[lineIndex]),
      bg: colors.length ? `${colors[0]}45` : '',
      bgImage: colorBar(colors),
      textIndent: colors.length > 1 ? '10px' : '',
    });
  }
  const topPx = first * rowHeightPx;
  const bottomPx = (total - last) * rowHeightPx;

  // Skip the DOM swap entirely when the rendered window is unchanged — a
  // streaming append below the viewport must not destroy a text selection.
  const prev = s.lastRender;
  if (
    prev &&
    prev.topPx === topPx &&
    prev.bottomPx === bottomPx &&
    prev.rows.length === rows.length &&
    prev.rows.every(
      (r, i) =>
        r.lineIndex === rows[i].lineIndex &&
        r.text === rows[i].text &&
        r.bg === rows[i].bg &&
        r.bgImage === rows[i].bgImage &&
        r.textIndent === rows[i].textIndent,
    )
  ) {
    renderMarksFor(s);
    renderFindMarksFor(s);
    refreshFindHighlights();
    return;
  }

  const savedSelection = captureSelection();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'row-line';
    row.dataset.lineIndex = String(r.lineIndex);
    row.textContent = r.text;
    row.style.background = r.bg;
    row.style.backgroundImage = r.bgImage;
    row.style.textIndent = r.textIndent;
    frag.appendChild(row);
  }
  s.dom.spacerTop.style.height = `${topPx}px`;
  s.dom.spacerBottom.style.height = `${bottomPx}px`;
  s.dom.log.replaceChildren(s.dom.spacerTop, frag, s.dom.spacerBottom);
  restoreSelection(savedSelection);
  s.lastRender = { topPx, bottomPx, rows };
  renderMarksFor(s);
  renderFindMarksFor(s);
  refreshFindHighlights();
}

/** Multi-match color bar: one 5px segment per matching tag, so overlapping
 * tags stay visible instead of masking each other. */
function colorBar(colors: string[]): string {
  if (colors.length < 2) {
    return '';
  }
  const stops = colors.map((c, i) => `${c} ${i * 5}px ${(i + 1) * 5}px`).join(', ');
  return `linear-gradient(to right, ${stops}, transparent ${colors.length * 5}px)`;
}

/** Overview strip beside a pane's scrollbar: one block per tag-highlighted
 * line, squashed to the viewport like the editor's overview ruler. */
/** The overview strip repaints at most at this rate while a stream floods
 * in — its pass is O(all visible rows), and a ruler 200 ms stale is
 * invisible. User actions (tag/filter edits) repaint immediately. */
const MARKS_MIN_INTERVAL = 200;

function renderMarksFor(s: PaneSession, force = false): void {
  if (!s.marksDirty) {
    return;
  }
  const now = performance.now();
  if (!force && s.marksPaintedAt !== undefined && now - s.marksPaintedAt < MARKS_MIN_INTERVAL) {
    return; // keep the dirty flag: the next interval window repaints
  }
  s.marksDirty = false;
  s.marksPaintedAt = now;
  const total = s.visibleIndexes.length;
  const height = Math.max(1, s.dom.log.clientHeight - 8);
  const buckets = new Map<number, string>();
  for (let p = 0; p < total; p++) {
    const colors = s.decisions[s.visibleIndexes[p]].highlightColors;
    if (colors.length) {
      const row = Math.min(height - 1, Math.floor((p / total) * height));
      if (!buckets.has(row)) {
        buckets.set(row, colors[0]);
      }
    }
  }
  s.dom.marks.textContent = '';
  if (!buckets.size) {
    s.dom.marks.style.display = 'none';
    return;
  }
  for (const [row, color] of buckets) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.top = `${row}px`;
    mark.style.background = color;
    s.dom.marks.appendChild(mark);
  }
  s.dom.marks.style.display = 'block';
}

/** Find-match ticks in the secondary overview strip. */
function renderFindMarksFor(s: PaneSession): void {
  const f = s.find;
  const strip = s.dom.findMarks;
  const total = s.visibleIndexes.length;
  if (!f.open || !f.occurrences.length || !total) {
    strip.textContent = '';
    strip.style.display = 'none';
    return;
  }
  const height = Math.max(1, s.dom.log.clientHeight - 8);
  const posOf = new Map<number, number>();
  for (let p = 0; p < total; p++) {
    posOf.set(s.visibleIndexes[p], p);
  }
  const buckets = new Map<number, number>();
  for (let i = 0; i < f.occurrences.length; i++) {
    const p = posOf.get(f.occurrences[i].lineIndex);
    if (p === undefined) {
      continue;
    }
    const row = Math.min(height - 1, Math.floor((p / total) * height));
    if (!buckets.has(row)) {
      buckets.set(row, i);
    }
  }
  strip.textContent = '';
  for (const [row, occIndex] of buckets) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.top = `${row}px`;
    tick.dataset.occ = String(occIndex);
    strip.appendChild(tick);
  }
  strip.style.display = 'block';
}

// --- Find (editor-style widget, per pane) ------------------------------------

function recomputeOccurrences(s: PaneSession): void {
  const f = s.find;
  f.occurrences = [];
  f.byLine = new Map();
  f.error = false;
  if (f.open && f.query) {
    const re = buildFindRegex(f);
    if (!re) {
      f.error = true;
    } else {
      f.occurrences = scanOccurrences(re, s.visibleIndexes, (li) => renderText(s.lineStore[li]));
      for (const occ of f.occurrences) {
        let list = f.byLine.get(occ.lineIndex);
        if (!list) {
          list = [];
          f.byLine.set(occ.lineIndex, list);
        }
        list.push(occ);
      }
      if (f.current >= f.occurrences.length) {
        f.current = f.occurrences.length ? f.occurrences.length - 1 : 0;
      }
    }
  }
  renderFindCount(s);
  renderFindMarksFor(s);
  refreshFindHighlights();
}

function renderFindCount(s: PaneSession): void {
  const f = s.find;
  const el = s.dom.findCount;
  el.classList.toggle('error', f.error);
  if (f.error) {
    el.textContent = 'Bad pattern';
  } else if (!f.query) {
    el.textContent = '';
  } else if (!f.occurrences.length) {
    el.textContent = 'No results';
  } else {
    el.textContent = `${Math.min(f.current + 1, f.occurrences.length)} of ${f.occurrences.length}`;
  }
}

function jumpToCurrent(s: PaneSession): void {
  const occ = s.find.occurrences[s.find.current];
  if (!occ) {
    return;
  }
  const p = s.visibleIndexes.indexOf(occ.lineIndex);
  if (p >= 0) {
    s.dom.log.scrollTop = Math.max(0, p * rowHeightPx - s.dom.log.clientHeight / 2);
  }
}

function navigateFind(s: PaneSession, dir: 1 | -1): void {
  const f = s.find;
  if (!f.occurrences.length) {
    return;
  }
  f.current = stepIndex(f.current, f.occurrences.length, dir);
  jumpToCurrent(s);
  renderFindCount(s);
  refreshFindHighlights();
}

function refreshFindHighlights(): void {
  if (!highlightCtor || !highlightRegistry) {
    return;
  }
  const ranges: Range[] = [];
  const current: Range[] = [];
  for (const s of sessions) {
    if (!s.find.open || !s.find.occurrences.length) {
      continue;
    }
    for (const row of Array.from(s.dom.log.querySelectorAll('.row-line'))) {
      const lineIndex = Number((row as HTMLElement).dataset.lineIndex);
      const textNode = row.firstChild;
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
        continue;
      }
      for (const occ of s.find.byLine.get(lineIndex) ?? []) {
        const range = document.createRange();
        range.setStart(textNode, occ.start);
        range.setEnd(textNode, occ.end);
        ranges.push(range);
        if (s.find.occurrences[s.find.current] === occ) {
          current.push(range);
        }
      }
    }
  }
  if (ranges.length) {
    highlightRegistry.set('sm-find', new highlightCtor(...ranges));
  } else {
    highlightRegistry.delete('sm-find');
  }
  if (current.length) {
    highlightRegistry.set('sm-find-cur', new highlightCtor(...current));
  } else {
    highlightRegistry.delete('sm-find-cur');
  }
}

function openFind(s: PaneSession): void {
  s.find.open = true;
  s.dom.findBar.classList.add('visible');
  s.dom.findInput.focus();
  s.dom.findInput.select();
  recomputeOccurrences(s);
}

function closeFind(s: PaneSession): void {
  s.find.open = false;
  s.find.query = '';
  s.dom.findInput.value = '';
  s.dom.findBar.classList.remove('visible');
  recomputeOccurrences(s);
}

function scheduleFindRecompute(s: PaneSession): void {
  if (s.find.debounce !== undefined) {
    clearTimeout(s.find.debounce);
  }
  s.find.debounce = setTimeout(() => {
    s.find.debounce = undefined;
    recomputeOccurrences(s);
  }, 150) as unknown as number;
}

interface SelectionPoint {
  line: number;
  off: number;
}

function captureSelection(): { start: SelectionPoint; end: SelectionPoint } | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    return undefined;
  }
  const range = sel.getRangeAt(0);
  const start = locateSelectionBoundary(range.startContainer, range.startOffset);
  const end = locateSelectionBoundary(range.endContainer, range.endOffset);
  return start && end ? { start, end } : undefined;
}

function locateSelectionBoundary(node: Node | null, offset: number): SelectionPoint | undefined {
  const row = (node instanceof Element ? node : node?.parentElement)?.closest('.row-line') as HTMLElement | null;
  if (!row || row.dataset.lineIndex === undefined) {
    return undefined;
  }
  const off = node && node.nodeType === Node.TEXT_NODE ? offset : offset === 0 ? 0 : (row.textContent?.length ?? 0);
  return { line: Number(row.dataset.lineIndex), off };
}

function restoreSelection(saved?: { start: SelectionPoint; end: SelectionPoint }): void {
  if (!saved) {
    return;
  }
  const findRow = (line: number) => panesArea.querySelector(`.row-line[data-line-index="${line}"]`);
  const startRow = findRow(saved.start.line);
  const endRow = findRow(saved.end.line);
  if (!startRow || !endRow) {
    return;
  }
  const range = new Range();
  const startText = startRow.childNodes[0] ?? startRow;
  const endText = endRow.childNodes[0] ?? endRow;
  range.setStart(startText, Math.min(saved.start.off, startRow.textContent?.length ?? 0));
  range.setEnd(endText, Math.min(saved.end.off, endRow.textContent?.length ?? 0));
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function scheduleRender(s: PaneSession): void {
  pendingRenders.add(s);
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    for (const pending of [...pendingRenders]) {
      renderWindowFor(pending);
    }
  });
}

function rebuildVisibleIndexes(s: PaneSession): void {
  s.visibleIndexes = [];
  for (let i = 0; i < s.decisions.length; i++) {
    if (s.decisions[i].visible) {
      s.visibleIndexes.push(i);
    }
  }
}

function dropOldest(s: PaneSession, count: number): void {
  if (count <= 0) {
    return;
  }
  s.lineStore.splice(0, count);
  s.decisions.splice(0, count);
  rebuildVisibleIndexes(s);
  s.marksDirty = true;
}

/** Buffer-size-dependent button states ONLY — the per-append refresh. The
 * full refreshPaneControls rewrites ~20 DOM properties and rebuilds three
 * SVG glyphs; a flood of appends must not pay that every frame. */
function refreshBufferButtons(s: PaneSession): void {
  const d = s.dom;
  const isPort = s.kind === 'port';
  d.clearBtn.disabled = s.isEmpty === true || (s.lineStore.length === 0 && !isPort);
  d.exportBtn.disabled = s.lineStore.length === 0 || s.isEmpty === true;
  // First data retires the "Waiting for data…" hint (all other hint states
  // belong to the full refresh, which runs on state changes — not appends).
  if (isPort && s.lineStore.length > 0 && !s.transientMessage) {
    d.hint.style.display = 'none';
  }
}

function appendToSession(s: PaneSession, entries: { text: string; ts?: number }[], dropCount: number): void {
  dropOldest(s, dropCount);
  for (const entry of entries) {
    s.decisions.push(matchLine(entry.text, s.tags, s.filterMode));
    if (s.decisions[s.decisions.length - 1].visible) {
      s.visibleIndexes.push(s.lineStore.length);
    }
    s.lineStore.push(entry);
  }
  s.marksDirty = true;
  scheduleRender(s);
  refreshBufferButtons(s);
  if (s.find.open) {
    scheduleFindRecompute(s);
  }
  if (s.scroll === 'follow') {
    followTo(s);
  }
}

// --- Smooth follow ------------------------------------------------------------
// In follow mode the viewport EASES toward the bottom with a per-frame
// exponential catch-up instead of teleporting on every append: a flood reads
// as continuous motion, and the catch-up converges the instant the stream
// pauses. The animation's own writes are marked programmatic so they never
// trip the Follow→locked reducer; a USER scroll interrupts instantly through
// that same reducer (locked → the loop quits on its next frame).

const FOLLOW_CATCHUP = 0.3; // fraction of the remaining distance per frame

function followTo(s: PaneSession): void {
  if (s.scroll !== 'follow' || s.followAnim !== undefined) {
    return; // locked, or a catch-up is already running (it re-reads the new target every frame)
  }
  const step = () => {
    s.followAnim = undefined;
    if (s.scroll !== 'follow') {
      return; // the user locked while we were in flight — the interrupt stands
    }
    const log = s.dom.log;
    const target = log.scrollHeight - log.clientHeight;
    const delta = target - log.scrollTop;
    if (delta <= 0) {
      if (delta < 0) {
        log.scrollTop = target; // above bottom (resize/trim): snap back
      }
      return; // converged
    }
    s.programmatic = true;
    log.scrollTop += Math.max(1, Math.ceil(delta * FOLLOW_CATCHUP));
    s.programmatic = false;
    s.followAnim = requestAnimationFrame(step);
  };
  s.followAnim = requestAnimationFrame(step);
}

function restylePane(s: PaneSession): void {
  for (let i = 0; i < s.lineStore.length; i++) {
    s.decisions[i] = matchLine(s.lineStore[i].text, s.tags, s.filterMode);
  }
  rebuildVisibleIndexes(s);
  s.marksDirty = true;
  scheduleRender(s);
  renderMarksFor(s, true); // user action: the ruler updates NOW, not on the next throttle window
  if (s.find.open) {
    scheduleFindRecompute(s);
  }
}

function restyleAllRows(): void {
  for (const s of sessions) {
    restylePane(s);
  }
}

/** The one gateway for a pane's tag edits (ADR-0006): persist the pane's
 * list, restyle THAT pane, refresh its chips. The ⚙ panel re-renders on its
 * own whenever chips do. */
function applyTagEdit(s: PaneSession, tags: Tag[]): void {
  s.tags = tags;
  commitTags(s);
  restylePane(s);
  renderChips();
}

function updateTagButton(): void {
  const selected = window.getSelection()?.toString().trim() ?? '';
  const onlyEmptySurface = sessions.every((x) => x.isEmpty === true);
  for (const btn of controlRegistry.tagButtons) {
    // tags live on panes (ADR-0006): with only the empty surface open, the
    // button stays dead — a selection in the hint is not taggable content
    btn.disabled = selected.length === 0 || onlyEmptySurface;
    setTip(
      btn,
      selected
        ? `Create a tag from "${selected.length > 24 ? selected.slice(0, 24) + '…' : selected}"`
        : 'Create a tag from the selected text (or type one in the ⚙ panel)',
    );
  }
}

function renderTimestampsControl(): void {
  for (const btn of controlRegistry.timestampsButtons) {
    btn.classList.toggle('on', showTimestamps);
    setTip(btn, `Timestamps: ${showTimestamps ? 'on' : 'off'} — click to ${showTimestamps ? 'hide' : 'show'} them`);
  }
}

function stateText(s: PaneSession): string {
  return s.state === 'connected' ? 'Connected' : s.state === 'connecting' ? 'Connecting…' : 'Idle';
}

/** The pane's status readout: an iconized connection state (✔/⌛/○, the
 * accessible name carries the full text) unless a transient message is on
 * display. */
/** Transient messages go to the focused surface's content-area hint for a
 * few seconds, then the state hint returns. The empty surface is reached
 * when no pane is focused. */
function setStatus(message?: string, target?: PaneSession): void {
  const f = target ?? focusedSession();
  if (f) {
    if (message) {
      f.transientMessage = message;
      f.transientUntil = Date.now() + 4000;
      if (f.transientTimer !== undefined) {
        clearTimeout(f.transientTimer);
      }
      f.transientTimer = setTimeout(() => {
        f.transientTimer = undefined;
        refreshPaneControls(f); // restores the state hint once the message expires
      }, 4100) as unknown as number;
    }
    refreshPaneControls(f); // writes the hint AND the (textless) status
    return;
  }
  const empty = sessions.find((x) => x.isEmpty);
  if (empty) {
    refreshPaneControls(empty); // the empty surface's hint carries it
  }
}

function startFromMenu(path: string): void {
  // Already monitored (or connecting): focus that pane instead of failing a
  // second open.
  const live = sessions.find((x) => x.kind === 'port' && x.state !== 'idle' && x.title === path);
  if (live) {
    setFocused(live.id);
    setStatus(`${path} is already being monitored`);
    return;
  }
  // Clone the newest port pane's settings; defaults otherwise.
  const last = [...sessions].reverse().find((x) => x.kind === 'port' && x.settings)?.settings;
  const cfg = last ?? DEFAULT_PORT_SETTINGS;
  post({
    type: 'connect',
    port: path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
  });
}

// --- Split-view panes --------------------------------------------------------

function ensureEmptySurface(): void {
  // The empty state IS a pane-shaped Session (C1/C2): the same builder, the
  // same refresh path, the same replace flow. id -1 never reaches the host;
  // the surface is destroyed and rebuilt as real panes come and go.
  if (sessions.length > 0 || sessions.some((x) => x.isEmpty)) {
    return;
  }
  createSession({
    sessionId: -1,
    kind: 'port',
    title: '', // no ghost option: the picker seeds from lastUsedPort at refresh
    state: 'idle',
    isEmpty: true,
    settings: { ...DEFAULT_PORT_SETTINGS },
  });
}

/** Rewrites a glyph button's innerHTML only when its icon actually changes —
 * innerHTML assignment parses markup, and refreshPaneControls runs on every
 * state tick of a streaming pane. */
function setGlyph(btn: HTMLElement, glyph: IconName): void {
  if (btn.dataset.glyph !== glyph) {
    btn.dataset.glyph = glyph;
    btn.innerHTML = icon(glyph);
  }
}

/** Refreshes one pane's self-contained controls from its session state. */
function refreshPaneControls(s: PaneSession): void {
  const d = s.dom;
  const isPort = s.kind === 'port';
  const isConnected = isPort && s.state === 'connected';

  d.dot.className = 'tab-dot' + (s.state === 'connected' ? ' live' : s.state === 'connecting' ? ' pending' : '');
  d.title.textContent = (s.kind === 'file' ? '\u{1F4C4} ' : '') + s.title;
  d.title.title = s.kind === 'file' ? `${s.title} (read-only log file)` : `${s.title} — ${s.state}`;
  d.root.title = d.title.title;

  if (d.play) {
    d.play.style.display = isPort ? '' : 'none';
    d.play.className = 'start-stop';
    setGlyph(d.play, isConnected ? 'stop' : 'play');
    setTip(d.play, isConnected ? `Stop monitoring ${s.title}` : `Start monitoring ${s.title}`);
    d.play.disabled = s.state === 'connecting' || (s.isEmpty === true && !lastPorts.length);
  }

  // The empty surface has nothing to clear: the button renders dead there
  // (ui-spec §3: 空状态 — 全部控件在场，动作禁用).
  d.clearBtn.disabled = s.isEmpty === true || (s.lineStore.length === 0 && !isConnected);
  setTip(d.clearBtn, `Clear ${s.title}`);
  d.exportBtn.disabled = s.lineStore.length === 0 || s.isEmpty === true;
  setTip(d.exportBtn, `Export ${s.title}'s buffered log to a file`);

  if (d.logBtn) {
    d.logBtn.style.display = isPort ? '' : 'none';
    const logOn = isPort && s.logDesired;
    d.logBtn.classList.toggle('on', logOn);
    d.logBtn.classList.toggle('rec', logOn);
    setGlyph(d.logBtn, logOn ? 'circle-record' : 'circle');
    if (logOn) {
      const where = s.logFile ? ` (now: ${s.logFile})` : s.logDirectory ? ` into ${s.logDirectory}` : '';
      setTip(d.logBtn, `Log to file: on${where} — click to stop`);
    } else {
      setTip(d.logBtn, 'Log to file: off — click to log this session to a .log file');
    }
  }

  setGlyph(d.scrollBtn, s.scroll === 'follow' ? 'arrow-down' : 'lock');
  d.scrollBtn.classList.toggle('locked', s.scroll === 'locked');
  setTip(
    d.scrollBtn,
    s.scroll === 'follow'
      ? 'Viewport follows new lines — click to lock'
      : 'Scroll locked, data keeps arriving — click to rejoin',
  );

  // Serial config: the PORT is locked while connected, but the parameters
  // stay editable — an edit reconnects the pane with the new settings
  // (MS-parity behavior). The port picker follows the same philosophy:
  // picking another port live MOVES the pane there. Everything locks
  // while connecting.
  const portLocked = s.state === 'connecting';
  const paramsLocked = s.state === 'connecting';
  if (d.portSelect) {
    d.portSelect.disabled = portLocked;
  }
  if (d.baudInput) d.baudInput.disabled = paramsLocked;
  if (d.dbSel) d.dbSel.disabled = paramsLocked;
  if (d.paritySel) d.paritySel.disabled = paramsLocked;
  if (d.sbSel) d.sbSel.disabled = paramsLocked;

  // Send bar: collapsed by default, toggled per pane.
  if (d.sendToggle) {
    d.sendToggle.style.display = isPort ? '' : 'none';
    d.sendToggle.classList.toggle('on', isPort && !s.sendCollapsed);
    setTip(d.sendToggle, !isPort ? '' : s.sendCollapsed ? 'Show the send bar' : 'Hide the send bar');
  }
  d.sendRow.style.display = isPort && !s.sendCollapsed ? 'flex' : 'none';
  // This pane's funnel shows ITS filter mode, not some global one. The
  // aria-label stays the stable name; the mode detail rides in the tooltip.
  if (d.ctlRefs) {
    d.ctlRefs.filterToggleBtn.classList.toggle('on', s.filterMode !== 'off');
    d.ctlRefs.filterToggleBtn.setAttribute('aria-label', 'Filter');
    d.ctlRefs.filterToggleBtn.title = `Filter: ${s.filterMode} — click to choose`;
  }
  d.sendInput.disabled = !isConnected;
  d.sendBtn.disabled = !isConnected;
  d.sendInput.placeholder = isConnected ? `To ${s.title}: type a message to send…` : 'Start monitoring to send';

  // Content-area hint: empty-pane state hints, and ANY transient message
  // (open failures, export results) — the bar tail never carries text.
  let hintText = '';
  if (s.isEmpty) {
    hintText = 'No monitors open — pick a port above and press ▶, or open a saved log file (📂)';
  } else if (isPort && s.lineStore.length === 0) {
    if (s.state === 'connecting') {
      hintText = `Connecting to ${s.title}…`;
    } else if (s.state === 'connected') {
      hintText = 'Waiting for data…';
    } else {
      hintText = 'Stopped — press ▶ to start monitoring';
    }
  }
  if (s.transientMessage && s.transientUntil !== undefined && Date.now() < s.transientUntil) {
    hintText = s.transientMessage;
  }
  d.hint.style.display = hintText ? 'flex' : 'none';
  if (hintText) {
    d.hint.textContent = hintText;
  }

  // This pane's own status readout (end of its controls segment): the
  // accessible name announces the state; the visible text stays empty —
  // the leading dot carries the state and messages go to the hint above.
  setTip(d.status, s.message || stateText(s));
  d.status.textContent = '';
}

function buildPane(s: PaneSession): PaneDom {
  const root = document.createElement('div');
  root.className = s.isEmpty ? 'pane empty' : 'pane';
  const bar = document.createElement('div');
  bar.className = 'pane-header';

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  const title = document.createElement('span');
  title.className = 'pane-title';

  const mkBtn = (glyph: string, title: string, cls = 'pbtn') => {
    const b = document.createElement('button');
    b.className = cls;
    b.innerHTML = glyph;
    setTip(b, title);
    return b;
  };
  // The wide primary button, SAME position as the start bar's Start: the
  // two states read as one bar (verdict from the unified-bar prototype).
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'start-stop';
  play.innerHTML = icon('play'); // glyph only — the wide button carries no text
  setTip(play, `Start monitoring ${s.title}`);
  const actions = buildPaneActionButtons();
  const actionGroup = newBarGroup();
  // The empty surface has no pane to act on: its action buttons render
  // dead (same slots as a live pane's — one bar shape, two states).
  for (const b of Object.values(actions)) {
    if (s.isEmpty && b !== actions.clearBtn) {
      b.disabled = true;
    }
  }
  actionGroup.append(
    actions.sendToggle,
    actions.logBtn,
    actions.exportBtn,
    actions.scrollBtn,
    actions.findBtn,
    actions.close,
  );
  const { sendToggle, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close } = actions;

  let portSelect: HTMLSelectElement | undefined;
  let baudInput: HTMLInputElement | undefined;
  let dbSel: HTMLSelectElement | undefined;
  let paritySel: HTMLSelectElement | undefined;
  let sbSel: HTMLSelectElement | undefined;
  let leSel: HTMLSelectElement | undefined;

  if (s.kind === 'port') {
    title.style.display = 'none'; // the port select shows the identity
    portSelect = document.createElement('select');
    const portSel = portSelect; // narrowed alias for the closures below
    portSelect.className = 'ph-ctl ph-port';
    setTip(portSelect, 'Port — picking another port moves this pane to it');
    fillPortOptions(portSelect, s.title || lastUsedPort); // every known port; a stub seeds from lastUsedPort
    // Keep the list fresh while the picker is usable, like the start bar.
    portSel.addEventListener('click', () => {
      if (s.state !== 'connecting') {
        post({ type: 'refreshPorts' });
      }
    });
    // A port pick is an edit like any other: while stopped it applies on ▶
    // (startPane reads the select); while connected it moves the pane live
    // through the replace flow. Picking the pane's own port does nothing.
    portSel.addEventListener('change', () => {
      if (s.state === 'connected' && portSel.value && portSel.value !== s.title) {
        startPane(s);
      }
    });

    const cfg = s.settings ?? DEFAULT_PORT_SETTINGS;
    // Baud quick-pick + collapsible params come from the shared builder —
    // the same block the empty-state start bar renders.
    const ctl = buildSerialConfigControls(cfg, s.lineEnding);
    baudInput = ctl.baudInput;
    dbSel = ctl.dbSel;
    paritySel = ctl.paritySel;
    sbSel = ctl.sbSel;
    leSel = ctl.leSel;

    // Control edits become the pane's settings; while connected a param
    // edit also reconnects the pane with the new settings.
    const applyParams = (session: PaneSession) => {
      if (session.state === 'connected' && session.settings) {
        post({ type: 'reconnect', sessionId: session.id, settings: { ...session.settings } });
      }
    };
    baudInput.addEventListener('change', () => {
      if (s.settings) {
        s.settings.baudRate = Number(baudInput!.value) || 115200;
        applyParams(s);
      }
    });
    dbSel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.dataBits = Number(dbSel!.value) || 8;
        applyParams(s);
      }
    });
    paritySel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.parity = paritySel!.value;
        applyParams(s);
      }
    });
    sbSel.addEventListener('change', () => {
      if (s.settings) {
        s.settings.stopBits = Number(sbSel!.value) || 1;
        applyParams(s);
      }
    });
    leSel.addEventListener('change', () => {
      s.lineEnding = leSel!.value;
    });

    const head = newBarGroup();
    head.append(dot, title, portSelect, ctl.baudWrap, ctl.paramsToggle, ctl.params);
    bar.append(head);
  } else {
    bar.append(dot, title);
  }

  root.appendChild(bar);

  // Tag chips row: a copy under this pane's control bar (doubled like the
  // global controls); hidden while there are no tags.
  const paneTags = document.createElement('div');
  paneTags.className = 'pane-tags';
  paneTags.style.display = 'none';
  root.appendChild(paneTags);

  // Body: console + marks strips + floating find widget + state hint.
  const body = document.createElement('div');
  body.className = 'pane-body';
  const logEl = document.createElement('div');
  logEl.className = 'pane-log';
  const marks = document.createElement('div');
  marks.className = 'log-marks';
  marks.title = 'Highlighted lines — click to jump';
  marks.setAttribute('aria-hidden', 'true'); // decorative: the same data is in the stream
  const findMarks = document.createElement('div');
  findMarks.className = 'find-marks';
  findMarks.title = 'Find matches — click to jump to the nearest one';
  findMarks.setAttribute('aria-hidden', 'true');
  const hint = document.createElement('div');
  hint.className = 'pane-hint';
  hint.setAttribute('aria-live', 'polite'); // state hints announce

  const findBar = document.createElement('div');
  findBar.className = 'find-bar';
  const findInput = document.createElement('input');
  findInput.placeholder = 'Find';
  findInput.spellcheck = false;
  findInput.setAttribute('autocomplete', 'off');
  const findCase = document.createElement('button');
  findCase.className = 'fbtn';
  findCase.textContent = 'Aa';
  findCase.title = 'Match case';
  const findWord = document.createElement('button');
  findWord.className = 'fbtn';
  findWord.textContent = 'ab';
  findWord.title = 'Match whole word';
  const findRegex = document.createElement('button');
  findRegex.className = 'fbtn';
  findRegex.textContent = '.*';
  findRegex.title = 'Use regular expression';
  const findCount = document.createElement('span');
  findCount.className = 'find-count';
  findCount.setAttribute('aria-live', 'polite'); // the counter updates per keystroke
  const findPrev = document.createElement('button');
  findPrev.className = 'fbtn';
  findPrev.innerHTML = icon('arrow-up');
  setTip(findPrev, 'Previous match (Shift+Enter)');
  const findNext = document.createElement('button');
  findNext.className = 'fbtn';
  findNext.innerHTML = icon('arrow-down');
  setTip(findNext, 'Next match (Enter)');
  const findClose = document.createElement('button');
  findClose.className = 'fbtn';
  findClose.innerHTML = icon('close');
  setTip(findClose, 'Close find (Escape)');
  const findToggles = document.createElement('span');
  findToggles.className = 'find-toggles';
  findToggles.append(findCase, findWord, findRegex);
  const findNav = document.createElement('span');
  findNav.className = 'find-nav';
  findNav.append(findPrev, findNext, findClose);
  findBar.append(findInput, findToggles, findCount, findNav);
  body.append(logEl, marks, findMarks, findBar, hint);

  // Port-local send bar (collapsed by default).
  const sendRow = document.createElement('div');
  sendRow.className = 'pane-send';
  const sendInput = document.createElement('input');
  sendInput.spellcheck = false; // machine data, not prose
  sendInput.setAttribute('autocomplete', 'off');
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send';
  setTip(sendBtn, 'Send the message with the pane\'s line ending');
  sendRow.append(sendInput, sendBtn);

  root.append(body, sendRow);
  panesArea.appendChild(root);

  root.addEventListener('click', () => setFocused(s.id));

  close.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'closeSession', sessionId: s.id });
    removeSession(s.id);
  });

  play.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.isEmpty) {
      // The empty surface's Start: connect the port picked on its own bar,
      // with the config the bar shows (params + line ending included).
      const port = s.dom.portSelect?.value;
      if (!port) {
        return;
      }
      lastUsedPort = port;
      post({
        type: 'connect',
        port,
        baudRate: Number(s.dom.baudInput?.value) || DEFAULT_BAUD_RATE,
        dataBits: Number(s.dom.dbSel?.value) || 8,
        stopBits: Number(s.dom.sbSel?.value) || 1,
        parity: s.dom.paritySel?.value || 'none',
        lineEnding: s.dom.leSel?.value || 'LF',
      });
      return;
    }
    if (s.state === 'connected') {
      post({ type: 'disconnect', sessionId: s.id });
    } else if (s.state !== 'connecting') {
      startPane(s);
    }
  });

  sendToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    s.sendCollapsed = !s.sendCollapsed;
    refreshPaneControls(s);
  });

  clearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind === 'port') {
      post({ type: 'clear', sessionId: s.id }); // host resets its ring count too
    }
    clearBuffer(s);
  });

  logBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.kind !== 'port' || s.state === 'connecting') {
      return;
    }
    post({ type: 'setLogSession', sessionId: s.id, enabled: !s.logDesired });
  });

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    post({ type: 'export', sessionId: s.id });
  });

  scrollBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    s.scroll = scrollReducer(s.scroll, { type: 'toggle' });
    if (s.scroll === 'follow') {
      followTo(s);
    }
    refreshPaneControls(s);
  });

  findBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (s.find.open) {
      closeFind(s);
    } else {
      setFocused(s.id);
      openFind(s);
    }
  });

  marks.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = marks.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    logEl.scrollTop = frac * (logEl.scrollHeight - logEl.clientHeight);
  });

  findMarks.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = findMarks.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - rect.top) / Math.max(1, rect.height)));
    const total = s.visibleIndexes.length;
    if (!total || !s.find.occurrences.length) {
      return;
    }
    const targetP = frac * total;
    let chosen = s.find.occurrences.length - 1;
    for (let i = 0; i < s.find.occurrences.length; i++) {
      const p = s.visibleIndexes.indexOf(s.find.occurrences[i].lineIndex);
      if (p >= targetP) {
        chosen = i;
        break;
      }
    }
    s.find.current = chosen;
    jumpToCurrent(s);
    renderFindCount(s);
    refreshFindHighlights();
  });

  logEl.addEventListener('scroll', () => {
    if (s.programmatic) {
      s.programmatic = false; // the catch-up's own write — never trips the lock
      return;
    }
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    const next = scrollReducer(s.scroll, { type: 'scrolled', atBottom });
    if (next !== s.scroll) {
      s.scroll = next;
      refreshPaneControls(s);
    }
    scheduleRender(s);
  });

  findInput.addEventListener('input', () => {
    s.find.query = findInput.value;
    s.find.current = 0;
    scheduleFindRecompute(s);
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      navigateFind(s, e.shiftKey ? -1 : 1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      navigateFind(s, 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      navigateFind(s, -1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind(s);
      logEl.focus();
    }
    e.stopPropagation();
  });
  const wireToggle = (btn: HTMLButtonElement, key: 'matchCase' | 'wholeWord' | 'regex') => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      s.find[key] = !s.find[key];
      btn.classList.toggle('on', s.find[key]);
      s.find.current = 0;
      recomputeOccurrences(s);
    });
  };
  wireToggle(findCase, 'matchCase');
  wireToggle(findWord, 'wholeWord');
  wireToggle(findRegex, 'regex');
  findPrev.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateFind(s, -1);
  });
  findNext.addEventListener('click', (e) => {
    e.stopPropagation();
    navigateFind(s, 1);
  });
  findClose.addEventListener('click', (e) => {
    e.stopPropagation();
    closeFind(s);
  });

  sendBtn.addEventListener('click', () => sendCurrent(s));
  sendInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendCurrent(s);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!s.sendHistory.length) {
        return;
      }
      if (s.sendIndex === s.sendHistory.length) {
        s.sendDraft = sendInput.value;
      }
      s.sendIndex = Math.max(0, s.sendIndex - 1);
      sendInput.value = s.sendHistory[s.sendIndex];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (s.sendIndex >= s.sendHistory.length) {
        return;
      }
      s.sendIndex++;
      sendInput.value = s.sendIndex === s.sendHistory.length ? s.sendDraft : s.sendHistory[s.sendIndex];
    }
  });

  const spacerTop = document.createElement('div');
  spacerTop.className = 'log-spacer';
  const spacerBottom = document.createElement('div');
  spacerBottom.className = 'log-spacer';

  // This pane's own copy of the global controls. ＋ and refresh form one
  // group that sits immediately LEFT of the wide start/stop button.
  const controls = buildGlobalControls(s);
  bar.appendChild(play);
  bar.appendChild(actions.clearBtn); // clear is a primary action: same size, right beside start/stop
  const addRefresh = newBarGroup();
  addRefresh.append(controls.addWrap, controls.refreshBtn);
  bar.insertBefore(addRefresh, play);
  bar.appendChild(actionGroup);
  bar.appendChild(controls.seg);

  return { root, bar, tags: paneTags, dot, title, play, sendToggle, clearBtn, logBtn, exportBtn, scrollBtn, findBtn, close, portSelect, baudInput, dbSel, paritySel, sbSel, leSel, log: logEl, marks, findMarks, findBar, findInput, findCase, findWord, findRegex, findCount, findPrev, findNext, findClose, sendRow, sendInput, sendBtn, hint, spacerTop, spacerBottom, globalSeg: controls.seg, status: controls.status, ctlRefs: { tagBtn: controls.tagBtn, filterToggleBtn: controls.filterToggleBtn, timestampsBtn: controls.timestampsBtn, logDirBtn: controls.logDirBtn } };
}

function createSession(m: {
  sessionId: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  settings?: PortSettings;
  isEmpty?: boolean;
}): PaneSession {
  // The pane-shaped stub occupies the slot but is not a pane: a real session
  // taking it over IS the first pane (no divider before a lone pane).
  const isFirst = sessions.every((x) => x.isEmpty);
  if (m.kind === 'port' && !m.isEmpty) {
    lastUsedPort = m.title; // closing the last pane re-selects this port
  }
  const s: PaneSession = {
    id: m.sessionId,
    kind: m.kind,
    title: m.title,
    state: m.state,
    isEmpty: m.isEmpty,
    settings: m.settings,
    lineEnding: 'LF',
    tags: [],
    filterMode: 'off',
    sendCollapsed: true,
    lineStore: [],
    decisions: [],
    visibleIndexes: [],
    scroll: 'follow',
    logDesired: false,
    find: {
      open: false,
      query: '',
      matchCase: false,
      wholeWord: false,
      regex: false,
      error: false,
      occurrences: [],
      current: 0,
      byLine: new Map(),
      debounce: undefined,
    },
    transientMessage: undefined,
    transientUntil: undefined,
    transientTimer: undefined,
    marksDirty: true,
    dom: undefined as unknown as PaneDom,
    sendHistory: [],
    sendIndex: 0,
    sendDraft: '',
  };
  // A real session arriving retires the empty surface (it is the same slot,
  // now showing a live pane) — no dividers or stale bars left behind. The new
  // session is BUILT and joins the list FIRST: retiring the stub while it was
  // still the only session tripped removeSession's "empty surface returns"
  // hook, which resurrected the stub — one start put the fresh empty bar back
  // beside the new pane. (A session in the list always has dom: buildPane
  // reads no shared state, so the builder can safely run before the push.)
  s.dom = buildPane(s);
  measureRowHeight(s.dom.log);
  sessions.push(s);
  if (!s.isEmpty) {
    const stub = sessions.find((x) => x.isEmpty);
    if (stub) {
      removeSession(stub.id);
    }
  }
  if (!isFirst) {
    const divider = document.createElement('div');
    divider.className = 'pane-divider';
    divider.addEventListener('mousedown', (e) => startPaneDrag(s, e));
    divider.addEventListener('dblclick', () => {
      s.dom.root.style.flexGrow = '';
    });
    panesArea.insertBefore(divider, s.dom.root);
    s.dividerLeft = divider;
  }
  // A restart in flight: mount the replacement HIDDEN, adjacent to the pane
  // it replaces — no second view flashes during the hop, and on connect it
  // takes over the old pane's exact slot (the strip-end jump is gone too).
  if (pendingReplaceNewId === m.sessionId && pendingReplaceOldId !== undefined) {
    const oldPane = sessions.find((x) => x.id === pendingReplaceOldId);
    if (oldPane) {
      // The log belongs to the PANE, not the connection (GLOSSARY): a
      // restart — ■/▶, a port move, a parameter change — carries the
      // buffered lines across the session swap. The arrays move by
      // reference: the old host session is still live until the connect
      // completes, so lines it delivers in that window land in the same
      // store the replacement now shares. Find settings survive too; their
      // per-line state is recomputed against the fresh DOM.
      s.lineStore = oldPane.lineStore;
      s.decisions = oldPane.decisions;
      s.visibleIndexes = oldPane.visibleIndexes;
      s.scroll = 'follow'; // ▶ means "rejoin the live tail" — a scroll lock
      // acquired while browsing the stopped buffer does not survive a start.
      s.sendHistory = oldPane.sendHistory;
      s.sendIndex = oldPane.sendIndex;
      s.sendDraft = oldPane.sendDraft;
      s.lineEnding = oldPane.lineEnding;
      s.tags = oldPane.tags;
      s.filterMode = oldPane.filterMode;
      s.find = { ...oldPane.find, occurrences: [], byLine: new Map(), debounce: undefined };
      if (s.find.open) {
        scheduleFindRecompute(s);
      }
      renderChipsInto(s); // the fresh DOM has an empty chip row — paint the inherited tags now
      s.marksDirty = true; // fresh DOM: the overview strip repaints in full
      // Paint the restored log SYNCHRONOUSLY: the reveal below happens in
      // the same synchronous pass as this creation, so a deferred rAF render
      // would show one blank frame — the flicker the user reported. The
      // pane is hidden here (clientHeight 0), so this window is just the
      // overscan rows with correct spacers; the next rAF refines the window
      // for the now-visible pane.
      renderWindowFor(s);
      // Refine the window once the pane is visible (clientHeight > 0).
      scheduleRender(s);
      // Viewport handoff: a restart always lands at the bottom. The snap
      // runs on the next frame (after the rAF render refines the window for
      // the visible pane) and is marked programmatic so it cannot trip the
      // Follow→locked reducer.
      requestAnimationFrame(() => {
        s.programmatic = true;
        s.dom.log.scrollTop = s.dom.log.scrollHeight;
        s.programmatic = false;
      });
      panesArea.insertBefore(s.dom.root, oldPane.dom.root);
      if (s.dividerLeft) {
        panesArea.insertBefore(s.dividerLeft, s.dom.root);
      }
      s.dom.root.style.display = 'none';
    }
  }
  refreshPaneControls(s);
  setFocused(s.id);
  return s;
}

/** Drag-resize: the divider adjusts the left pane's flex-grow weight 1:1. */
function startPaneDrag(s: PaneSession, e: MouseEvent): void {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = s.dom.root.getBoundingClientRect().width || 300;
  const startWeight = Number(s.dom.root.style.flexGrow) || 1;
  const pxPerWeight = startWidth / startWeight;
  document.body.classList.add('pane-dragging');
  const move = (ev: MouseEvent) => {
    const weight = Math.min(6, Math.max(0.35, startWeight + (ev.clientX - startX) / pxPerWeight));
    s.dom.root.style.flexGrow = String(weight);
  };
  const up = () => {
    document.body.classList.remove('pane-dragging');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function setFocused(id: number | undefined): void {
  focusedId = id;
  for (const s of sessions) {
    s.dom.root.classList.toggle('focused', s.id === focusedId);
  }
  // With doubled controls there is nothing to move; focus only steers
  // Ctrl+F, the API clear, and transient status messages.
  setStatus();
}

function removeSession(id: number): void {
  const idx = sessions.findIndex((s) => s.id === id);
  if (idx === -1) {
    return;
  }
  const [gone] = sessions.splice(idx, 1);
  if (gone.find.debounce !== undefined) {
    clearTimeout(gone.find.debounce);
  }
  if (gone.followAnim !== undefined) {
    cancelAnimationFrame(gone.followAnim); // the catch-up dies with its pane
  }
  unregisterControls(gone.dom.ctlRefs);
  gone.dom.root.remove();
  gone.dividerLeft?.remove();
  if (idx === 0 && sessions.length > 0) {
    sessions[0].dividerLeft?.remove();
    sessions[0].dividerLeft = undefined;
  }
  pendingRenders.delete(gone);
  if (pendingReplaceOldId === id && pendingReplaceNewId !== undefined) {
    // The old pane of an in-flight restart is being closed by hand: the
    // HIDDEN replacement becomes the survivor — reveal it now and KEEP the
    // binding, so its connect still closes the old HOST session (which
    // releases the old port). Clearing the slots here would orphan that
    // host session: no pane, port held, nothing in the UI to close.
    const replacement = sessions.find((x) => x.id === pendingReplaceNewId);
    if (replacement) {
      replacement.dom.root.style.display = '';
    }
  } else if (pendingReplaceOldId === id) {
    pendingReplaceOldId = undefined;
    pendingReplaceNewId = undefined;
  }
  if (focusedId === id) {
    const next = sessions[idx] ?? sessions[idx - 1];
    setFocused(next?.id);
  }
  if (sessions.length === 0) {
    ensureEmptySurface(); // the empty surface returns after the last pane closes
  }
  refreshFindHighlights();
}

/** Restarts this pane's port with its OWN controls and settings. */
function startPane(s: PaneSession): void {
  if (s.kind !== 'port') {
    return;
  }
  if (pendingReplaceOldId === s.id) {
    return; // this pane's restart is already in flight — rapid ▶ must not stack sessions
  }
  const port = (s.dom.portSelect?.value || s.title).trim();
  pendingReplaceOldId = s.id; // replaced by the new session on success
  pendingReplaceNewId = undefined; // bound when the host reports the new session
  const cfg = s.settings ?? DEFAULT_PORT_SETTINGS;
  post({
    type: 'connect',
    port,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
  });
}

function sendCurrent(s: PaneSession): void {
  if (s.kind !== 'port' || s.state !== 'connected') {
    return;
  }
  const text = s.dom.sendInput.value;
  s.dom.sendInput.value = '';
  if (text && s.sendHistory[s.sendHistory.length - 1] !== text) {
    s.sendHistory.push(text);
    if (s.sendHistory.length > 100) {
      s.sendHistory.shift();
    }
  }
  s.sendIndex = s.sendHistory.length;
  s.sendDraft = '';
  post({ type: 'send', sessionId: s.id, text, lineEnding: s.lineEnding });
}

function clearBuffer(s: PaneSession): void {
  s.lineStore.length = 0;
  s.decisions.length = 0;
  s.visibleIndexes = [];
  s.scroll = scrollReducer(s.scroll, { type: 'reset' });
  s.marksDirty = true;
  scheduleRender(s);
  if (s.find.open) {
    recomputeOccurrences(s);
  }
  refreshPaneControls(s);
}

function renderChips(): void {
  // Doubled like every other control, but each pane renders ITS OWN tags
  // (ADR-0006) — a pane's chips are never another pane's list.
  for (const s of sessions) {
    renderChipsInto(s);
  }
}

/** Persists a pane's tag list; the host keys it by the pane's port. */
function commitTags(s: PaneSession): void {
  post({ type: 'saveTags', sessionId: s.id, tags: s.tags });
}

function renderChipsInto(s: PaneSession): void {
  const row = s.dom.tags;
  row.textContent = '';
  row.style.display = s.tags.length ? 'flex' : 'none';
  for (const t of s.tags) {
    const chip = document.createElement('div');
    chip.className = 'chip' + (t.highlight || t.filter ? '' : ' chip-off');
    chip.style.borderColor = t.color;
    chip.style.background = t.highlight ? `${t.color}33` : 'transparent';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = t.name;
    const segH = document.createElement('span');
    segH.className = 'seg' + (t.highlight ? ' on' : '');
    segH.textContent = 'H';
    segH.title = t.highlight ? 'Highlighting ON — click to turn off' : 'Highlighting OFF — click to turn on';
    segH.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTagEdit(s, patchedTag(s.tags, t.id, { highlight: !t.highlight }));
    });
    const segF = document.createElement('span');
    segF.className = 'seg' + (t.filter ? ' on' : '');
    segF.textContent = 'F';
    segF.title = t.filter ? 'Filtering ON — click to turn off' : 'Filtering OFF — click to turn on';
    segF.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTagEdit(s, patchedTag(s.tags, t.id, { filter: !t.filter }));
    });
    chip.title = `"${t.name}" — H: highlight on/off, F: filter on/off, double-click: delete`;
    chip.addEventListener('dblclick', () => {
      applyTagEdit(s, withoutTag(s.tags, t.id));
    });
    chip.append(nameSpan, segH, segF);
    row.appendChild(chip);
  }
  renderManagePanel();
}

let manageOpen = false;
let managePanel: HTMLDivElement;

function renderManagePanel(): void {
  managePanel.style.display = manageOpen ? 'flex' : 'none';
  if (!manageOpen) {
    managePanel.textContent = '';
    return;
  }
  managePanel.textContent = '';
  // The panel edits the FOCUSED pane's list (ADR-0006) — never another's.
  const owner = focusedSession();
  const paneLabel = document.createElement('div');
  paneLabel.className = 'menu-header';
  paneLabel.textContent = owner ? 'Tags — ' + owner.title : 'Tags — no monitor focused';
  managePanel.appendChild(paneLabel);
  const addRow = document.createElement('div');
  addRow.className = 'tag-edit-row';
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.className = 'tag-pattern';
  addInput.placeholder = 'New tag pattern — type and press Enter (or click + Add)';
  addInput.disabled = !owner;
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add';
  addBtn.textContent = '+ Add';
  addBtn.disabled = !owner;
  const addTag = () => {
    const value = addInput.value.trim();
    if (!value || !owner) {
      return;
    }
    applyTagEdit(owner, [...owner.tags, makeTag(owner.tags, value)]);
    addInput.value = '';
    renderManagePanel();
  };
  addBtn.addEventListener('click', addTag);
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      addTag();
    }
  });
  const clearAllBtn = document.createElement('button');
  clearAllBtn.className = 'tag-delete';
  clearAllBtn.textContent = 'Delete all';
  clearAllBtn.title = 'Remove every tag';
  clearAllBtn.disabled = !owner || owner.tags.length === 0;
  clearAllBtn.addEventListener('click', () => {
    if (!owner) {
      return;
    }
    applyTagEdit(owner, []);
    renderManagePanel();
  });
  addRow.append(addInput, addBtn, clearAllBtn);
  managePanel.appendChild(addRow);
  for (const t of owner?.tags ?? []) {
    const row = document.createElement('div');
    row.className = 'tag-edit-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'tag-name';
    nameInput.value = t.name;
    nameInput.title = 'Tag name';
    nameInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { name: nameInput.value }));
    });

    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.className = 'tag-pattern';
    patternInput.value = t.pattern;
    patternInput.placeholder = 'Match pattern (substring or regex source)';
    // An invalid regex never matches and never throws (matchLine catches) —
    // surface it HERE so the tag never sits silently dead.
    const syncPatternValidity = () => {
      const ok = isTagPatternValid(patternInput.value, regexInput.checked);
      patternInput.classList.toggle('invalid', !ok);
      patternInput.setAttribute('aria-invalid', ok ? 'false' : 'true');
      patternInput.title = ok
        ? 'Match pattern (substring or regex source)'
        : 'Invalid regular expression — this tag never matches until fixed';
    };
    patternInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { pattern: patternInput.value }));
      syncPatternValidity();
    });

    const hlLabel = document.createElement('label');
    const hlInput = document.createElement('input');
    hlInput.type = 'checkbox';
    hlInput.checked = t.highlight;
    hlInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { highlight: hlInput.checked }));
    });
    hlLabel.appendChild(hlInput);
    hlLabel.appendChild(document.createTextNode('H'));

    const flLabel = document.createElement('label');
    const flInput = document.createElement('input');
    flInput.type = 'checkbox';
    flInput.checked = t.filter;
    flInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { filter: flInput.checked }));
    });
    flLabel.appendChild(flInput);
    flLabel.appendChild(document.createTextNode('F'));

    const regexLabel = document.createElement('label');
    const regexInput = document.createElement('input');
    regexInput.type = 'checkbox';
    regexInput.className = 'tag-regex';
    regexInput.checked = t.isRegex;
    regexInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { isRegex: regexInput.checked }));
      syncPatternValidity(); // toggling to regex can invalidate the current source
    });
    regexLabel.appendChild(regexInput);
    regexLabel.appendChild(document.createTextNode('regex'));

    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = t.color;
    colorInput.addEventListener('change', () => {
      if (!owner) return;
      applyTagEdit(owner, patchedTag(owner.tags, t.id, { color: colorInput.value }));
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'tag-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.title = `Delete tag "${t.name}"`;
    deleteBtn.addEventListener('click', () => {
      if (!owner) return;
      applyTagEdit(owner, withoutTag(owner.tags, t.id));
      renderManagePanel();
    });

    row.append(nameInput, patternInput, regexLabel, hlLabel, flLabel, colorInput, deleteBtn);
    syncPatternValidity(); // host-pushed tags can arrive with a dead pattern
    managePanel.appendChild(row);
  }
  if (!owner) {
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'Open a monitor to manage its tags.';
    managePanel.appendChild(hint);
  } else if (!owner.tags.length) {
    const hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'No tags yet — type a pattern above, or select text in the output and press the tag button.';
    managePanel.appendChild(hint);
  }
  // Which VSIX am I running? (Field reports have twice been stale-VSIX
  // artifacts — make the version impossible to confuse.)
  const versionMeta = document.querySelector('meta[name="extension-version"]')?.getAttribute('content');
  if (versionMeta) {
    const ver = document.createElement('div');
    ver.className = 'panel-hint version';
    ver.textContent = `Serial Lens v${versionMeta}`;
    managePanel.appendChild(ver);
  }
}

// --- Host messages -----------------------------------------------------------

function sessionFor(id: number): PaneSession | undefined {
  return sessions.find((s) => s.id === id);
}

// The router decides (hostRouter.ts); main.ts owns the state it steers. The
// context below is the COMPLETE surface the router may touch — anything a
// new message type needs must be added here explicitly.
const hostCtx: HostRouterContext = {
  sessions,
  get logDirButtons() {
    return controlRegistry.logDirButtons;
  },
  getFocusedId: () => focusedId,
  getPendingReplace: () => ({ oldId: pendingReplaceOldId, newId: pendingReplaceNewId }),
  setPendingReplace: (oldId, newId) => {
    pendingReplaceOldId = oldId;
    pendingReplaceNewId = newId;
  },
  setLastPorts: (ports) => {
    lastPorts = ports;
  },
  setShowTimestamps: (enabled) => {
    showTimestamps = enabled;
  },
  setRecentBauds: (values) => {
    recentBauds = values;
  },
  post,
  sessionFor,
  focusedSession,
  rebuildPortOptions,
  refreshPaneControls,
  updateTagButton,
  appendToSession,
  renderTimestampsControl,
  recomputeOccurrences,
  scheduleRender,
  setStatus,
  clearBuffer,
  createSession: (m) => {
    createSession(m);
  },
  removeSession,
  restylePane,
  renderChips,
};

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => {
  handleHostMessage(hostCtx, e.data);
});

/** The option list a port picker should show: every known port, plus
 * `current` kept selectable when it vanished from the list (the pane must
 * keep its identity). */
function portOptionList(current: string): { value: string; label: string; tip: string }[] {
  // Options show the bare path — the SAME face the pane bars present; a
  // port description rides in the tooltip.
  const wanted: { value: string; label: string; tip: string }[] = [];
  if (current !== '' && !lastPorts.some((p) => p.path === current)) {
    wanted.push({ value: current, label: current, tip: '' });
  }
  for (const p of lastPorts) {
    wanted.push({
      value: p.path,
      label: p.path,
      tip: p.description ? `${p.path} — ${p.description}` : '',
    });
  }
  return wanted;
}

function fillPortOptions(sel: HTMLSelectElement, current: string): void {
  // Rebuilding the options while the native popup is open SLAMS IT SHUT —
  // and the click-triggered refreshPorts reply lands exactly mid-pick. Skip
  // the DOM rewrite when the wanted list is already what's on screen.
  const wanted = portOptionList(current);
  const existing = Array.from(sel.options);
  const same =
    sel.value === current &&
    existing.length === wanted.length &&
    wanted.every(
      (w, i) =>
        existing[i].value === w.value &&
        existing[i].textContent === w.label &&
        existing[i].getAttribute('title') === w.tip,
    );
  if (same) {
    return;
  }
  sel.textContent = '';
  for (const w of wanted) {
    const o = document.createElement('option');
    o.value = w.value;
    o.textContent = w.label;
    if (w.tip) {
      o.title = w.tip;
    }
    sel.appendChild(o);
  }
  sel.value = current;
}

function rebuildPortOptions(s: PaneSession): void {
  const sel = s.dom.portSelect;
  if (!sel) {
    return;
  }
  fillPortOptions(sel, sel.value || s.title);
  sel.disabled = s.state === 'connecting';
}

// Ctrl+F finds in the focused pane; F3 / Shift+F3 walk the matches.
//
// These keys are SWALLOWED at this layer — not just preventDefault'd. VS
// Code injects a window-level keydown forwarder into every webview
// (handleInnerKeydown in webview/browser/pre: it preventDefaults
// isFindEvent(e) and STILL posts 'did-keydown' to the workbench, where the
// keybinding re-opens the last editor's find widget and steals focus). Our
// listener runs first (document bubble < window bubble), so
// stopImmediatePropagation cuts the forward off before the injected script
// ever sees the key.
function swallowHostKey(e: KeyboardEvent): void {
  e.preventDefault();
  e.stopImmediatePropagation();
}
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
    swallowHostKey(e);
    const f = focusedSession();
    if (f) {
      openFind(f);
    }
    return;
  }
  if (e.key === 'F3') {
    swallowHostKey(e);
    const f = focusedSession();
    if (f && f.find.open) {
      navigateFind(f, e.shiftKey ? -1 : 1);
    }
  }
});

// Filtering is display-layer only (ADR-0004): switching modes recomputes
// visibility for every pane and never changes Follow/locked state.
function setFilterMode(s: PaneSession | undefined, mode: FilterMode): void {
  if (!s) {
    return; // the empty row's funnel has no pane to filter
  }
  s.filterMode = mode;
  restylePane(s);
  refreshPaneControls(s); // the pane's own funnel shows the new mode
}

function renderFilterMenu(filterMenu: HTMLDivElement, owner: PaneSession | undefined): void {
  filterMenu.textContent = '';
  const options: { mode: FilterMode; label: string; hint: string }[] = [
    { mode: 'off', label: 'Off', hint: 'Show every line' },
    { mode: 'include', label: 'Include', hint: 'Show only lines matching a filter tag' },
    { mode: 'exclude', label: 'Exclude', hint: 'Hide lines matching a filter tag' },
  ];
  for (const o of options) {
    const item = document.createElement('button');
    item.type = 'button';
    const current = owner?.filterMode ?? 'off';
    item.className = 'menu-item' + (o.mode === current ? ' current' : '');
    item.textContent = (o.mode === current ? '\u2714\uFE0E ' : '') + o.label;
    item.title = o.hint;
    item.addEventListener('click', () => {
      filterMenu.style.display = 'none';
      setFilterMode(owner, o.mode);
    });
    filterMenu.appendChild(item);
  }
}

document.addEventListener('selectionchange', updateTagButton);
window.addEventListener('resize', () => {
  for (const s of sessions) {
    s.marksDirty = true;
    scheduleRender(s);
  }
});

// Click-away: close any open menu whose toggle was not the click target
// (menus now exist per pane).
document.addEventListener('click', (e) => {
  const target = e.target as Node;
  for (const menu of Array.from(document.querySelectorAll<HTMLDivElement>('.menu'))) {
    const open = menu.style.display === 'block' || menu.classList.contains('visible');
    if (open) {
      const wrap = menu.parentElement;
      if (!wrap || !wrap.contains(target)) {
        menu.style.display = 'none';
        menu.classList.remove('visible');
      }
    }
  }
});

// --- Init ----------------------------------------------------------------------

managePanel = document.createElement('div');
managePanel.id = 'manage-panel';
document.body.insertBefore(managePanel, panesArea);
ensureEmptySurface();
renderTimestampsControl();
updateTagButton();
post({ type: 'ready' });
