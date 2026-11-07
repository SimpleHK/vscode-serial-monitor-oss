import { FilterMode, Tag } from '../shared/tag';
import { LineDecision } from '../shared/tagMatching';
import { ScrollState } from '../shared/scrollState';
import { SerialParams } from '../shared/protocol';
import { FindOccurrence } from './findCore';
import { DEFAULT_BAUD_RATE } from '../shared/baudPresets';

/** Per-pane serial settings: captured at creation, edited through the pane's
 * own controls, and used verbatim when the pane (re)starts. */
export type PortSettings = SerialParams;

export const DEFAULT_PORT_SETTINGS: PortSettings = {
  baudRate: DEFAULT_BAUD_RATE,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

export interface PaneDom {
  root: HTMLDivElement;
  bar: HTMLDivElement;
  dot: HTMLSpanElement;
  title: HTMLSpanElement;
  play?: HTMLButtonElement;
  sendToggle?: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  logBtn?: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  scrollBtn: HTMLButtonElement;
  findBtn: HTMLButtonElement;
  close: HTMLSpanElement;
  portSelect?: HTMLSelectElement;
  baudInput?: HTMLInputElement;
  dbSel?: HTMLSelectElement;
  paritySel?: HTMLSelectElement;
  sbSel?: HTMLSelectElement;
  leSel?: HTMLSelectElement;
  log: HTMLDivElement;
  marks: HTMLDivElement;
  findMarks: HTMLDivElement;
  findBar: HTMLDivElement;
  findInput: HTMLInputElement;
  findCase: HTMLButtonElement;
  findWord: HTMLButtonElement;
  findRegex: HTMLButtonElement;
  findCount: HTMLSpanElement;
  findPrev: HTMLButtonElement;
  findNext: HTMLButtonElement;
  findClose: HTMLButtonElement;
  sendRow: HTMLDivElement;
  sendInput: HTMLInputElement;
  sendBtn: HTMLButtonElement;
  hint: HTMLDivElement;
  /** Tag chips row, doubled per pane; hidden while there are no tags. */
  tags: HTMLDivElement;
  /** This pane's own copy of the global controls and its status readout. */
  globalSeg: HTMLDivElement;
  status: HTMLSpanElement;
  ctlRefs: {
    tagBtn: HTMLButtonElement;
    filterToggleBtn: HTMLButtonElement;
    timestampsBtn: HTMLButtonElement;
    logDirBtn: HTMLButtonElement;
  };
  /** Per-pane virtualization spacers. They MUST NOT be shared: replaceChildren
   * moves nodes, so a module-level pair would be stolen by whichever pane
   * rendered last, collapsing the other pane's scrollable height. */
  spacerTop: HTMLDivElement;
  spacerBottom: HTMLDivElement;
}

export interface FindState {
  open: boolean;
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  error: boolean;
  occurrences: FindOccurrence[];
  current: number;
  byLine: Map<number, FindOccurrence[]>;
  debounce: number | undefined;
}

export interface PaneSession {
  id: number;
  kind: 'port' | 'file';
  title: string;
  state: 'idle' | 'connecting' | 'connected';
  message?: string;
  settings?: PortSettings;
  lineEnding: string;
  sendCollapsed: boolean;
  lineStore: { text: string; ts?: number }[];
  decisions: LineDecision[];
  visibleIndexes: number[];
  scroll: ScrollState;
  logDesired: boolean;
  logFile?: string;
  logDirectory?: string;
  find: FindState;
  /** Transient status text (export results etc.): shown for a few seconds,
   * then the iconized state returns. */
  transientMessage?: string;
  transientUntil?: number;
  transientTimer?: number;
  dom: PaneDom;
  lastRender?: { topPx: number; bottomPx: number; rows: RenderedRow[] };
  marksDirty: boolean;
  /** Last overview-strip paint time: the strip repaints at most every
   * MARKS_MIN_INTERVAL ms while a stream floods in (its content is O(all
   * visible rows); a ruler 200 ms stale is invisible, a repaint per append
   * is not). */
  marksPaintedAt?: number;
  /** Smooth-follow catch-up animation (rAF handle), running while the
   * viewport eases toward the bottom in follow mode. */
  followAnim?: number;
  /** True while followTo writes scrollTop — the scroll handler must not
   * feed the animation's own writes into the Follow→locked reducer. */
  programmatic?: boolean;
  dividerLeft?: HTMLDivElement;
  sendHistory: string[];
  sendIndex: number;
  sendDraft: string;
  /** This pane's own tags (ADR-0006) — created here, applied here, saved
   * here; other panes are never touched. */
  tags: Tag[];
  /** This pane's own display-layer filter mode over its tags. */
  filterMode: FilterMode;
  /** The empty state renders as a pane-shaped Session (C1/C2): same bar
   * builder, same refresh path, same replace flow. id -1 never reaches the
   * host; the surface is destroyed and rebuilt as panes come and go. */
  isEmpty?: boolean;
}

export interface PaneActionButtons {
  sendToggle: HTMLButtonElement;
  clearBtn: HTMLButtonElement;
  logBtn: HTMLButtonElement;
  exportBtn: HTMLButtonElement;
  scrollBtn: HTMLButtonElement;
  findBtn: HTMLButtonElement;
  close: HTMLButtonElement;
}

export interface RenderedRow {
  lineIndex: number;
  text: string;
  bg: string;
  bgImage: string;
  textIndent: string;
}
