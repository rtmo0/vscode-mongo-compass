import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { EJSON, type Document } from 'bson';
import { BaseWebviewPanel } from './baseWebview';
import { DataService, Namespace } from '../core/dataService';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryHistoryStore } from '../core/queryHistory';
import type { MyQueriesStore } from '../core/myQueries';
import { parseShellBSON, parseSort, parseNumberOption } from '../core/bsonParser';
import { getConfig } from '../core/config';
import { ImportExportService, type ExportFormat } from '../core/importExport';
import { logger } from '../core/logger';
import { convertFieldsToJsonSchema } from '../core/validationRules';
import { collectFieldPaths } from '../core/fieldPaths';
import type { QueryState } from '../core/types';

interface DocumentsPanelState {
  connectionId: string;
  namespace: Namespace;
  query: QueryState;
  viewMode: 'list' | 'table' | 'json';
}

/**
 * Documents tab — the equivalent of Compass' `compass-crud` plugin:
 * query bar (filter/project/sort/collation/skip/limit/maxTimeMS),
 * list/table/json views, pagination, insert/edit/delete/clone,
 * explain, export-to-language, save query.
 */
export class DocumentsPanel extends BaseWebviewPanel {
  protected get panelKey(): string {
    return `documents:${this.state.connectionId}:${this.state.namespace.toString()}`;
  }

  protected get title(): string {
    return `Documents — ${this.state.namespace.toString()}`;
  }

  protected get webviewName(): string {
    return 'documents';
  }

  private state: DocumentsPanelState;
  private abortController: AbortController | undefined;

  static open(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    history: QueryHistoryStore,
    myQueries: MyQueriesStore,
    connectionId: string,
    namespace: Namespace,
    initialQuery?: Partial<QueryState>,
    viewColumn = vscode.ViewColumn.Active
  ): DocumentsPanel {
    return new DocumentsPanel(
      extensionUri,
      connectionManager,
      history,
      myQueries,
      connectionId,
      namespace,
      initialQuery,
      viewColumn
    );
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly history: QueryHistoryStore,
    private readonly myQueries: MyQueriesStore,
    connectionId: string,
    namespace: Namespace,
    initialQuery: Partial<QueryState> | undefined,
    viewColumn: vscode.ViewColumn
  ) {
    super(extensionUri);

    const config = getConfig();
    this.state = {
      connectionId,
      namespace,
      viewMode: config.resultView,
      query: {
        filter: {},
        filterText: '',
        project: {},
        projectText: '',
        sort: {},
        sortText: '',
        collation: null,
        collationText: '',
        skip: 0,
        limit: config.defaultLimit,
        maxTimeMS: config.maxTimeMS,
        ...initialQuery
      }
    };

    this.initializePanel(viewColumn);
    this.registerHandlers();
    this.post('init', {
      namespace: namespace.toString(),
      database: namespace.database,
      collection: namespace.collection,
      connectionId,
      query: this.state.query,
      viewMode: this.state.viewMode,
      config: {
        defaultLimit: config.defaultLimit,
        maxTimeMS: config.maxTimeMS
      }
    });
  }

  protected override onPanelReused(): void {
    this.post('init', {
      namespace: this.state.namespace.toString(),
      database: this.state.namespace.database,
      collection: this.state.namespace.collection,
      connectionId: this.state.connectionId,
      query: this.state.query,
      viewMode: this.state.viewMode
    });
  }

  private async service(): Promise<DataService> {
    const connection = await this.connectionManager.requireClient(this.state.connectionId);
    return new DataService(connection.client, connection.options.id);
  }

