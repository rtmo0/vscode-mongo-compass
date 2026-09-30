import * as vscode from 'vscode';
import { EJSON, type Document } from 'bson';
import { BaseWebviewPanel } from './baseWebview';
import { DataService, Namespace } from '../core/dataService';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryHistoryStore } from '../core/queryHistory';
import type { MyQueriesStore } from '../core/myQueries';
import { parseShellBSON, parsePipeline } from '../core/bsonParser';
import { getConfig } from '../core/config';
import { logger } from '../core/logger';
import type { ViewKind } from '../core/types';

export interface DataPanelContext {
  connectionId: string;
  database?: string;
  collection?: string;
  /** Extra payload depending on kind (e.g. explain result, initial query). */
  extra?: Record<string, unknown>;
}

/**
 * A single flexible panel that renders many Compass "tabs":
 * Indexes, Schema, Validation, Explain, Stats, Server Status,
 * Query History, My Queries and Current Operations.
 *
 * The webview (`dataview`) switches its rendering based on `kind`.
 */
export class DataPanel extends BaseWebviewPanel {
  protected get panelKey(): string {
    const ns = this.context.collection
      ? `${this.context.database}.${this.context.collection}`
      : this.context.database ?? '';
    return `dataview:${this.kind}:${this.context.connectionId}:${ns}`;
  }

  protected get title(): string {
    return this.customTitle ?? defaultTitle(this.kind);
  }

  protected get webviewName(): string {
    return 'dataview';
  }

  private customTitle?: string;

  static open(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    history: QueryHistoryStore,
    myQueries: MyQueriesStore,
    kind: ViewKind,
    context: DataPanelContext,
    title?: string,
    viewColumn = vscode.ViewColumn.Active
  ): DataPanel {
    return new DataPanel(
      extensionUri,
      connectionManager,
      history,
      myQueries,
      kind,
      context,
      title,
      viewColumn
    );
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly history: QueryHistoryStore,
    private readonly myQueries: MyQueriesStore,
    private readonly kind: ViewKind,
    private readonly context: DataPanelContext,
    title: string | undefined,
    viewColumn: vscode.ViewColumn
  ) {
    super(extensionUri);
    this.customTitle = title;
    this.initializePanel(viewColumn);
    this.registerHandlers();
    void this.pushInitialData();
  }

  protected override onPanelReused(): void {
    void this.pushInitialData();
  }

  private async service(): Promise<DataService> {
    const connection = await this.connectionManager.requireClient(this.context.connectionId);
    return new DataService(connection.client, connection.options.id);
  }

  private namespace(): Namespace {
    if (!this.context.database || !this.context.collection) {
      throw new Error('This view requires a database and collection context');
    }
    return new Namespace(this.context.database, this.context.collection);
  }

  private async pushInitialData(): Promise<void> {
    try {
      const data = await this.loadData();
      this.post('init', {
        kind: this.kind,
        title: this.title,
        context: this.context,
        data
      });
    } catch (err) {
      this.post('init', {
        kind: this.kind,
        title: this.title,
        context: this.context,
        error: (err as Error).message
      });
    }
  }

  private async loadData(): Promise<unknown> {
    switch (this.kind) {
      case 'indexes':
        return this.loadIndexes();
      case 'schema':
        return this.loadSchema();
      case 'validation':
        return this.loadValidation();
      case 'explain':
        return this.context.extra?.explain ?? null;
      case 'stats':
        return this.loadStats();
      case 'serverStatus':
        return this.loadServerStatus();
      case 'performanceMetrics':
        return this.loadPerformanceSample();
      case 'databaseCommand':
        return {
          database: this.context.database,
          commandText: String(this.context.extra?.commandText ?? '{\n  ping: 1\n}'),
          result: null
        };
      case 'queryHistory':
        return { entries: this.history.all };
      case 'savedQueries':
        return { queries: this.myQueries.queries, pipelines: this.myQueries.pipelines };
      case 'currentOp':
        return this.loadCurrentOp();
      default:
        return null;
    }
  }

  private async loadIndexes(): Promise<unknown> {
    const service = await this.service();
    const ns = this.namespace();
    const [indexes, searchIndexes, indexStatsResult, collectionStats] = await Promise.all([
      service.listIndexes(ns),
      service.listSearchIndexes(ns),
      service.listIndexStats(ns),
      service.collectionStats(ns.database, ns.collection).catch(() => null)
    ]);
    return {
      namespace: ns.toString(),
      indexes,
      searchIndexes,
      indexStats: indexStatsResult.stats,
      indexStatsError: indexStatsResult.error,
      indexSizes: collectionStats?.indexSizes ?? {}
    };
  }

  private async loadSchema(query: Document = {}, sampleSize?: number): Promise<unknown> {
    const service = await this.service();
    const ns = this.namespace();
    return service.analyzeSchema(ns, query, sampleSize ?? getConfig().schemaSampleSize);
  }

