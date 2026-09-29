import * as vscode from 'vscode';
import type { SavedPipeline, SavedQuery } from './types';

const PIPELINES_KEY = 'mongoCompass.savedPipelines';
const QUERIES_KEY = 'mongoCompass.savedQueries';

/**
 * "My Queries" storage — saved aggregations and favorite queries,
 * the equivalent of Compass' `@mongodb-js/my-queries-storage`.
 */
export class MyQueriesStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  // ── pipelines ──

  get pipelines(): SavedPipeline[] {
    return this.context.globalState.get<SavedPipeline[]>(PIPELINES_KEY, []);
  }

  async savePipeline(pipeline: Omit<SavedPipeline, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SavedPipeline> {
    const all = this.pipelines;
    const now = Date.now();
    let saved: SavedPipeline;
    if (pipeline.id) {
      const existing = all.find((p) => p.id === pipeline.id);
      saved = {
        ...(existing ?? ({} as SavedPipeline)),
        ...pipeline,
        id: pipeline.id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      } as SavedPipeline;
      const index = all.findIndex((p) => p.id === pipeline.id);
      if (index >= 0) {
        all[index] = saved;
      } else {
        all.push(saved);
      }
    } else {
      saved = {
        ...pipeline,
        id: `pipeline-${now}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        updatedAt: now
      } as SavedPipeline;
      all.push(saved);
    }
    await this.context.globalState.update(PIPELINES_KEY, all);
    this._onDidChange.fire();
    return saved;
  }

  async deletePipeline(id: string): Promise<void> {
    await this.context.globalState.update(
      PIPELINES_KEY,
      this.pipelines.filter((p) => p.id !== id)
    );
    this._onDidChange.fire();
  }

  // ── queries ──

  get queries(): SavedQuery[] {
    return this.context.globalState.get<SavedQuery[]>(QUERIES_KEY, []);
  }

  async saveQuery(query: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SavedQuery> {
    const all = this.queries;
    const now = Date.now();
    let saved: SavedQuery;
    if (query.id) {
      const existing = all.find((q) => q.id === query.id);
      saved = {
        ...(existing ?? ({} as SavedQuery)),
        ...query,
        id: query.id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      } as SavedQuery;
      const index = all.findIndex((q) => q.id === query.id);
      if (index >= 0) {
        all[index] = saved;
      } else {
        all.push(saved);
      }
    } else {
      saved = {
        ...query,
        id: `query-${now}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: now,
        updatedAt: now
      } as SavedQuery;
      all.push(saved);
    }
    await this.context.globalState.update(QUERIES_KEY, all);
    this._onDidChange.fire();
    return saved;
  }

  async deleteQuery(id: string): Promise<void> {
    await this.context.globalState.update(
      QUERIES_KEY,
      this.queries.filter((q) => q.id !== id)
    );
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