  private registerHandlers(): void {
    this.registerHandler('ready', (_msg, respond) => {
      const config = getConfig();
      respond({
        namespace: this.state.namespace.toString(),
        query: this.state.query,
        viewMode: this.state.viewMode,
        config: {
          defaultLimit: config.defaultLimit,
          maxTimeMS: config.maxTimeMS
        }
      });
    });

    this.registerHandler('find', async (msg, respond) => {
      const payload = msg.payload as { query: QueryState };
      this.state.query = normalizeQuery(payload.query);
      await this.runFind(respond);
    });

    this.registerHandler('cancel', (_msg, respond) => {
      this.abortController?.abort();
      respond({ cancelled: true });
    });

    this.registerHandler('count', async (_msg, respond) => {
      const service = await this.service();
      const count = await service.countDocuments(this.state.namespace, this.state.query.filter);
      respond({ count });
    });

    this.registerHandler('insert', async (msg, respond) => {
      const payload = msg.payload as { documentText: string };
      const doc = parseInsertDocument(payload.documentText);
      const service = await this.service();
      let replacedDuplicateId = false;
      if (doc._id !== undefined) {
        const existing = await service.findOne(this.state.namespace, { _id: doc._id });
        if (existing) {
          delete doc._id;
          replacedDuplicateId = true;
        }
      }
      try {
        const insertedId = await service.insertOne(this.state.namespace, doc);
        respond({ insertedId, replacedDuplicateId });
      } catch (error) {
        throw new Error(mongoErrorMessage(error), { cause: error });
      }
    });

    this.registerHandler('copyDocument', async (msg, respond) => {
      const payload = msg.payload as { documentText: string };
      await vscode.env.clipboard.writeText(payload.documentText);
      respond({ ok: true });
    });

    this.registerHandler('bulkInsert', async (msg, respond) => {
      const payload = msg.payload as { documentsText: string };
      const parsed = parseShellBSON(payload.documentsText);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error('Documents must be a non-empty array.');
      }
      if (parsed.some((document) => document === null || typeof document !== 'object' || Array.isArray(document))) {
        throw new Error('Every item must be a document object.');
      }
      const service = await this.service();
      const inserted = await service.insertMany(this.state.namespace, parsed);
      respond({ inserted });
      this.post('refresh');
    });

    this.registerHandler('update', async (msg, respond) => {
      const payload = msg.payload as { filterText: string; documentText: string };
      const filter = parseShellBSON(payload.filterText);
      const replacement = parseShellBSON(payload.documentText);
      const service = await this.service();
      const result = await service.replaceOne(this.state.namespace, filter, replacement);
      respond(result);
      this.post('refresh');
    });

    this.registerHandler('bulkUpdate', async (msg, respond) => {
      const payload = msg.payload as { filterText: string; updateText: string };
      const filter = parseShellBSON(payload.filterText);
      const update = parseShellBSON(payload.updateText);
      const service = await this.service();
      const result = await service.updateMany(this.state.namespace, filter, update);
      respond(result);
      this.post('refresh');
    });

    this.registerHandler('bulkCount', async (msg, respond) => {
      const payload = msg.payload as { filterText: string };
      const filter = parseShellBSON(payload.filterText);
      const service = await this.service();
      const count = await service.countDocuments(this.state.namespace, filter);
      respond({ count });
    });

    this.registerHandler('bulkDelete', async (msg, respond) => {
      const payload = msg.payload as { filterText: string };
      const filter = parseShellBSON(payload.filterText);
      const service = await this.service();
      const deleted = await service.deleteMany(this.state.namespace, filter);
      respond({ deleted });
      this.post('refresh');
    });

    this.registerHandler('delete', async (msg, respond) => {
      const payload = msg.payload as { filterText: string; many?: boolean };
      const filter = parseShellBSON(payload.filterText);
      const service = await this.service();
      const deleted = payload.many
        ? await service.deleteMany(this.state.namespace, filter)
        : await service.deleteOne(this.state.namespace, filter);
      respond({ deleted });
      this.post('refresh');
    });

    this.registerHandler('clone', async (msg, respond) => {
      const payload = msg.payload as { filterText: string };
      const filter = parseShellBSON(payload.filterText);
      const service = await this.service();
      const doc = await service.findOne(this.state.namespace, filter);
      if (!doc) {
        throw new Error('Document not found');
      }
      const clone = { ...doc } as Document;
      delete clone._id;
      const insertedId = await service.insertOne(this.state.namespace, clone);
      respond({ insertedId });
      this.post('refresh');
    });

    this.registerHandler('explain', async (_msg, respond) => {
      const service = await this.service();
      const explain = await service.explainFind(this.state.namespace, this.state.query);
      this.history.add({
        connectionId: this.state.connectionId,
        connectionName: this.connectionName(),
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        kind: 'explain',
        text: EJSON.stringify(this.state.query.filter),
        query: this.state.query,
        status: 'success',
        elapsedMS: explain.elapsedMS
      });
      respond(explain);
    });

    this.registerHandler('saveQuery', async (msg, respond) => {
      const payload = msg.payload as { name: string };
      const saved = await this.myQueries.saveQuery({
        name: payload.name,
        connectionId: this.state.connectionId,
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        query: this.state.query
      });
      respond(saved);
      void vscode.window.showInformationMessage(`Query "${saved.name}" saved to My Queries.`);
    });

    this.registerHandler('setViewMode', (msg, respond) => {
      const payload = msg.payload as { mode: 'list' | 'table' | 'json' };
      this.state.viewMode = payload.mode;
      respond({ ok: true });
    });

