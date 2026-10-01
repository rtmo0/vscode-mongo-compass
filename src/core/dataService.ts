import {
  type Document,
  type Filter,
  type AggregateOptions,
  type FindOptions,
  type Abortable
} from 'mongodb';
import { EJSON } from 'bson';
import type { Collection, Db, MongoClient } from 'mongodb';
import type {
  CollectionInfo,
  DatabaseInfo,
  IndexInfo,
  QueryResult,
  QueryState,
  SchemaAnalysis
} from './types';
import { getConfig } from './config';
import { logger } from './logger';
import { analyzeDocuments } from './schemaAnalyzer';
import { summarizeExplain } from './explainHelper';
import type { ExplainSummary } from './types';

export interface ExecutionOptions {
  maxTimeMS?: number;
  signal?: AbortSignal;
  readPreference?: string;
}

/**
 * Thin, promise-based facade over the Node driver.
 * Mirrors the surface of Compass' `mongodb-data-service` package so the UI
 * layers never touch the driver directly.
 */
export class DataService {
  constructor(
    private readonly client: MongoClient,
    public readonly connectionId: string
  ) {}

  // ───────────────────────────── instance ─────────────────────────────

  async listDatabases(): Promise<DatabaseInfo[]> {
    const admin = this.client.db('admin');
    const result = await admin.command({ listDatabases: 1 });
    const databases = (result.databases ?? []) as DatabaseInfo[];
    const config = getConfig();
    const filtered = config.hideSystemDatabases
      ? databases.filter((db) => !['admin', 'local', 'config'].includes(db.name))
      : databases;
    return filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listCollections(database: string): Promise<CollectionInfo[]> {
    const db = this.client.db(database);
    const raw = await db.listCollections({}, { nameOnly: false }).toArray();
    const config = getConfig();
    return (raw as unknown as CollectionInfo[])
      .filter((c) => config.showSystemCollections || !c.name.startsWith('system.'))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createDatabase(database: string, collection: string): Promise<void> {
    await this.client.db(database).createCollection(collection);
  }

  async dropDatabase(database: string): Promise<boolean> {
    return this.client.db(database).dropDatabase();
  }

  async databaseStats(database: string): Promise<Document> {
    return this.client.db(database).stats();
  }

  async runCommand(database: string, command: Document): Promise<Document> {
    return this.client.db(database).command(command);
  }

  async serverStatus(): Promise<Document> {
    try {
      return await this.client.db('admin').command({ serverStatus: 1 });
    } catch (err) {
      logger.warn('serverStatus failed', { error: (err as Error).message });
      throw err;
    }
  }

  async currentOp(): Promise<Document> {
    const inprog = await this.client.db('admin').aggregate([
      {
        $currentOp: {
          allUsers: true,
          idleConnections: false,
          truncateOps: false
        }
      }
    ]).toArray();
    return { inprog };
  }

  async killOp(opId: number): Promise<Document> {
    return this.client.db('admin').command({ killOp: 1, id: opId });
  }

  async ping(): Promise<Document> {
    return this.client.db('admin').command({ ping: 1 });
  }

  // ───────────────────────────── collections ─────────────────────────────

  async createCollection(
    database: string,
    collection: string,
    options: Document = {}
  ): Promise<void> {
    await this.client.db(database).createCollection(collection, options);
  }

  async createView(
    database: string,
    view: string,
    source: string,
    pipeline: Document[],
    options: Document = {}
  ): Promise<void> {
    await this.client.db(database).createCollection(view, {
      ...options,
      viewOn: source,
      pipeline
    });
  }

  async dropCollection(database: string, collection: string): Promise<boolean> {
    return this.client.db(database).dropCollection(collection);
  }

  async renameCollection(
    database: string,
    from: string,
    to: string,
    dropTarget = false
  ): Promise<Document> {
    return this.client.db(database).renameCollection(from, to, { dropTarget });
  }

  async collectionStats(database: string, collection: string): Promise<Document> {
    return this.client.db(database).command({ collStats: collection });
  }

  async collectionInfo(database: string, collection: string): Promise<CollectionInfo | undefined> {
    const all = await this.listCollections(database);
    return all.find((c) => c.name === collection);
  }

  // ───────────────────────────── find / CRUD ─────────────────────────────

  async find(
    ns: Namespace,
    query: QueryState,
    execution: ExecutionOptions = {}
  ): Promise<QueryResult> {
    const started = Date.now();
    const coll = this.collection(ns);
    const config = getConfig();

    const options: FindOptions & Abortable = {
      limit: query.limit || config.defaultLimit,
      skip: query.skip,
      maxTimeMS: execution.maxTimeMS ?? query.maxTimeMS ?? config.maxTimeMS,
      timeoutMS: execution.maxTimeMS ?? query.maxTimeMS ?? config.maxTimeMS,
      signal: execution.signal
    };
    if (query.project && Object.keys(query.project).length > 0) {
      options.projection = query.project;
    }
    if (query.sort && Object.keys(query.sort).length > 0) {
      options.sort = query.sort;
    }
    if (query.collation) {
      options.collation = query.collation as FindOptions['collation'];
    }
    if (execution.readPreference) {
      options.readPreference = execution.readPreference as FindOptions['readPreference'];
    }

    logger.info('Find started', {
      ns: ns.toString(),
      limit: options.limit,
      skip: options.skip,
      timeoutMS: options.timeoutMS
    });
    const documents = await coll
      .find(query.filter as Filter<Document>, options)
      .toArray();
    logger.info('Find completed', { ns: ns.toString(), documents: documents.length });

    // Number of documents matching the filter (without skip/limit), used by the
    // query bar to show "N matched". A rough collection total is fetched as well
    // so the UI can show "M total" even before any documents are loaded.
    const [count, totalCount] = await Promise.all([
      coll
        .countDocuments(query.filter as Filter<Document>, {
          maxTimeMS: options.maxTimeMS,
          signal: execution.signal
        })
        .catch((err) => {
          logger.warn('Count failed', { ns: ns.toString(), error: (err as Error).message });
          return null;
        }),
      coll
        .estimatedDocumentCount({ maxTimeMS: options.maxTimeMS })
        .catch((err) => {
          logger.warn('Estimated count failed', {
            ns: ns.toString(),
            error: (err as Error).message
          });
          return null;
        })
    ]);

    return {
      documents,
      count,
      totalCount,
      elapsedMS: Date.now() - started,
      query
    };
  }

  async findOne(ns: Namespace, filter: Document): Promise<Document | null> {
    return this.collection(ns).findOne(filter);
  }

  async insertOne(ns: Namespace, doc: Document): Promise<string> {
    const result = await this.collection(ns).insertOne(doc);
    return String(result.insertedId);
  }

  async insertMany(ns: Namespace, docs: Document[]): Promise<number> {
    const result = await this.collection(ns).insertMany(docs);
    return Object.keys(result.insertedIds ?? {}).length;
  }

  async updateOne(
    ns: Namespace,
    filter: Document,
    update: Document
  ): Promise<{ matched: number; modified: number }> {
    const result = await this.collection(ns).updateOne(filter, update);
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }

  async updateMany(
    ns: Namespace,
    filter: Document,
    update: Document
  ): Promise<{ matched: number; modified: number }> {
    const result = await this.collection(ns).updateMany(filter, update);
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }

  async replaceOne(
    ns: Namespace,
    filter: Document,
    replacement: Document
  ): Promise<{ matched: number; modified: number }> {
    const result = await this.collection(ns).replaceOne(filter, replacement);
    return { matched: result.matchedCount, modified: result.modifiedCount };
  }

  async deleteOne(ns: Namespace, filter: Document): Promise<number> {
    const result = await this.collection(ns).deleteOne(filter);
    return result.deletedCount;
  }

  async deleteMany(ns: Namespace, filter: Document): Promise<number> {
    const result = await this.collection(ns).deleteMany(filter);
    return result.deletedCount;
  }

  async bulkWrite(ns: Namespace, operations: Document[]): Promise<Document> {
    const result = await this.collection(ns).bulkWrite(operations as never);
    return {
      insertedCount: result.insertedCount,
      matchedCount: result.matchedCount,
      modifiedCount: result.modifiedCount,
      deletedCount: result.deletedCount,
      upsertedCount: result.upsertedCount
    };
  }

  async countDocuments(ns: Namespace, filter: Document = {}): Promise<number> {
    return this.collection(ns).countDocuments(filter, {
      maxTimeMS: getConfig().maxTimeMS
    });
  }

  // ───────────────────────────── aggregation ─────────────────────────────

  async aggregate(
    ns: Namespace,
    pipeline: Document[],
    options: AggregateOptions = {},
    execution: ExecutionOptions = {}
  ): Promise<Document[]> {
    const config = getConfig();
    return this.collection(ns)
      .aggregate(pipeline, {
        maxTimeMS: execution.maxTimeMS ?? config.maxTimeMS,
        signal: execution.signal,
        ...options
      } as AggregateOptions & Abortable)
      .toArray();
  }

  async aggregateCount(
    ns: Namespace,
    pipeline: Document[],
    execution: ExecutionOptions = {}
  ): Promise<number | null> {
    try {
      const docs = await this.aggregate(
        ns,
        [...pipeline, { $count: '__compass_count' }],
        {},
        execution
      );
      const value = docs[0]?.__compass_count;
      return typeof value === 'number' ? value : null;
    } catch (err) {
      logger.warn('aggregate count failed', { error: (err as Error).message });
      return null;
    }
  }

  async explainFind(ns: Namespace, query: QueryState): Promise<ExplainSummary> {
    const started = Date.now();
    const command: Document = {
      find: ns.collection,
      filter: query.filter,
      sort: query.sort,
      projection: query.project,
      skip: query.skip,
      limit: query.limit
    };
    if (query.collation) {
      command.collation = query.collation;
    }
    const raw = await this.client.db(ns.database).command({ explain: command, verbosity: 'executionStats' });
    return { ...summarizeExplain(raw, ns.toString()), elapsedMS: Date.now() - started };
  }

  async explainAggregate(
    ns: Namespace,
    pipeline: Document[],
    options: AggregateOptions = {}
  ): Promise<ExplainSummary> {
    const started = Date.now();
    const cursor = this.collection(ns).aggregate(pipeline, options);
    const raw = await cursor.explain('executionStats');
    return { ...summarizeExplain(raw, ns.toString()), elapsedMS: Date.now() - started };
  }

  // ───────────────────────────── indexes ─────────────────────────────

  async listIndexes(ns: Namespace): Promise<IndexInfo[]> {
    try {
      const raw = await this.collection(ns).indexes();
      return raw as IndexInfo[];
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 26) {
        // NamespaceNotFound — collection does not exist yet.
        return [];
      }
      throw err;
    }
  }

  async listIndexStats(ns: Namespace): Promise<{ stats: Document[]; error?: string }> {
    try {
      const stats = await this.collection(ns)
        .aggregate([{ $indexStats: {} }], { readPreference: 'primary' })
        .toArray();
      return { stats: normalizeIndexStats(stats) };
    } catch (err) {
      const firstError = (err as Error).message;
      try {
        const result = await this.client.db(ns.database).command(
          {
            aggregate: ns.collection,
            pipeline: [{ $indexStats: {} }],
            cursor: {}
          },
          { readPreference: 'primary' }
        );
        const stats = (result.cursor?.firstBatch ?? []) as Document[];
        return { stats: normalizeIndexStats(stats) };
      } catch (fallbackErr) {
        const error = (fallbackErr as Error).message || firstError;
        logger.warn('Index usage stats unavailable', { error, namespace: ns.toString() });
        return { stats: [], error };
      }
    }
  }

  async createIndex(
    ns: Namespace,
    keys: Document,
    options: Document = {}
  ): Promise<string> {
    return this.collection(ns).createIndex(keys, options as never);
  }

  async dropIndex(ns: Namespace, name: string): Promise<Document> {
    return this.collection(ns).dropIndex(name);
  }

  async listSearchIndexes(ns: Namespace): Promise<Document[]> {
    try {
      return await this.collection(ns).listSearchIndexes().toArray();
    } catch (err) {
      logger.warn('listSearchIndexes unsupported', { error: (err as Error).message });
      return [];
    }
  }

  async createSearchIndex(ns: Namespace, definition: Document): Promise<string> {
    return this.collection(ns).createSearchIndex(definition as never);
  }

  async dropSearchIndex(ns: Namespace, name: string): Promise<void> {
    return this.collection(ns).dropSearchIndex(name);
  }

  // ───────────────────────────── schema / validation ─────────────────────────────

  async analyzeSchema(
    ns: Namespace,
    query: Document = {},
    sampleSize = getConfig().schemaSampleSize,
    execution: ExecutionOptions = {}
  ): Promise<SchemaAnalysis> {
    const started = Date.now();
    const coll = this.collection(ns);
    const documents = await coll
      .find(query as Filter<Document>, {
        limit: sampleSize,
        maxTimeMS: execution.maxTimeMS ?? getConfig().maxTimeMS,
        signal: execution.signal
      } as FindOptions & Abortable)
      .toArray();

    let totalDocuments: number | null = null;
    try {
      totalDocuments = await coll.estimatedDocumentCount();
    } catch {
      totalDocuments = null;
    }

    const indexes = await this.listIndexes(ns);
    const analysis = analyzeDocuments(documents, indexes);

    return {
      namespace: ns.toString(),
      sampledDocuments: documents.length,
      totalDocuments,
      fields: analysis.fields,
      suggestions: analysis.suggestions,
      elapsedMS: Date.now() - started
    };
  }

  async getValidation(ns: Namespace): Promise<Document | null> {
    const info = await this.collectionInfo(ns.database, ns.collection);
    return info?.options?.validator ?? null;
  }

  async setValidation(
    ns: Namespace,
    validator: Document | null,
    validationLevel = 'strict',
    validationAction = 'error'
  ): Promise<Document> {
    const collMod: Document = { collMod: ns.collection };
    if (validator === null) {
      collMod.validator = {};
    } else {
      collMod.validator = validator;
      collMod.validationLevel = validationLevel;
      collMod.validationAction = validationAction;
    }
    return this.client.db(ns.database).command(collMod);
  }

  // ───────────────────────────── helpers ─────────────────────────────

  db(database: string): Db {
    return this.client.db(database);
  }

  collection(ns: Namespace): Collection<Document> {
    return this.client.db(ns.database).collection(ns.collection);
  }

  /** Serialise a document to canonical/relaxed EJSON text. */
  static toEJSON(value: unknown, relaxed = false, indent = 2): string {
    return EJSON.stringify(value, undefined, indent, { relaxed });
  }
}

/** `db.collection` namespace helper. */
function normalizeIndexStats(stats: Document[]): Document[] {
  return stats.map((stat) => {
    const accesses = stat.accesses as Document | undefined;
    const rawOps = accesses?.ops as { toNumber?: () => number } | number | undefined;
    const ops = typeof rawOps === 'number' ? rawOps : rawOps?.toNumber?.() ?? Number(rawOps ?? 0);
    const rawSince = accesses?.since;
    const since = rawSince instanceof Date ? rawSince.toISOString() : rawSince;
    return {
      ...stat,
      accesses: accesses ? { ...accesses, ops, since } : undefined
    };
  });
}

export class Namespace {
  constructor(
    public readonly database: string,
    public readonly collection: string
  ) {}

  static parse(ns: string): Namespace {
    const index = ns.indexOf('.');
    if (index < 0) {
      throw new Error(`Invalid namespace "${ns}", expected "database.collection"`);
    }
    return new Namespace(ns.slice(0, index), ns.slice(index + 1));
  }

  toString(): string {
    return `${this.database}.${this.collection}`;
  }
}
