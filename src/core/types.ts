import type * as vscode from 'vscode';
import type { Document, MongoClient, ReadPreferenceMode } from 'mongodb';

/** A saved connection definition (mirrors Compass `ConnectionInfo`). */
export interface ConnectionOptions {
  id: string;
  name: string;
  connectionString: string;
  /** Optional extra driver options that cannot be expressed in the URI. */
  readPreference?: ReadPreferenceMode;
  serverSelectionTimeoutMS?: number;
  /** Free-form notes shown in the tooltip. */
  notes?: string;
  /** Colour used for the connection badge in the explorer. */
  color?: string;
  lastUsed?: number;
  favorite?: boolean;
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface LiveConnection {
  options: ConnectionOptions;
  client: MongoClient;
  state: ConnectionState;
  error?: string;
  topology?: TopologyInfo;
}

export interface TopologyInfo {
  serverVersion: string;
  topologyType: string;
  isAtlas: boolean;
  isDataLake: boolean;
  isGenuine: boolean;
  isEnterprise: boolean;
  buildEnvironment?: Document;
}

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number;
  empty: boolean;
  state?: string;
}

export type CollectionType = 'collection' | 'view' | 'timeseries';

export interface CollectionInfo {
  name: string;
  type: CollectionType;
  options?: Document;
  info?: {
    readOnly?: boolean;
    uuid?: unknown;
  };
  idIndex?: Document;
}

export interface IndexInfo {
  name: string;
  key: Document;
  unique?: boolean;
  sparse?: boolean;
  background?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: Document;
  collation?: Document;
  weights?: Document;
  default_language?: string;
  language_override?: string;
  textIndexVersion?: number;
  '2dsphereIndexVersion'?: number;
  bits?: number;
  min?: number;
  max?: number;
  bucketSize?: number;
  wildcardProjection?: Document;
  hidden?: boolean;
  v?: number;
  [key: string]: unknown;
}

/** Query bar state — the same shape Compass keeps in its query bar store. */
export interface QueryState {
  filter: Document;
  filterText: string;
  project: Document;
  projectText: string;
  sort: Document;
  sortText: string;
  collation: Document | null;
  collationText: string;
  skip: number;
  limit: number;
  maxTimeMS: number;
}

export interface QueryResult {
  documents: Document[];
  /** `null` when the count could not be computed (e.g. aborted). */
  count: number | null;
  /** Approximate total number of documents in the collection. */
  totalCount: number | null;
  elapsedMS: number;
  query: QueryState;
}

export interface AggregationStage {
  id: string;
  /** Raw text of the stage as typed by the user. */
  text: string;
  enabled: boolean;
  expanded: boolean;
  /** Preview documents produced by the pipeline up to this stage. */
  preview?: Document[];
  previewError?: string;
  previewCount?: number | null;
  isLoading?: boolean;
}

export interface SavedPipeline {
  id: string;
  name: string;
  connectionId?: string;
  database: string;
  collection: string;
  pipelineText: string;
  comments?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  connectionId?: string;
  database: string;
  collection: string;
  query: QueryState;
  createdAt: number;
  updatedAt: number;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  collection: string;
  kind: 'find' | 'aggregate' | 'explain' | 'command';
  text: string;
  query?: QueryState;
  pipelineText?: string;
  status: 'success' | 'error';
  error?: string;
  count?: number | null;
  elapsedMS: number;
  timestamp: number;
}

/** Schema analysis result for a single field (mirrors `mongodb-schema` output). */
export interface SchemaField {
  path: string;
  name: string;
  types: SchemaType[];
  count: number;
  /** Percentage of sampled documents containing this field. */
  probability: number;
  hasDuplicates?: boolean;
}

export interface SchemaType {
  name: string;
  count: number;
  probability: number;
  /** Unique values (capped) for primitive types. */
  values?: unknown[];
  unique?: number;
  /** For strings. */
  minLength?: number;
  maxLength?: number;
  averageLength?: number;
  /** For numbers. */
  min?: number;
  max?: number;
  average?: number;
  /** For arrays. */
  arrayItems?: SchemaType[];
  /** For embedded documents. */
  fields?: SchemaField[];
}

export interface SchemaAnalysis {
  namespace: string;
  sampledDocuments: number;
  totalDocuments: number | null;
  fields: SchemaField[];
  elapsedMS: number;
  /** Fields that look like they should be indexed but are not. */
  suggestions: string[];
}

export interface ExplainSummary {
  namespace: string;
  winningPlan: Document;
  rejectedPlans: Document[];
  executionStats?: Document;
  raw: Document;
  /** Flattened, human readable plan tree. */
  tree: ExplainNode[];
  insights: string[];
  elapsedMS: number;
}

export interface ExplainNode {
  stage: string;
  description: string;
  details: Record<string, string>;
  children: ExplainNode[];
}

/** Message envelope used by every webview. */
export interface WebviewMessage<T = unknown> {
  type: string;
  requestId?: string;
  payload?: T;
  error?: { message: string; code?: number };
}

export interface WebviewRequestContext {
  connectionId: string;
  database: string;
  collection: string;
}

export type ViewKind =
  | 'documents'
  | 'aggregation'
  | 'indexes'
  | 'schema'
  | 'validation'
  | 'explain'
  | 'stats'
  | 'serverStatus'
  | 'queryHistory'
  | 'savedQueries'
  | 'currentOp';

export interface OpenViewOptions {
  kind: ViewKind;
  connectionId: string;
  database?: string;
  collection?: string;
  /** Pre-filled query text (e.g. when opening explain from a query). */
  initialQuery?: Partial<QueryState>;
  initialPipeline?: string;
  title?: string;
  preserveFocus?: boolean;
  viewColumn?: vscode.ViewColumn;
}
