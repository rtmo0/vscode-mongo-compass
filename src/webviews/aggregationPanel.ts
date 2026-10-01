import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { EJSON, type Document } from 'bson';
import { BaseWebviewPanel } from './baseWebview';
import { DataService, Namespace } from '../core/dataService';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryHistoryStore } from '../core/queryHistory';
import type { MyQueriesStore } from '../core/myQueries';
import { parseStage, parsePipeline } from '../core/bsonParser';
import { getConfig } from '../core/config';
import { ImportExportService, type ExportFormat } from '../core/importExport';
import { logger } from '../core/logger';
import type { AggregationStage } from '../core/types';

interface PipelinePayload {
  pipelineText: string;
}

interface StagePayload {
  id: string;
  text: string;
  enabled: boolean;
}

const AGGREGATION_PREVIEW_LIMIT = 10;

/**
 * Aggregation Pipeline Builder — the equivalent of Compass'
 * `compass-aggregations` plugin: stage-by-stage editing with live preview,
 * auto-preview, explain, count, save/restore pipelines, create view,
 * export to language and $out/$merge awareness.
 */
export class AggregationPanel extends BaseWebviewPanel {
  protected get panelKey(): string {
    return `aggregation:${this.connectionId}:${this.namespace.toString()}`;
  }

  protected get title(): string {
    return `Aggregation — ${this.namespace.toString()}`;
  }

  protected get webviewName(): string {
    return 'aggregation';
  }

  private stages: AggregationStage[] = [];
  private abortController: AbortController | undefined;

  static open(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    history: QueryHistoryStore,
    myQueries: MyQueriesStore,
    connectionId: string,
    namespace: Namespace,
    initialPipeline?: string,
    viewColumn = vscode.ViewColumn.Active
  ): AggregationPanel {
    return new AggregationPanel(
      extensionUri,
      connectionManager,
      history,
      myQueries,
      connectionId,
      namespace,
      initialPipeline,
      viewColumn
    );
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly history: QueryHistoryStore,
    private readonly myQueries: MyQueriesStore,
    private readonly connectionId: string,
    private readonly namespace: Namespace,
    initialPipeline: string | undefined,
    viewColumn: vscode.ViewColumn
  ) {
    super(extensionUri);

    if (initialPipeline) {
      this.stages = this.parsePipelineToStages(initialPipeline);
    } else {
      this.stages = [this.newStage('{\n  \n}')];
    }

    this.initializePanel(viewColumn);
    this.registerHandlers();
    this.post('init', {
      namespace: namespace.toString(),
      database: namespace.database,
      collection: namespace.collection,
      connectionId,
      pipelineText: this.pipelineText()
    });
  }

  protected override onPanelReused(): void {
    this.post('init', {
      namespace: this.namespace.toString(),
      pipelineText: this.pipelineText()
    });
  }

  private async service(): Promise<DataService> {
    const connection = await this.connectionManager.requireClient(this.connectionId);
    return new DataService(connection.client, connection.options.id);
  }

  private connectionName(): string {
    return this.connectionManager.get(this.connectionId)?.options.name ?? this.connectionId;
  }

  private newStage(text: string): AggregationStage {
    return {
      id: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      enabled: true,
      expanded: true
    };
  }

  private parsePipelineToStages(text: string): AggregationStage[] {
    try {
      const pipeline = parsePipeline(text);
      return pipeline.map((stage) =>
        this.newStage(EJSON.stringify(stage, undefined, 2, { relaxed: false }))
      );
    } catch (err) {
      logger.warn('Could not parse initial pipeline', { error: (err as Error).message });
      return [this.newStage(text)];
    }
  }

  private pipelineText(): string {
    const pipeline = this.stages.flatMap((stage) => {
      if (!stage.enabled) {
        return [];
      }
      try {
        return [parseStage(stage.text)];
      } catch {
        return [];
      }
    }).filter((stage): stage is Document => Boolean(stage));
    return EJSON.stringify(pipeline, undefined, 2, { relaxed: false });
  }

  private buildPipeline(stages: StagePayload[]): Document[] {
    const pipeline: Document[] = [];
    for (const stage of stages) {
      if (!stage.enabled) continue;
      const parsed = parseStage(stage.text);
      if (parsed) pipeline.push(parsed);
    }
    return pipeline;
  }