    this.registerHandler('exportData', async (msg, respond) => {
      const { format } = msg.payload as { format: ExportFormat };
      const target = await vscode.window.showSaveDialog({
        title: `Export filtered documents from ${this.state.namespace.toString()}`,
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${this.state.namespace.collection}.${format}`)),
        filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: [format] }
      });
      if (!target) {
        respond({ cancelled: true });
        return;
      }

      const service = await this.service();
      const io = new ImportExportService(service);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting ${this.state.namespace.toString()}…`, cancellable: true },
        (progress, token) => io.exportCollection(
          this.state.namespace,
          target.fsPath,
          { format, filter: this.state.query.filter },
          (value) => progress.report({ message: `${value.processed} documents…` }),
          token
        )
      );
      respond(result);
      void vscode.window.showInformationMessage(`Exported ${result.exported} documents to ${result.file}.`);
    });

    this.registerHandler('exportToLanguage', async (msg, respond) => {
      const payload = msg.payload as { language: string };
      const { exportToLanguage } = await import('../core/exportToLanguage');
      const connection = this.connectionManager.get(this.state.connectionId);
      const code = exportToLanguage(payload.language as never, {
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        query: this.state.query,
        connectionString: connection?.options.connectionString
      });
      respond({ code });
    });

    this.registerHandler('copyShellSnippet', async (_msg, respond) => {
      const { exportToLanguage } = await import('../core/exportToLanguage');
      const code = exportToLanguage('shell', {
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        query: this.state.query
      });
      await vscode.env.clipboard.writeText(code);
      respond({ ok: true });
    });

    this.registerHandler('openAggregation', async (_msg, respond) => {
      await vscode.commands.executeCommand(
        'mongoCompass.openAggregation',
        this.state.connectionId,
        this.state.namespace.database,
        this.state.namespace.collection
      );
      respond({ ok: true });
    });

    this.registerHandler('indexes', async (_msg, respond) => {
      const service = await this.service();
      const [indexes, indexStatsResult, collectionStats] = await Promise.all([
        service.listIndexes(this.state.namespace),
        service.listIndexStats(this.state.namespace),
        service.collectionStats(
          this.state.namespace.database,
          this.state.namespace.collection
        ).catch(() => null)
      ]);
      respond({
        indexes,
        indexStats: indexStatsResult.stats,
        indexStatsError: indexStatsResult.error,
        indexSizes: collectionStats?.indexSizes ?? {}
      });
    });

    this.registerHandler('createIndex', async (msg, respond) => {
      const payload = msg.payload as { keys: Document; options: Document };
      const service = await this.service();
      const name = await service.createIndex(this.state.namespace, payload.keys, payload.options);
      respond({ name });
      await vscode.commands.executeCommand('mongoCompass.refreshExplorer');
    });

    this.registerHandler('dropIndex', async (msg, respond) => {
      const payload = msg.payload as { name: string };
      const service = await this.service();
      const result = await service.dropIndex(this.state.namespace, payload.name);
      respond(result);
      await vscode.commands.executeCommand('mongoCompass.refreshExplorer');
    });

    this.registerHandler('schemaFields', async (_msg, respond) => {
      const service = await this.service();
      const sample = await service
        .collection(this.state.namespace)
        .find({}, { limit: 100 })
        .toArray();
      respond(collectFieldPaths(sample));
    });

    // ── schema ──
    this.registerHandler('analyzeSchema', async (msg, respond) => {
      const payload = msg.payload as { queryText?: string; sampleSize?: number };
      const query = payload.queryText?.trim() ? parseShellBSON(payload.queryText) : {};
      const service = await this.service();
      const data = await service.analyzeSchema(
        this.state.namespace,
        query,
        payload.sampleSize ?? getConfig().schemaSampleSize
      );
      respond({ data });
    });

    // ── validation rule generation (Compass-style) ──
    this.registerHandler('generateValidation', async (msg, respond) => {
      const payload = msg.payload as { sampleSize?: number };
      const service = await this.service();
      const analysis = await service.analyzeSchema(
        this.state.namespace,
        {},
        payload.sampleSize ?? getConfig().schemaSampleSize
      );
      const jsonSchema = convertFieldsToJsonSchema(analysis.fields);
      respond({
        validator: { $jsonSchema: jsonSchema },
        validationLevel: 'moderate',
        validationAction: 'error',
        sampledDocuments: analysis.sampledDocuments,
        totalDocuments: analysis.totalDocuments
      });
    });

