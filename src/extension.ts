import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as vscode from 'vscode';

import {
  LineEnding as ApiLineEnding,
  MonitorPortSettings,
  Port,
  PortInformation,
  SerialMonitorApi,
  StopBits,
  Version,
} from './api/serialMonitorApi';
import { ControllerState, ControllerToWebview, MonitorController, TimedLine } from './host/monitorController';
import { NodeSerialPortBackend } from './host/nodeSerialPortBackend';
import { LineEnding, SerialPortSettings } from './host/serialPortAdapter';
import { PortTagStorage, PortTagStore } from './host/tagStore';
import { Tag } from './shared/tag';
import { formatLineText } from './shared/lineText';
import { HostToWebview, WebviewToHost } from './shared/protocol';
import { DEFAULT_BAUD_RATE } from './shared/baudPresets';
import { monitorPageHtml } from './webview/monitorPage';

const LINE_ENDINGS: readonly LineEnding[] = ['none', 'LF', 'CRLF', 'CR'];
/** The webview's select vocabulary (what `mkSelect` offers). */
const UI_LINE_ENDINGS: readonly string[] = ['LF', 'CRLF', 'CR', 'None'];

/** Coerces raw serial params to the settings the backend accepts, with the
 * same defaults everywhere. */
function sanitizeSerialParams(params: {
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: string;
}): Omit<SerialPortSettings, 'path'> {
  const dataBits = Number(params.dataBits);
  const stopBits = Number(params.stopBits);
  const parity = ['none', 'even', 'odd', 'mark', 'space'].includes(params.parity)
    ? (params.parity as SerialPortSettings['parity'])
    : 'none';
  return {
    baudRate: Number(params.baudRate) || DEFAULT_BAUD_RATE,
    dataBits: ([5, 6, 7, 8] as number[]).includes(dataBits) ? (dataBits as SerialPortSettings['dataBits']) : 8,
    stopBits: ([1, 1.5, 2] as number[]).includes(stopBits) ? (stopBits as SerialPortSettings['stopBits']) : 1,
    parity,
  };
}

function toSettings(msg: Extract<WebviewToHost, { type: 'connect' }>): SerialPortSettings {
  return { path: String(msg.port), ...sanitizeSerialParams(msg) };
}

