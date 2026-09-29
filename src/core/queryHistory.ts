import * as vscode from 'vscode';
import type { HistoryEntry } from './types';
import { getConfig } from './config';

const HISTORY_KEY = 'mongoCompass.queryHistory';

/** Ring-buffer of recently executed queries/aggregations (Compass "Query History"). */
export class QueryHistoryStore {
  private entries: HistoryEntry[] = [];
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.entries = this.context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  }

  get all(): HistoryEntry[] {
    return this.entries;
  }

  add(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): void {
    const full: HistoryEntry = {
      ...entry,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now()
    };
    this.entries.unshift(full);
    const limit = getConfig().queryHistoryLimit;
    if (this.entries.length > limit) {
      this.entries = this.entries.slice(0, limit);
    }
    void this.context.globalState.update(HISTORY_KEY, this.entries);
    this._onDidChange.fire();
  }

  clear(): void {
    this.entries = [];
    void this.context.globalState.update(HISTORY_KEY, []);
    this._onDidChange.fire();
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    void this.context.globalState.update(HISTORY_KEY, this.entries);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
