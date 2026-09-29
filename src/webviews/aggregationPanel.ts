import * as vscode from 'vscode';
import { EJSON, type Document } from 'bson';
import { BaseWebviewPanel } from './baseWebview';
import { DataService, Namespace } from '../core/dataService';
import type { ConnectionManager } from '../core/connectionManager';
import type { QueryHistoryStore } from '../core/queryHistory';
import type { MyQueriesStore } from '../core/myQueries';
import { parseStage, parsePipeline } from '../core/bsonParser';
import { getConfig } from '../core/config';
import { logger } from '../core/logger';
import type { AggregationStage } from '../core/types';

interface StagePayload {
  id: string;
  text: string;
  enabled: boolean;
}

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
      stages: this.stages,
      autoPreview: getConfig().autoPreviewPipeline,
      stageOperators: STAGE_OPERATORS
    });
  }

  protected override onPanelReused(): void {
    this.post('init', {
      namespace: this.namespace.toString(),
      stages: this.stages,
      autoPreview: getConfig().autoPreviewPipeline,
      stageOperators: STAGE_OPERATORS
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

  /** Build the effective pipeline from enabled stages. */
  private buildPipeline(stages: StagePayload[]): Document[] {
    const pipeline: Document[] = [];
    for (const stage of stages) {
      if (!stage.enabled) {
        continue;
      }
      const parsed = parseStage(stage.text);
      if (parsed) {
        pipeline.push(parsed);
      }
    }
    return pipeline;
  }

  private registerHandlers(): void {
    this.registerHandler('ready', (_msg, respond) => {
      respond({
        namespace: this.namespace.toString(),
        stages: this.stages,
        autoPreview: getConfig().autoPreviewPipeline,
        stageOperators: STAGE_OPERATORS
      });
    });

    this.registerHandler('syncStages', (msg, respond) => {
      const payload = msg.payload as { stages: StagePayload[] };
      this.stages = payload.stages.map((s) => ({
        ...this.findStage(s.id) ?? this.newStage(s.text),
        text: s.text,
        enabled: s.enabled
      }));
      respond({ ok: true });
    });

    this.registerHandler('preview', async (msg, respond) => {
      const payload = msg.payload as { stages: StagePayload[]; upToStageId?: string };
      await this.runPreview(payload.stages, payload.upToStageId, respond);
    });

    this.registerHandler('runAll', async (msg, respond) => {
      const payload = msg.payload as { stages: StagePayload[] };
      await this.runPreview(payload.stages, undefined, respond);
    });

    this.registerHandler('cancel', () => {
      this.abortController?.abort();
    });

    this.registerHandler('count', async (msg, respond) => {
      const payload = msg.payload as { stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
      const service = await this.service();
      const count = await service.aggregateCount(this.namespace, pipeline);
      respond({ count });
    });

    this.registerHandler('explain', async (msg, respond) => {
      const payload = msg.payload as { stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
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
      const payload = msg.payload as { name: string; stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
      const saved = await this.myQueries.savePipeline({
        name: payload.name,
        connectionId: this.connectionId,
        database: this.namespace.database,
        collection: this.namespace.collection,
        pipelineText: EJSON.stringify(pipeline, undefined, 2, { relaxed: false })
      });
      respond(saved);
      void vscode.window.showInformationMessage(`Pipeline "${saved.name}" saved to My Queries.`);
    });

    this.registerHandler('createView', async (msg, respond) => {
      const payload = msg.payload as { viewName: string; stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
      const service = await this.service();
      await service.createView(
        this.namespace.database,
        payload.viewName,
        this.namespace.collection,
        pipeline
      );
      respond({ ok: true });
      void vscode.window.showInformationMessage(`View "${payload.viewName}" created.`);
      this.post('refreshExplorer');
    });

    this.registerHandler('exportToLanguage', async (msg, respond) => {
      const payload = msg.payload as { language: string; stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
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
      const payload = msg.payload as { stages: StagePayload[] };
      const pipeline = this.buildPipeline(payload.stages);
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

  private findStage(id: string): AggregationStage | undefined {
    return this.stages.find((s) => s.id === id);
  }

  private async runPreview(
    stages: StagePayload[],
    upToStageId: string | undefined,
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
      const config = getConfig();

      if (hasOutputStage) {
        respond({
          documents: [],
          stageId: upToStageId,
          warning:
            'The pipeline ends with $out/$merge which writes to a collection. Preview is disabled for output stages — run it explicitly to persist results.',
          elapsedMS: 0
        });
        return;
      }

      const previewPipeline = [...pipeline, { $limit: config.defaultLimit }];
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