  private async loadValidation(): Promise<unknown> {
    const service = await this.service();
    const ns = this.namespace();
    const info = await service.collectionInfo(ns.database, ns.collection);
    const options = info?.options ?? {};
    return {
      namespace: ns.toString(),
      validator: options.validator ?? null,
      validationLevel: options.validationLevel ?? 'strict',
      validationAction: options.validationAction ?? 'error'
    };
  }

  private async loadStats(): Promise<unknown> {
    const service = await this.service();
    if (this.context.collection && this.context.database) {
      const ns = this.namespace();
      const [collStats, count, indexes] = await Promise.all([
        service.collectionStats(ns.database, ns.collection).catch(() => null),
        service.countDocuments(ns).catch(() => null),
        service.listIndexes(ns).catch(() => [])
      ]);
      return { scope: 'collection', namespace: ns.toString(), collStats, count, indexes };
    }
    if (this.context.database) {
      const dbStats = await service.databaseStats(this.context.database);
      const databases = await service.listDatabases();
      const info = databases.find((d) => d.name === this.context.database);
      return { scope: 'database', database: this.context.database, dbStats, info };
    }
    throw new Error('No database context for stats');
  }

  private async loadServerStatus(): Promise<unknown> {
    const service = await this.service();
    const connection = this.connectionManager.get(this.context.connectionId);
    const [serverStatus, buildInfo] = await Promise.all([
      service.serverStatus().catch((err) => ({ error: (err as Error).message })),
      service.runCommand('admin', { buildInfo: 1 }).catch(() => ({}))
    ]);
    return {
      serverStatus,
      buildInfo,
      topology: connection?.topology,
      connectionName: connection?.options.name
    };
  }

  private async loadCurrentOp(): Promise<unknown> {
    const service = await this.service();
    const result = await service.currentOp(true).catch((err) => ({
      error: (err as Error).message,
      inprog: []
    }));
    return { inprog: (result.inprog ?? []) as Document[], error: result.error };
  }

  private async loadPerformanceSample(): Promise<unknown> {
    const service = await this.service();
    const connection = this.connectionManager.get(this.context.connectionId);
    const [serverStatus, currentOp, top] = await Promise.all([
      service.serverStatus(),
      service.currentOp(false).catch(() => ({ inprog: [] })),
      service.runCommand('admin', { top: 1 }).catch(() => ({ totals: {} }))
    ]);
    return {
      sampledAt: Date.now(),
      connectionName: connection?.options.name,
      serverStatus,
      currentOp: (currentOp.inprog ?? []) as Document[],
      top: (top.totals ?? {}) as Document
    };
  }

