import { sanitizeTags } from '../shared/tagList';
import { Tag } from '../shared/tag';

/**
 * Persistence boundary so the store stays vscode-free and testable. The
 * production adapter maps this onto workspace settings
 * (`serialLens.portTags` — a per-port map, ADR-0006; falls back to the pre-rename `serialMonitor.portTags` for existing users).
 */
export interface PortTagStorage {
  get(): Record<string, Tag[]> | undefined;
  update(map: Record<string, Tag[]>): Promise<void>;
}

/**
 * Owns per-port tag persistence (ADR-0006): tags belong to the pane that
 * created them, and each port's set survives close/reopen. The webview owns
 * the list mutations through shared/tagList; this store only sanitizes and
 * persists the map, keyed by port path.
 */
export class PortTagStore {
  private map: Record<string, Tag[]>;

  constructor(private readonly storage: PortTagStorage) {
    this.map = storage.get() ?? {};
  }

  load(path: string): Tag[] {
    return sanitizeTags(this.map[path] ?? []);
  }

  async save(path: string, raw: Tag[]): Promise<void> {
    if (!path) {
      return;
    }
    const tags = sanitizeTags(raw);
    if (tags.length === 0) {
      const { [path]: _dropped, ...rest } = this.map;
      this.map = rest;
    } else {
      this.map = { ...this.map, [path]: tags };
    }
    await this.storage.update(this.map);
  }
}