    // ── validation ──
    this.registerHandler('getValidation', async (_msg, respond) => {
      const service = await this.service();
      const info = await service.collectionInfo(this.state.namespace.database, this.state.namespace.collection);
      const options = info?.options ?? {};
      respond({
        data: {
          namespace: this.state.namespace.toString(),
          validator: options.validator ?? null,
          validationLevel: options.validationLevel ?? 'strict',
          validationAction: options.validationAction ?? 'error'
        }
      });
    });

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
        this.state.namespace,
        validator,
        payload.validationLevel,
        payload.validationAction
      );
      respond({ ok: true });
    });
  }

  private connectionName(): string {
    return (
      this.connectionManager.get(this.state.connectionId)?.options.name ??
      this.state.connectionId
    );
  }

  private async runFind(respond: (payload: unknown) => void): Promise<void> {
    const started = Date.now();
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;

    try {
      logger.info('Documents query received', {
        ns: this.state.namespace.toString(),
        limit: this.state.query.limit,
        skip: this.state.query.skip,
        maxTimeMS: this.state.query.maxTimeMS
      });
      const service = await this.service();
      const result = await service.find(this.state.namespace, this.state.query, {
        maxTimeMS: this.state.query.maxTimeMS,
        signal: controller.signal
      });

      this.history.add({
        connectionId: this.state.connectionId,
        connectionName: this.connectionName(),
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        kind: 'find',
        text: EJSON.stringify(this.state.query.filter),
        query: this.state.query,
        status: 'success',
        count: result.count,
        elapsedMS: Date.now() - started
      });

      const documents = serialiseDocuments(result.documents);
      logger.info('Documents response ready', {
        ns: this.state.namespace.toString(),
        documents: documents.length,
        bytes: documents.reduce((total, document) => total + document.length, 0)
      });
      respond({
        documents,
        count: result.count,
        totalCount: result.totalCount,
        elapsedMS: result.elapsedMS,
        query: this.state.query
      });
    } catch (err) {
      let error = err as Error;
      if (controller.signal.aborted) {
        logger.warn('Query aborted', { ns: this.state.namespace.toString() });
        respond({ documents: [], count: null, totalCount: null, elapsedMS: 0, aborted: true });
        return;
      }
      if (error.name === 'MongoOperationTimeoutError') {
        error = new Error(
          `Query exceeded Max Time MS (${this.state.query.maxTimeMS} ms). Narrow the filter or raise the limit in Options.`
        );
      }
      this.history.add({
        connectionId: this.state.connectionId,
        connectionName: this.connectionName(),
        database: this.state.namespace.database,
        collection: this.state.namespace.collection,
        kind: 'find',
        text: EJSON.stringify(this.state.query.filter),
        query: this.state.query,
        status: 'error',
        error: error.message,
        elapsedMS: Date.now() - started
      });
      throw error;
    }
  }
}

function normalizeQuery(query: QueryState): QueryState {
  const config = getConfig();
  const filterText = query.filterText?.trim() ?? '';
  const projectText = query.projectText?.trim() ?? '';
  const sortText = query.sortText?.trim() ?? '';
  const collationText = query.collationText?.trim() ?? '';
  return {
    // An empty filter box means "match everything", never the previous filter.
    filter: filterText ? parseShellBSON(filterText) : {},
    filterText,
    project: projectText ? parseShellBSON(projectText) : {},
    projectText,
    sort: sortText ? parseSort(sortText) : {},
    sortText,
    collation: collationText ? parseShellBSON(collationText) : null,
    collationText,
    skip: parseNumberOption(query.skip, 0),
    limit: parseNumberOption(query.limit, config.defaultLimit),
    maxTimeMS: parseNumberOption(query.maxTimeMS, config.maxTimeMS)
  };
}

function parseInsertDocument(text: string): Document {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('Document JSON is required.');
  }

  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Document JSON must contain one object.');
  }

  normalizeObjectIds(json);
  try {
    return EJSON.deserialize(json as Document, { relaxed: false });
  } catch (err) {
    throw new Error(`Invalid Extended JSON: ${(err as Error).message}`);
  }
}

function normalizeObjectIds(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(normalizeObjectIds);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  const object = value as Record<string, unknown>;
  if (typeof object.$oid === 'string') {
    object.$oid = object.$oid.trim();
  }
  Object.values(object).forEach(normalizeObjectIds);
}

function mongoErrorMessage(error: unknown): string {
  const err = error as Error & {
    code?: number;
    codeName?: string;
    errorResponse?: { errmsg?: string; code?: number; codeName?: string };
    cause?: { message?: string };
  };
  const response = err.errorResponse;
  const message = response?.errmsg ?? err.cause?.message ?? err.message ?? String(error);
  const code = response?.code ?? err.code;
  const codeName = response?.codeName ?? err.codeName;
  const details = [code !== undefined ? `code ${code}` : '', codeName ?? ''].filter(Boolean).join(', ');
  return details ? `${message} (${details})` : message;
}

function serialiseDocuments(documents: Document[]): string[] {
  return documents.map((doc) =>
    EJSON.stringify(doc, undefined, 2, { relaxed: false })
  );
}

export type { DocumentsPanelState };