  private registerHandlers(): void {
    this.registerHandler('ready', (_msg, respond) => {
      void this.pushInitialData();
      respond({ ok: true });
    });

    this.registerHandler('refresh', async (_msg, respond) => {
      const data = await this.loadData();
      respond({ data });
    });

    this.registerHandler('performanceSample', async (_msg, respond) => {
      respond({ data: await this.loadPerformanceSample() });
    });

    // ── indexes ──
    this.registerHandler('createIndex', async (msg, respond) => {
      const payload = msg.payload as { keysText: string; optionsText: string };
      const keys = parseShellBSON(payload.keysText);
      const options = payload.optionsText.trim() ? parseShellBSON(payload.optionsText) : {};
      const service = await this.service();
      const name = await service.createIndex(this.namespace(), keys, options);
      respond({ name });
      this.post('refreshExplorer');
      await this.pushInitialData();
    });

    this.registerHandler('dropIndex', async (msg, respond) => {
      const payload = msg.payload as { name: string };
      const service = await this.service();
      await service.dropIndex(this.namespace(), payload.name);
      respond({ ok: true });
      this.post('refreshExplorer');
      await this.pushInitialData();
    });

    this.registerHandler('createSearchIndex', async (msg, respond) => {
      const payload = msg.payload as { definitionText: string };
      const definition = parseShellBSON(payload.definitionText);
      const service = await this.service();
      const name = await service.createSearchIndex(this.namespace(), definition);
      respond({ name });
      await this.pushInitialData();
    });

    this.registerHandler('dropSearchIndex', async (msg, respond) => {
      const payload = msg.payload as { name: string };
      const service = await this.service();
      await service.dropSearchIndex(this.namespace(), payload.name);
      respond({ ok: true });
      await this.pushInitialData();
    });

    // ── schema ──
    this.registerHandler('analyzeSchema', async (msg, respond) => {
      const payload = msg.payload as { queryText?: string; sampleSize?: number };
      const query = payload.queryText?.trim() ? parseShellBSON(payload.queryText) : {};
      const data = await this.loadSchema(query, payload.sampleSize);
      respond({ data });
    });

    // ── validation ──
    this.registerHandler('setValidation', async (msg, respond) => {
      const payload = msg.payload as {
        validatorText: string;
        validationLevel: string;
        validationAction: string;
      };
      const validator = payload.validatorText.trim()
        ? parseShellBSON(payload.validatorText)
        : null;
      const service = await this.service();
      await service.setValidation(
        this.namespace(),
        validator,
        payload.validationLevel,
        payload.validationAction
      );
      respond({ ok: true });
      await this.pushInitialData();
    });

    // ── current op ──
    this.registerHandler('killOp', async (msg, respond) => {
      const payload = msg.payload as { opId: number };
      const service = await this.service();
      await service.killOp(payload.opId);
      respond({ ok: true });
      await this.pushInitialData();
    });

    // ── history / saved queries ──
    this.registerHandler('clearHistory', (_msg, respond) => {
      this.history.clear();
      respond({ entries: this.history.all });
    });

    this.registerHandler('removeHistoryEntry', (msg, respond) => {
      const payload = msg.payload as { id: string };
      this.history.remove(payload.id);
      respond({ entries: this.history.all });
    });

    this.registerHandler('deleteSavedQuery', async (msg, respond) => {
      const payload = msg.payload as { id: string };
      await this.myQueries.deleteQuery(payload.id);
      respond({ queries: this.myQueries.queries, pipelines: this.myQueries.pipelines });
    });

    this.registerHandler('deleteSavedPipeline', async (msg, respond) => {
      const payload = msg.payload as { id: string };
      await this.myQueries.deletePipeline(payload.id);
      respond({ queries: this.myQueries.queries, pipelines: this.myQueries.pipelines });
    });

    this.registerHandler('openSavedQuery', async (msg, respond) => {
      const payload = msg.payload as { id: string };
      const query = this.myQueries.queries.find((q) => q.id === payload.id);
      if (!query) {
        throw new Error('Saved query not found');
      }
      await vscode.commands.executeCommand(
        'mongoCompass.openDocuments',
        query.connectionId ?? this.context.connectionId,
        query.database,
        query.collection,
        query.query
      );
      respond({ ok: true });
    });

    this.registerHandler('openSavedPipeline', async (msg, respond) => {
      const payload = msg.payload as { id: string };
      const pipeline = this.myQueries.pipelines.find((p) => p.id === payload.id);
      if (!pipeline) {
        throw new Error('Saved pipeline not found');
      }
      await vscode.commands.executeCommand(
        'mongoCompass.openAggregation',
        pipeline.connectionId ?? this.context.connectionId,
        pipeline.database,
        pipeline.collection,
        pipeline.pipelineText
      );
      respond({ ok: true });
    });

    this.registerHandler('openHistoryEntry', async (msg, respond) => {
      const payload = msg.payload as { id: string };
      const entry = this.history.all.find((e) => e.id === payload.id);
      if (!entry) {
        throw new Error('History entry not found');
      }
      if (entry.kind === 'aggregate' && entry.pipelineText) {
        await vscode.commands.executeCommand(
          'mongoCompass.openAggregation',
          entry.connectionId,
          entry.database,
          entry.collection,
          entry.pipelineText
        );
      } else {
        await vscode.commands.executeCommand(
          'mongoCompass.openDocuments',
          entry.connectionId,
          entry.database,
          entry.collection,
          entry.query
        );
      }
      respond({ ok: true });
    });

    this.registerHandler('runCommand', async (msg, respond) => {
      const payload = msg.payload as { database: string; commandText: string };
      const command = parseShellBSON(payload.commandText);
      const service = await this.service();
      const result = await service.runCommand(payload.database, command);
      respond({ result: EJSON.stringify(result, undefined, 2, { relaxed: false }) });
    });

    this.registerHandler('parsePipeline', (msg, respond) => {
      const payload = msg.payload as { text: string };
      try {
        const pipeline = parsePipeline(payload.text);
        respond({ ok: true, count: pipeline.length });
      } catch (err) {
        respond({ ok: false, error: (err as Error).message });
      }
    });
  }
}

function defaultTitle(kind: ViewKind): string {
  switch (kind) {
    case 'indexes':
      return 'Indexes';
    case 'schema':
      return 'Schema';
    case 'validation':
      return 'Validation';
    case 'explain':
      return 'Explain Plan';
    case 'stats':
      return 'Statistics';
    case 'serverStatus':
      return 'Server Status';
    case 'performanceMetrics':
      return 'Performance Metrics';
    case 'databaseCommand':
      return 'Database Command';
    case 'queryHistory':
      return 'Query History';
    case 'savedQueries':
      return 'My Queries';
    case 'currentOp':
      return 'Current Operations';
    default:
      return 'MongoDB';
  }
}

export { logger };