  private pipelineStages(payload: PipelinePayload): StagePayload[] {
    return parsePipeline(payload.pipelineText).map((stage, index) => ({
      id: `stage-${index}`,
      text: EJSON.stringify(stage, undefined, 2, { relaxed: false }),
      enabled: true
    }));
  }

  private registerHandlers(): void {
    this.registerHandler('ready', (_msg, respond) => {
      respond({
        namespace: this.namespace.toString(),
        pipelineText: this.pipelineText()
      });
    });

    this.registerHandler('syncPipeline', (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      this.stages = this.pipelineStages(payload).map((stage) => this.newStage(stage.text));
      respond({ ok: true });
    });

    this.registerHandler('runAll', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      await this.runPipeline(this.pipelineStages(payload), undefined, true, respond);
    });

    this.registerHandler('cancel', () => {
      this.abortController?.abort();
    });

    this.registerHandler('count', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      this.assertReadOnlyPipeline(pipeline, 'Count');
      const service = await this.service();
      const count = await service.aggregateCount(this.namespace, pipeline);
      respond({ count });
    });

    this.registerHandler('explain', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      this.assertReadOnlyPipeline(pipeline, 'Explain');
      const service = await this.service();
      const explain = await service.explainAggregate(this.namespace, pipeline);
      this.history.add({
        connectionId: this.connectionId,
        connectionName: this.connectionName(),
        database: this.namespace.database,
        collection: this.namespace.collection,
        kind: 'explain',
        text: EJSON.stringify(pipeline),
        pipelineText: EJSON.stringify(pipeline),
        status: 'success',
        elapsedMS: explain.elapsedMS
      });
      respond(explain);
    });

    this.registerHandler('savePipeline', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      const name = await vscode.window.showInputBox({
        title: 'Save Aggregation Pipeline',
        prompt: 'Pipeline name',
        validateInput: (value) => value.trim() ? null : 'Name is required'
      });
      if (!name) {
        respond({ cancelled: true });
        return;
      }
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      const saved = await this.myQueries.savePipeline({
        name: name.trim(),
        connectionId: this.connectionId,
        database: this.namespace.database,
        collection: this.namespace.collection,
        pipelineText: EJSON.stringify(pipeline, undefined, 2, { relaxed: false })
      });
      respond(saved);
      void vscode.window.showInformationMessage(`Pipeline "${saved.name}" saved to My Queries.`);
    });

    this.registerHandler('createView', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      const viewName = await vscode.window.showInputBox({
        title: 'Create View from Pipeline',
        prompt: 'View name',
        validateInput: (value) => value.trim() ? null : 'Name is required'
      });
      if (!viewName) {
        respond({ cancelled: true });
        return;
      }
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      const service = await this.service();
      await service.createView(
        this.namespace.database,
        viewName.trim(),
        this.namespace.collection,
        pipeline
      );
      respond({ ok: true });
      void vscode.window.showInformationMessage(`View "${viewName.trim()}" created.`);
      this.post('refreshExplorer');
    });

    this.registerHandler('exportData', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload & { format: ExportFormat };
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      this.assertReadOnlyPipeline(pipeline, 'Export');
      const target = await vscode.window.showSaveDialog({
        title: `Export aggregation results from ${this.namespace.toString()}`,
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${this.namespace.collection}-aggregation.${payload.format}`)),
        filters: payload.format === 'csv' ? { CSV: ['csv'] } : { JSON: [payload.format] }
      });
      if (!target) {
        respond({ cancelled: true });
        return;
      }

      const service = await this.service();
      const io = new ImportExportService(service);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Exporting aggregation results…`, cancellable: true },
        (progress, token) => io.exportCollection(
          this.namespace,
          target.fsPath,
          { format: payload.format, pipeline },
          (value) => progress.report({ message: `${value.processed} documents…` }),
          token
        )
      );
      respond(result);
      void vscode.window.showInformationMessage(`Exported ${result.exported} documents to ${result.file}.`);
    });

    this.registerHandler('exportToLanguage', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload & { language: string };
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      const { exportToLanguage } = await import('../core/exportToLanguage');
      const connection = this.connectionManager.get(this.connectionId);
      const code = exportToLanguage(payload.language as never, {
        database: this.namespace.database,
        collection: this.namespace.collection,
        pipeline,
        connectionString: connection?.options.connectionString
      });
      respond({ code });
    });

    this.registerHandler('copyShellSnippet', async (msg, respond) => {
      const payload = msg.payload as PipelinePayload;
      const pipeline = this.buildPipeline(this.pipelineStages(payload));
      const { exportToLanguage } = await import('../core/exportToLanguage');
      const code = exportToLanguage('shell', {
        database: this.namespace.database,
        collection: this.namespace.collection,
        pipeline
      });
      await vscode.env.clipboard.writeText(code);
      respond({ ok: true });
    });

    this.registerHandler('inputDocuments', async (_msg, respond) => {
      const service = await this.service();
      const sampleSize = getConfig().defaultLimit;
      const docs = await service
        .collection(this.namespace)
        .find({}, { limit: sampleSize })
        .toArray();
      respond({
        documents: docs.map((d) => EJSON.stringify(d, undefined, 2, { relaxed: false })),
        count: docs.length
      });
    });

    this.registerHandler('stageHelp', (msg, respond) => {
      const payload = msg.payload as { stage: string };
      const help = STAGE_OPERATORS.find((s) => s.name === payload.stage);
      respond({
        url: `https://www.mongodb.com/docs/manual/reference/operator/aggregation/${payload.stage.replace('$', '')}/`,
        description: help?.description ?? ''
      });
    });
  }

  private assertReadOnlyPipeline(pipeline: Document[], action: string): void {
    if (pipeline.some((stage) => '$out' in stage || '$merge' in stage)) {
      throw new Error(`${action} is unavailable for pipelines containing $out or $merge.`);
    }
  }

  private async runPipeline(
    stages: StagePayload[],
    upToStageId: string | undefined,
    executeOutputStages: boolean,
    respond: (payload: unknown) => void
  ): Promise<void> {
    const started = Date.now();
    this.abortController?.abort();
    this.abortController = new AbortController();

    const enabledStages = stages.filter((s) => s.enabled);
    const cutIndex = upToStageId
      ? enabledStages.findIndex((s) => s.id === upToStageId)
      : enabledStages.length - 1;
    const effective = enabledStages.slice(0, cutIndex < 0 ? enabledStages.length : cutIndex + 1);

    let pipeline: Document[];
    try {
      pipeline = this.buildPipeline(effective);
    } catch (err) {
      respond({ error: (err as Error).message, documents: [], stageId: upToStageId });
      return;
    }

    const hasOutputStage = pipeline.some(
      (stage) => '$out' in stage || '$merge' in stage
    );

    try {
      const service = await this.service();

      if (hasOutputStage) {
        if (executeOutputStages) {
          await service.aggregate(this.namespace, pipeline, {}, {
            signal: this.abortController.signal
          });
          this.history.add({
            connectionId: this.connectionId,
            connectionName: this.connectionName(),
            database: this.namespace.database,
            collection: this.namespace.collection,
            kind: 'aggregate',
            text: EJSON.stringify(pipeline),
            pipelineText: EJSON.stringify(pipeline),
            status: 'success',
            count: null,
            elapsedMS: Date.now() - started
          });
          respond({
            documents: [],
            count: null,
            stageId: upToStageId,
            warning: 'Pipeline completed. $out/$merge wrote results to the target collection.',
            elapsedMS: Date.now() - started
          });
          this.post('refreshExplorer');
          return;
        }
        respond({
          documents: [],
          stageId: upToStageId,
          warning:
            'Preview is disabled because this pipeline contains $out/$merge. Use Run to execute the write operation.',
          elapsedMS: 0
        });
        return;
      }

      const previewPipeline = [...pipeline, { $limit: AGGREGATION_PREVIEW_LIMIT }];
      const documents = await service.aggregate(this.namespace, previewPipeline, {}, {
        signal: this.abortController.signal
      });

      const count = await service.aggregateCount(this.namespace, pipeline, {
        signal: this.abortController.signal
      });

      this.history.add({
        connectionId: this.connectionId,
        connectionName: this.connectionName(),
        database: this.namespace.database,
        collection: this.namespace.collection,
        kind: 'aggregate',
        text: EJSON.stringify(pipeline),
        pipelineText: EJSON.stringify(pipeline),
        status: 'success',
        count,
        elapsedMS: Date.now() - started
      });

      respond({
        documents: documents.map((d) => EJSON.stringify(d, undefined, 2, { relaxed: false })),
        count,
        stageId: upToStageId,
        elapsedMS: Date.now() - started
      });
    } catch (err) {
      const error = err as Error;
      if (this.abortController?.signal.aborted) {
        respond({ documents: [], stageId: upToStageId, aborted: true, elapsedMS: 0 });
        return;
      }
      this.history.add({
        connectionId: this.connectionId,
        connectionName: this.connectionName(),
        database: this.namespace.database,
        collection: this.namespace.collection,
        kind: 'aggregate',
        text: EJSON.stringify(pipeline),
        pipelineText: EJSON.stringify(pipeline),
        status: 'error',
        error: error.message,
        elapsedMS: Date.now() - started
      });
      respond({ error: error.message, documents: [], stageId: upToStageId });
    }
  }
}