function fileStamp(what: string): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${what.replace(/[^\w.-]/g, '_')}-${stamp}`;
}

function toLineEnding(value: string): LineEnding {
  // UI forms differ from host forms only in case ('None' vs 'none');
  // normalize instead of silently falling back to LF.
  const hit = (LINE_ENDINGS as readonly string[]).find(
    (e) => e.toLowerCase() === value.toLowerCase(),
  );
  return (hit as LineEnding | undefined) ?? 'LF';
}

/**
 * Reads a `serialLens.*` setting, falling back to its pre-rename
 * `serialMonitor.*` value: the extension was renamed (0.6.0) while sharing
 * that property namespace with the upstream extension id family, which made
 * VS Code's configuration registry reject one of the two declarations. New
 * settings live under `serialLens.*`; existing user settings migrate by
 * fallback until they are rewritten.
 */
function readLensSetting<T>(key: string, fallback: T): T {
  const lens = vscode.workspace.getConfiguration('serialLens').get<T>(key);
  if (lens !== undefined) {
    return lens;
  }
  return vscode.workspace.getConfiguration('serialMonitor').get<T>(key, fallback) ?? fallback;
}

function readCap(): number {
  return readLensSetting('maxBufferLines', 10000);
}

function readTimestamps(): boolean {
  return readLensSetting('timestamps', true);
}

function readLogDirectory(): string {
  return readLensSetting('logDirectory', '');
}

function readRecentBauds(): number[] {
  return readLensSetting('recentBaudRates', []);
}

/** One-time migration: the extension was renamed (0.6.0) while sharing the
 * `serialMonitor.*` property namespace, and the registry rejects a second
 * declaration of a live property — settings moved to `serialLens.*`. Legacy
 * values that differ from what the new key already holds are carried over
 * and the legacy twin is cleared, so both namespaces can never drift. */
const LEGACY_SETTING_KEYS = [
  'maxBufferLines',
  'recentBaudRates',
  'logDirectory',
  'timestamps',
  'portTags',
] as const;

function sameSetting(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function migrateLegacySettings(): void {
  const legacy = vscode.workspace.getConfiguration('serialMonitor');
  const lens = vscode.workspace.getConfiguration('serialLens');
  for (const key of LEGACY_SETTING_KEYS) {
    const old = legacy.get<unknown>(key);
    if (old === undefined) {
      continue; // nothing under the legacy key
    }
    const current = lens.get<unknown>(key);
    if (sameSetting(old, current)) {
      continue; // already carried over (or both at their default)
    }
    void lens.update(key, old, vscode.ConfigurationTarget.Global);
    void legacy.update(key, undefined, vscode.ConfigurationTarget.Global);
  }
}

export function activate(
  context: vscode.ExtensionContext,
): { getApi(version: Version, extensionContext: vscode.ExtensionContext): Promise<SerialMonitorApi | undefined> } {
  migrateLegacySettings();
  const provider = new MonitorViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MonitorViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('serialMonitor.open', () => {
      void vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    }),
    vscode.commands.registerCommand('serialMonitor.openLogFile', () => {
      void provider.openLogFileViaDialog();
    }),
  );

  return {
    getApi: (version: Version): Promise<SerialMonitorApi | undefined> => {
      // Version negotiation per the original contract: requesting a version
      // above what is supported yields undefined.
      if (version > Version.latest) {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(new MonitorApi(provider));
    },
  };
}

export function deactivate(): void {
  // Sessions (and their ports) are disposed with their view.
}

/** A live pane in the monitor: one monitored port, or one opened log file
 * shown read-only. Port sessions own their controller and log file. */
interface PortSession {
  kind: 'port';
  id: number;
  controller: MonitorController;
  /** The port this session was created for — the tag persistence key. It
   * survives disconnect (unlike controller.activePath), so edits made while
   * the pane is stopped still land under the right port (ADR-0006). */
  portPath: string;
  logDesired: boolean;
  sessionLogFile?: string;
  /** Set while a live param-edit reconnect is in flight: the idle hop must
   * not clear the log file, and the connected hop must not re-arm a dialog.
   * Cleared by an arriving disconnect — the stop request cancels the
   * pending reopen. */
  reconnecting?: boolean;
}

interface FileSession {
  kind: 'file';
  id: number;
}

type ProviderSession = PortSession | FileSession;

/**
 * The monitor docks in the bottom panel as a "SERIAL LENS" tab. Sessions
 * (monitored ports and opened log files) appear as panes in the webview;
 * the view keeps its state while hidden (retainContextWhenHidden) so
 * streaming output survives switches.
 * Exported for the host-layer unit suite (test/extensionProvider.test.ts).
 */
export class MonitorViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'serialMonitor.view';

  private view: vscode.WebviewView | undefined;
  private readonly sessions = new Map<number, ProviderSession>();
  private tagStore?: PortTagStore;
  private nextId = 1;

  /** All live port sessions, in id order. */
  private get portSessions(): PortSession[] {
    return [...this.sessions.values()].filter((s): s is PortSession => s.kind === 'port');
  }
  private post: (msg: HostToWebview) => void = () => undefined;
  private pendingExportId: number | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const mediaRoot = vscode.Uri.file(path.join(this.extensionUri.fsPath, 'dist', 'media'));
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = monitorPageHtml({
      scriptUri: view.webview
        .asWebviewUri(vscode.Uri.file(path.join(mediaRoot.fsPath, 'main.js')))
        .toString(),
      cspSource: view.webview.cspSource,
      // Shown in the ⚙ panel so a user can tell WHICH VSIX they are running
      // (field reports have twice been stale-VSIX artifacts).
      version: vscode.extensions.getExtension('simplehk.serial-lens')?.packageJSON
        .version as string | undefined,
    });
    view.title = 'Serial Lens';

    const post = (msg: HostToWebview) => {
      // The view may already be disposed when a late message arrives.
      void Promise.resolve(view.webview.postMessage(msg)).catch(() => undefined);
    };
    this.post = post;

    const tagStore = new PortTagStore(workspacePortTagStorage());
    this.tagStore = tagStore;
    const sendDisplayState = () => {
      post({ type: 'timestamps', enabled: readTimestamps() });
    };
    const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('serialLens.maxBufferLines') || e.affectsConfiguration('serialMonitor.maxBufferLines')) {
        for (const s of this.portSessions) {
          s.controller.setCap(readCap());
        }
      }
      if (e.affectsConfiguration('serialLens.timestamps') || e.affectsConfiguration('serialMonitor.timestamps')) {
        for (const s of this.portSessions) {
          s.controller.setTimestamps(readTimestamps());
        }
        sendDisplayState();
      }
      if (e.affectsConfiguration('serialLens.logDirectory') || e.affectsConfiguration('serialMonitor.logDirectory')) {
        for (const s of this.portSessions) {
          this.sendLoggingState(s);
        }
      }
    });

    view.webview.onDidReceiveMessage((msg: WebviewToHost) => {
      switch (msg.type) {
        case 'ready':
        case 'refreshPorts':
          void this.refreshPorts();
          if (msg.type === 'ready') {
            sendDisplayState();
            post({ type: 'recentBauds', values: readRecentBauds() });
          }
          break;
        case 'connect':
          void this.handleConnect(toSettings(msg), msg.lineEnding);
          break;
        case 'reconnect': {
          // A param edit on a connected pane: tear the connection down and
          // open it again with the new settings — same session, same pane,
          // same buffer.
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind !== 'port' || s.controller.state !== 'connected') {
            break;
          }
          const path = s.controller.activePath ?? '';
          const reconnectSettings: SerialPortSettings = { path, ...sanitizeSerialParams(msg.settings) };
          void (async () => {
            const keepFile = s.sessionLogFile;
            s.reconnecting = true;
            try {
              await s.controller.disconnect();
              // ■ pressed inside the window (the teardown's idle hop makes a
              // concurrent disconnect a no-op): the stop outranks the edit —
              // abandon the reopen instead of bringing the port back up.
              if (!s.reconnecting) {
                return;
              }
              if (keepFile) {
                s.sessionLogFile = keepFile;
              }
              await s.controller.connect(reconnectSettings);
              if (s.controller.state === 'connected') {
                void this.pushRecentBaud(reconnectSettings.baudRate);
              }
            } finally {
              s.reconnecting = false;
            }
          })();
          break;
        }
        case 'disconnect': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            s.reconnecting = false; // cancels an in-flight param-edit reconnect
            void s.controller.disconnect();
          }
          break;
        }
        case 'closeSession':
          void this.destroySession(msg.sessionId);
          break;
        case 'openLogFile':
          void this.openLogFileViaDialog();
          break;
        case 'clear': {
          if (msg.sessionId === undefined) {
            break; // the webview clears its own buffer; nothing to reset
          }
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            s.controller.resetBuffer();
          }
          break;
        }
        case 'send': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind === 'port') {
            void s.controller.sendText(String(msg.text), toLineEnding(msg.lineEnding));
          }
          break;
        }
        case 'setLogSession': {
          const s = this.sessions.get(msg.sessionId);
          if (s?.kind !== 'port') {
            break;
          }
          s.logDesired = Boolean(msg.enabled);
          if (s.controller.state === 'connected') {
            if (s.logDesired) {
              void this.armSessionLog(s, s.controller.activePath ?? 'port');
            } else {
              s.sessionLogFile = undefined;
            }
            this.sendLoggingState(s);
          }
          break;
        }
        case 'setTimestamps': {
          const enabled = Boolean(msg.enabled);
          for (const s of this.portSessions) {
            s.controller.setTimestamps(enabled);
          }
          // Persist through the setting so the config watcher syncs the
          // webview's display flag and the choice survives reloads.
          void updateLensSetting('timestamps', enabled);
          break;
        }
        case 'chooseLogDirectory':
          void this.chooseLogDirectory();
          break;
        case 'clearLogDirectory':
          void updateLensSetting('logDirectory', '');
          for (const s of this.portSessions) {
            s.sessionLogFile = undefined;
            this.sendLoggingState(s);
          }
          break;
        case 'export':
          // Pull the buffered lines from the webview; completeExport opens
          // the save dialog once they arrive.
          this.pendingExportId = msg.sessionId;
          post({ type: 'exportRequest', sessionId: msg.sessionId });
          break;
        case 'exportData':
          if (this.pendingExportId === msg.sessionId) {
            this.pendingExportId = undefined;
            void this.completeExport(msg.sessionId, msg.entries);
          }
          break;
        case 'saveTags': {
          // The webview owns its pane's list (ADR-0006); the host persists it
          // under the pane's port so the set survives close/reopen.
          const ts = this.sessions.get(msg.sessionId);
          if (ts?.kind !== 'port') {
            break;
          }
          void tagStore.save(ts.portPath, msg.tags);
          break;
        }
      }
    });

    view.onDidDispose(() => {
      configWatcher.dispose();
      for (const id of [...this.sessions.keys()]) {
        void this.destroySession(id);
      }
      this.view = undefined;
    });
  }

  // --- Session lifecycle -----------------------------------------------------

  private async refreshPorts(): Promise<void> {
    try {
      const ports = await new NodeSerialPortBackend().listPorts();
      this.post({ type: 'ports', ports });
    } catch (err) {
      this.postMessageStatus(`Failed to list serial ports: ${describe(err)}`);
    }
  }

  private createPortSession(portPath: string, settings: SerialPortSettings): PortSession {
    const id = this.nextId++;
    const controller = new MonitorController(
      new NodeSerialPortBackend(),
      (msg: ControllerToWebview) =>
        this.post({ ...msg, sessionId: id } as unknown as HostToWebview),
      {
        maxBufferLines: readCap(),
        timestamps: readTimestamps(),
        onBatch: (entries) => {
          const s = this.sessions.get(id);
          if (s?.kind === 'port') {
            this.logEntries(s, entries, readTimestamps());
          }
        },
      },
    );
    const session: PortSession = { kind: 'port', id, controller, portPath: settings.path, logDesired: Boolean(readLogDirectory()) };
    this.sessions.set(id, session);
    // Tags belong to the port (ADR-0006): the pane starts with this port's set.
    this.post({ type: 'tags', sessionId: id, tags: this.tagStore?.load(settings.path) ?? [] });
    // Per-session log lifecycle: a configured log directory means every new
    // session logs by default; each connection writes a fresh file.
    controller.onStateChange((s) => {
      this.updateTitle();
      if (s === 'connected') {
        if (session.reconnecting) {
          session.reconnecting = false; // live reconnect: keep logging to the same file
        } else if (session.logDesired) {
          void this.armSessionLog(session, controller.activePath ?? 'port');
        }
      } else if (s === 'idle') {
        if (!session.reconnecting) {
          session.sessionLogFile = undefined;
        }
        this.sendLoggingState(session);
      }
    });
    // The pane keeps its settings so it can restart independently of the
    // hardware row's current selection.
    this.post({
      type: 'sessionCreated',
      sessionId: id,
      kind: 'port',
      title: portPath,
      state: 'connecting',
      settings: {
        baudRate: settings.baudRate,
        dataBits: settings.dataBits,
        stopBits: settings.stopBits,
        parity: settings.parity,
      },
    });
    this.sendLoggingState(session);
    return session;
  }

  private async handleConnect(settings: SerialPortSettings, uiLineEnding?: string): Promise<void> {
    const session = this.createPortSession(settings.path, settings);
    await session.controller.connect(settings);
    if (session.controller.state === 'connected') {
      // A start-bar line-ending choice seeds the new session's send format
      // (the pane's own select stays authoritative afterwards).
      if (uiLineEnding && UI_LINE_ENDINGS.includes(uiLineEnding)) {
        this.post({ type: 'lineEnding', sessionId: session.id, value: uiLineEnding });
      }
      void this.pushRecentBaud(settings.baudRate);
      return;
    }
    // The teardown already reported why the open failed through the tagged
    // state message; remove the never-connected pane.
    this.post({ type: 'sessionFailed', sessionId: session.id, message: `Could not open ${settings.path}` });
    await this.destroySession(session.id);
  }

  /** Tears a session down: disconnects its port when live, then drops it.
   * The webview usually removed the pane already; sessionClosed is a no-op
   * for it then. */
  private async destroySession(id: number): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) {
      return;
    }
    this.sessions.delete(id);
    this.updateTitle();
    if (s.kind === 'port') {
      await s.controller.disconnect();
      await s.controller.dispose();
    }
    this.post({ type: 'sessionClosed', sessionId: id });
  }

  private updateTitle(): void {
    const view = this.view;
    if (!view) {
      return;
    }
    const live: string[] = this.portSessions
      .filter((s) => s.controller.state === 'connected' && s.controller.activePath)
      .map((s) => s.controller.activePath as string);
    view.title =
      live.length === 0
        ? 'Serial Lens'
        : live.length === 1
          ? `Serial Lens: ${live[0]}`
          : `Serial Lens (${live.length} ports)`;
  }

  // --- Open-a-log-file sessions ----------------------------------------------

  /** 📂 Picks a saved log/text file and shows it as a read-only pane. */
  async openLogFileViaDialog(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Open',
      title: 'Open a serial log file in a read-only pane',
      filters: { 'Log Files': ['log', 'txt'], 'All Files': ['*'] },
    });
    if (!picked?.length) {
      return; // user cancelled
    }
    await this.openLogFile(picked[0]);
  }

  async openLogFile(uri: vscode.Uri): Promise<void> {
    if (!this.view) {
      await vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    }
    let content: string;
    try {
      content = await fs.readFile(uri.fsPath, 'utf-8');
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not open ${path.basename(uri.fsPath)}: ${describe(err)}`);
      return;
    }
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === '') {
      lines.pop(); // trailing newline, not an empty record
    }
    // The buffer cap applies like a live stream: keep the newest lines.
    const cap = readCap();
    const dropCount = Math.max(0, lines.length - cap);
    const kept = dropCount > 0 ? lines.slice(-cap) : lines;

    const id = this.nextId++;
    this.sessions.set(id, { kind: 'file', id });
    this.post({
      type: 'sessionCreated',
      sessionId: id,
      kind: 'file',
      title: path.basename(uri.fsPath),
      state: 'idle',
    });
    for (let i = 0; i < kept.length; i += 2000) {
      this.post({ type: 'append', sessionId: id, lines: kept.slice(i, i + 2000), dropCount: i === 0 ? dropCount : 0 });
    }
  }

  // --- Public-API surface -----------------------------------------------------

  /** Starts monitoring through a new port session; resolves to a Port whose
   * onClosed fires when the connection drops for any reason. Several API
   * monitors may run side by side, mirroring the split view. */
  async startMonitoringPort(settings: MonitorPortSettings): Promise<Port> {
    await this.ensureView();
    const apiSettings = toApiSettings(settings);
    const session = this.createPortSession(settings.port, apiSettings);
    const closed = new vscode.EventEmitter<void>();
    const unsub = session.controller.onStateChange((s) => {
      if (s === 'idle') {
        unsub();
        closed.fire();
      }
    });
    await session.controller.connect(apiSettings);
    // Read through a cast: TypeScript's alias narrowing of the getter gets
    // this comparison wrong across the awaited connect() above.
    const stateAfterConnect = session.controller.state as ControllerState;
    if (stateAfterConnect !== 'connected') {
      unsub();
      closed.dispose();
      this.post({ type: 'sessionFailed', sessionId: session.id, message: `Could not open ${settings.port}` });
      await this.destroySession(session.id);
      throw new Error(`Failed to open ${settings.port}. See the monitor view for details.`);
    }
    this.post({ type: 'lineEnding', sessionId: session.id, value: apiLineEndingToUi(settings.lineEnding) });
    return {
      stopMonitoring: async () => {
        unsub();
        await session.controller.disconnect(); // the tab stays with its buffer
      },
      onClosed: closed.event,
    };
  }

  async stopMonitoringPort(portName: string): Promise<boolean> {
    const live = this.portSessions.find(
      (s) => s.controller.state === 'connected' && s.controller.activePath === portName,
    );
    if (live) {
      await live.controller.disconnect();
      return true;
    }
    return false;
  }

  clearMonitorOutput(): void {
    this.post({ type: 'clear' });
  }

  // --- Session logging --------------------------------------------------------

  private sendLoggingState(session: PortSession): void {
    this.post({
      type: 'logging',
      sessionId: session.id,
      active: session.sessionLogFile !== undefined,
      fileName: session.sessionLogFile ? path.basename(session.sessionLogFile) : undefined,
      directory: readLogDirectory() || undefined,
      desired: session.logDesired,
    });
  }

  /** Arms a session's log file: the configured directory if present,
   * otherwise a save dialog. Called on connect / mid-session toggle. */
  private async armSessionLog(session: PortSession, portPath: string): Promise<void> {
    const dir = readLogDirectory();
    if (dir) {
      session.sessionLogFile = path.join(dir, `serial-${fileStamp(portPath)}.log`);
      this.sendLoggingState(session);
      return;
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`serial-${fileStamp(portPath)}.log`),
      title: 'Save this session serial log to',
      filters: { 'Log Files': ['log'], 'Text Files': ['txt'] },
    });
    if (!target) {
      return; // user cancelled; session stays unlogged
    }
    session.sessionLogFile = target.fsPath;
    this.sendLoggingState(session);
  }

  private async pushRecentBaud(baudRate: number): Promise<void> {
    const next = [baudRate, ...readRecentBauds().filter((b) => b !== baudRate)].slice(0, 5);
    await updateLensSetting('recentBaudRates', next);
    this.post({ type: 'recentBauds', values: next });
  }

  /** 📁 Picks the directory every session logs into (right-click clears). */
  private async chooseLogDirectory(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Log here',
      title: 'Choose the directory for per-session serial logs',
    });
    if (!picked?.length) {
      return;
    }
    await updateLensSetting('logDirectory', picked[0].fsPath);
    for (const s of this.portSessions) {
      this.sendLoggingState(s);
    }
    this.postMessageStatus(`Log directory: ${picked[0].fsPath} — each session writes a new .log file`);
  }

  /** 📤 Exports a session's buffer: the webview hands us its lines, then we
   * ask where to put them. */
  private async completeExport(sessionId: number, entries: readonly { text: string; ts?: number }[]): Promise<void> {
    if (entries.length === 0) {
      this.postMessageStatus('Nothing to export.');
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const defaultUri = folder
      ? vscode.Uri.joinPath(folder, `serial-export-${fileStamp('export')}.log`)
      : vscode.Uri.file(`serial-export-${fileStamp('export')}.log`);
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      title: 'Export the buffered log to',
      filters: { 'Log Files': ['log'], 'Text Files': ['txt'] },
    });
    if (!target) {
      return; // user cancelled the dialog
    }
    const withTimestamps = readTimestamps();
    const text = entries
      .map((e) => formatLineText(e, withTimestamps))
      .join('\n') + '\n';
    try {
      await fs.writeFile(target.fsPath, text, 'utf-8');
      this.postMessageStatus(`Exported ${entries.length} lines to ${path.basename(target.fsPath)}`);
    } catch (err) {
      this.postMessageStatus(`Export failed: ${describe(err)}`);
    }
  }

  private logEntries(session: PortSession, entries: readonly TimedLine[], withTimestamps: boolean): void {
    const file = session.sessionLogFile;
    if (!file || entries.length === 0) {
      return;
    }
    const text = entries
      .map((e) => formatLineText(e, withTimestamps))
      .join('\n') + '\n';
    fs.appendFile(file, text, 'utf-8').catch((err: unknown) => {
      session.sessionLogFile = undefined;
      this.sendLoggingState(session);
      this.postMessageStatus(`Logging stopped: ${describe(err)}`);
    });
  }

  /** Status-line ping without a session (dialog results, export outcomes). */
  private postMessageStatus(message: string): void {
    this.post({ type: 'status', message });
  }

  private async ensureView(): Promise<void> {
    if (this.view) {
      return;
    }
    await vscode.commands.executeCommand(`${MonitorViewProvider.viewId}.focus`);
    const deadline = Date.now() + 5000;
    while (!this.view && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!this.view) {
      throw new Error('The serial monitor view did not initialize.');
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function workspacePortTagStorage(): PortTagStorage {
  const read = (): Record<string, Tag[]> | undefined =>
    vscode.workspace.getConfiguration('serialLens').get<Record<string, Tag[]>>('portTags') ??
    vscode.workspace.getConfiguration('serialMonitor').get<Record<string, Tag[]>>('portTags');
  return {
    get: read,
    update: async (map) => {
      await updateLensSetting('portTags', map);
    },
  };
}

/** Writes a serialLens setting, falling back to user scope when no folder
 * is open (workspace-scope updates need a folder). The pre-rename
 * `serialMonitor.*` twin is cleared at the same target so the legacy key
 * cannot drift from the migrated one. */
async function updateLensSetting(key: string, value: unknown): Promise<void> {
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration('serialLens').update(key, value, target);
  await vscode.workspace.getConfiguration('serialMonitor').update(key, undefined, target);
}

function toApiSettings(ms: MonitorPortSettings): SerialPortSettings {
  return {
    path: ms.port,
    baudRate: ms.baudRate,
    dataBits: ms.dataBits,
    stopBits: ms.stopBits === StopBits.Two ? 2 : ms.stopBits === StopBits.Onepointfive ? 1.5 : 1,
    parity: ms.parity,
  };
}

function apiLineEndingToUi(le: ApiLineEnding): string {
  switch (le) {
    case ApiLineEnding.LF:
      return 'LF';
    case ApiLineEnding.CRLF:
      return 'CRLF';
    case ApiLineEnding.CR:
      return 'CR';
    default:
      return 'none';
  }
}

/** The SerialMonitorApi implementation over the monitor view's sessions. */
class MonitorApi implements SerialMonitorApi {
  constructor(private readonly provider: MonitorViewProvider) {}

  async listAvailablePorts(): Promise<PortInformation[]> {
    const ports = await new NodeSerialPortBackend().listPorts();
    return ports.map((p) => ({ portName: p.path, friendlyName: p.description }));
  }

  startMonitoringPort(monitorSettings: MonitorPortSettings): Promise<Port> {
    return this.provider.startMonitoringPort(monitorSettings);
  }

  async stopMonitoringPort(portName: string): Promise<boolean> {
    return this.provider.stopMonitoringPort(portName);
  }

  startMonitoringTCPConnection(): Promise<Port> {
    // ADR-0002: TCP stays on the API surface but reports unsupported until it ships.
    return Promise.reject(
      new Error('TCP monitoring is not supported by this version of Serial Lens.'),
    );
  }

  async stopMonitoringTCPConnection(): Promise<boolean> {
    return false;
  }

  async clearOutput(): Promise<void> {
    this.provider.clearMonitorOutput();
  }

  dispose(): void {}
}
