/**
 * A minimal `vscode` module mock for unit-testing the extension host layer
 * (MonitorViewProvider) without launching VS Code. Built as a real module
 * (not a vi.mock factory closure) so tests can import and adjust the mocks
 * between cases: `setConfig`, `setSaveDialog`, `setOpenDialog`.
 */
import { vi } from 'vitest';

export type ConfigListener = (event: { affectsConfiguration: (key: string) => boolean }) => void;

const configValues: Record<string, unknown> = {
  'serialLens.maxBufferLines': 10000,
  'serialLens.timestamps': true,
  'serialLens.logDirectory': '',
  'serialLens.recentBaudRates': [],
  'serialMonitor.tags': undefined,
};
const configUpdates: { key: string; value: unknown }[] = [];
const configListeners: ConfigListener[] = [];

export function setConfig(key: string, value: unknown): void {
  configValues[key] = value;
}
export function getConfigUpdates(): { key: string; value: unknown }[] {
  return [...configUpdates];
}
/** Fires the provider's onDidChangeConfiguration subscription. */
export function fireConfigChange(key: string): void {
  for (const cb of configListeners) {
    cb({ affectsConfiguration: (k) => k === key });
  }
}

export const dialogs = {
  save: vi.fn(() => undefined as { fsPath: string } | undefined),
  open: vi.fn(() => undefined as { fsPath: string }[] | undefined),
};

export const commands = { execute: vi.fn() };

export const vscode = {
  Uri: {
    file: (fsPath: string) => ({ fsPath, toString: () => fsPath }),
    joinPath: (base: { fsPath: string }, ...parts: string[]) => ({
      fsPath: [base.fsPath, ...parts].join('/'),
      toString: () => [base.fsPath, ...parts].join('/'),
    }),
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  EventEmitter: class {
    private listeners: ((value: unknown) => void)[] = [];
    event = (cb: (value: unknown) => void) => {
      this.listeners.push(cb);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== cb);
      };
    };
    fire = (value: unknown) => {
      for (const l of [...this.listeners]) l(value);
    };
    dispose = () => undefined;
  },
  workspace: {
    getConfiguration: (section: string) => ({
      get: (key: string, fallback?: unknown) => {
        const v = configValues[`${section}.${key}`];
        return v === undefined ? fallback : v;
      },
      update: async (key: string, value: unknown) => {
        configValues[`${section}.${key}`] = value;
        configUpdates.push({ key: `${section}.${key}`, value });
      },
    }),
    onDidChangeConfiguration: (cb: ConfigListener) => {
      configListeners.push(cb);
      return { dispose: () => void configListeners.splice(configListeners.indexOf(cb), 1) };
    },
    workspaceFolders: [],
  },
  extensions: {
    getExtension: (id: string) =>
      id === 'simplehk.serial-lens'
        ? { packageJSON: { version: '0.0.0-mock' } }
        : undefined,
  },
  window: {
    showSaveDialog: dialogs.save,
    showOpenDialog: dialogs.open,
    showErrorMessage: vi.fn(),
    registerWebviewViewProvider: vi.fn(),
  },
  commands: {
    executeCommand: commands.execute,
  },
};

/** The 'vscode'-shaped module export. */
export const vscodeMock = vscode;

export function resetVscodeMock(): void {
  configUpdates.length = 0;
  // configListeners survive: the provider registers its watcher once at
  // resolveWebviewView and must keep receiving changes.
  for (const key of Object.keys(configValues)) {
    delete configValues[key];
  }
  configValues['serialLens.maxBufferLines'] = 10000;
  configValues['serialLens.timestamps'] = true;
  configValues['serialLens.logDirectory'] = '';
  configValues['serialLens.recentBaudRates'] = [];
  configValues['serialMonitor.tags'] = undefined;
  dialogs.save.mockReset();
  dialogs.open.mockReset();
  dialogs.save.mockReturnValue(undefined);
  dialogs.open.mockReturnValue(undefined);
  commands.execute.mockReset();
}