interface StageOperator {
  name: string;
  description: string;
  template: string;
}

/** Stage catalogue used for the "add stage" picker and templates. */
const STAGE_OPERATORS: StageOperator[] = [
  { name: '$match', description: 'Filters documents to pass only those that match.', template: '{\n  $match: {\n    \n  }\n}' },
  { name: '$group', description: 'Groups documents by a specified expression.', template: '{\n  $group: {\n    _id: null,\n    count: { $sum: 1 }\n  }\n}' },
  { name: '$project', description: 'Reshapes documents by adding/removing fields.', template: '{\n  $project: {\n    \n  }\n}' },
  { name: '$sort', description: 'Sorts documents by the specified fields.', template: '{\n  $sort: {\n    \n  }\n}' },
  { name: '$limit', description: 'Limits the number of documents passed to the next stage.', template: '{\n  $limit: 10\n}' },
  { name: '$skip', description: 'Skips the first n documents.', template: '{\n  $skip: 0\n}' },
  { name: '$unwind', description: 'Deconstructs an array field into separate documents.', template: '{\n  $unwind: "$"\n}' },
  { name: '$lookup', description: 'Performs a left outer join with another collection.', template: '{\n  $lookup: {\n    from: "",\n    localField: "",\n    foreignField: "",\n    as: ""\n  }\n}' },
  { name: '$addFields', description: 'Adds new fields to documents.', template: '{\n  $addFields: {\n    \n  }\n}' },
  { name: '$set', description: 'Alias for $addFields.', template: '{\n  $set: {\n    \n  }\n}' },
  { name: '$unset', description: 'Removes/excludes fields from documents.', template: '{\n  $unset: ""\n}' },
  { name: '$replaceRoot', description: 'Replaces the input document with the specified document.', template: '{\n  $replaceRoot: {\n    newRoot: ""\n  }\n}' },
  { name: '$count', description: 'Returns a count of the documents at this stage.', template: '{\n  $count: "count"\n}' },
  { name: '$facet', description: 'Processes multiple aggregation pipelines within a single stage.', template: '{\n  $facet: {\n    \n  }\n}' },
  { name: '$bucket', description: 'Categorizes documents into buckets by boundaries.', template: '{\n  $bucket: {\n    groupBy: "",\n    boundaries: [],\n    default: "other"\n  }\n}' },
  { name: '$sample', description: 'Randomly selects the specified number of documents.', template: '{\n  $sample: {\n    size: 5\n  }\n}' },
  { name: '$graphLookup', description: 'Performs a recursive search on a collection.', template: '{\n  $graphLookup: {\n    from: "",\n    startWith: "",\n    connectFromField: "",\n    connectToField: "",\n    as: ""\n  }\n}' },
  { name: '$search', description: 'Atlas Search full-text/semantic query.', template: '{\n  $search: {\n    text: {\n      query: "",\n      path: ""\n    }\n  }\n}' },
  { name: '$vectorSearch', description: 'Atlas Vector Search (semantic similarity).', template: '{\n  $vectorSearch: {\n    index: "",\n    path: "",\n    queryVector: [],\n    numCandidates: 100,\n    limit: 10\n  }\n}' },
  { name: '$out', description: 'Writes the pipeline results to a collection.', template: '{\n  $out: ""\n}' },
  { name: '$merge', description: 'Merges the pipeline results into a collection.', template: '{\n  $merge: {\n    into: ""\n  }\n}' }
];
