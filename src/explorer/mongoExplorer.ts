import * as vscode from 'vscode';
import type { Document } from 'mongodb';
import type {
  CollectionInfo,
  DatabaseInfo,
  IndexInfo,
  LiveConnection
} from '../core/types';
import type { ConnectionManager } from '../core/connectionManager';
import { DataService, Namespace } from '../core/dataService';
import { logger } from '../core/logger';
import {
  hostSummary,
  redactConnectionString
} from '../core/connectionString';

export type NodeKind =
  | 'connection'
  | 'databases'
  | 'database'
  | 'collections'
  | 'collection'
  | 'views'
  | 'indexes'
  | 'index'
  | 'searchIndexes'
  | 'searchIndex'
  | 'info'
  | 'error';

export abstract class BaseNode {
  abstract readonly kind: NodeKind;
  abstract getTreeItem(): vscode.TreeItem | Promise<vscode.TreeItem>;
  getChildren(): BaseNode[] | Promise<BaseNode[]> {
    return [];
  }
}

export class ConnectionNode extends BaseNode {
  readonly kind = 'connection' as const;
  constructor(public readonly connection: LiveConnection) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const { options, state, topology, error } = this.connection;
    const item = new vscode.TreeItem(
      options.name,
      state === 'connected'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );

    const host = safeHost(options.connectionString);
    item.description =
      state === 'connected' && topology
        ? `${host} · v${topology.serverVersion}`
        : state === 'error'
          ? `error`
          : host;

    item.contextValue = `connection.${state}`;
    item.tooltip = buildConnectionTooltip(
      options.name,
      options.connectionString,
      state,
      topology,
      error,
      options.notes,
      options.color
    );

    const selectedColor = connectionThemeColor(options.color);

    switch (state) {
      case 'connected':
        item.iconPath = new vscode.ThemeIcon(
          'database',
          selectedColor ?? new vscode.ThemeColor('charts.green')
        );
        break;
      case 'connecting':
        item.iconPath = new vscode.ThemeIcon('sync~spin', selectedColor);
        break;
      case 'error':
        item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
        break;
      default:
        item.iconPath = new vscode.ThemeIcon('plug', selectedColor);
        break;
    }

    return item;
  }

  override getChildren(): BaseNode[] {
    if (this.connection.state !== 'connected') {
      if (this.connection.state === 'error' && this.connection.error) {
        return [new InfoNode(this.connection.error, 'error', 'error')];
      }
      return [];
    }
    return [new DatabasesNode(this.connection)];
  }
}

export class DatabasesNode extends BaseNode {
  readonly kind = 'databases' as const;
  constructor(public readonly connection: LiveConnection) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Databases', vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('library');
    item.contextValue = 'databases';
    return item;
  }

  override async getChildren(): Promise<BaseNode[]> {
    try {
      const service = new DataService(this.connection.client, this.connection.options.id);
      const databases = await service.listDatabases();
      if (databases.length === 0) {
        return [new InfoNode('No databases found', 'info')];
      }
      return databases.map((db) => new DatabaseNode(this.connection, db));
    } catch (err) {
      logger.error('Failed to list databases', { error: (err as Error).message });
      return [new InfoNode((err as Error).message, 'error', 'error')];
    }
  }
}

export class DatabaseNode extends BaseNode {
  readonly kind = 'database' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly database: DatabaseInfo
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.database.name,
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.description = formatBytes(this.database.sizeOnDisk);
    item.iconPath = new vscode.ThemeIcon('database');
    item.contextValue = 'database';
    item.tooltip = `${this.database.name}\nSize on disk: ${formatBytes(this.database.sizeOnDisk)}${
      this.database.empty ? '\n(empty)' : ''
    }`;
    return item;
  }

  override getChildren(): BaseNode[] {
    return [new CollectionsNode(this.connection, this.database.name)];
  }
}

export class CollectionsNode extends BaseNode {
  readonly kind = 'collections' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly databaseName: string
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Collections',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = new vscode.ThemeIcon('files');
    item.contextValue = 'collections';
    return item;
  }

  override async getChildren(): Promise<BaseNode[]> {
    try {
      const service = new DataService(this.connection.client, this.connection.options.id);
      const collections = await service.listCollections(this.databaseName);
      if (collections.length === 0) {
        return [new InfoNode('No collections', 'info')];
      }
      const regular = collections.filter((c) => c.type === 'collection' || c.type === 'timeseries');
      const views = collections.filter((c) => c.type === 'view');
      const nodes: BaseNode[] = regular.map(
        (c) => new CollectionNode(this.connection, this.databaseName, c)
      );
      if (views.length > 0) {
        nodes.push(new ViewsNode(this.connection, this.databaseName, views));
      }
      return nodes;
    } catch (err) {
      logger.error('Failed to list collections', { error: (err as Error).message });
      return [new InfoNode((err as Error).message, 'error', 'error')];
    }
  }
}

export class ViewsNode extends BaseNode {
  readonly kind = 'views' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly databaseName: string,
    public readonly views: CollectionInfo[]
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Views', vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('eye');
    item.contextValue = 'views';
    item.description = String(this.views.length);
    return item;
  }

  override getChildren(): BaseNode[] {
    return this.views.map(
      (v) => new CollectionNode(this.connection, this.databaseName, v)
    );
  }
}

export class CollectionNode extends BaseNode {
  readonly kind = 'collection' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly databaseName: string,
    public readonly collection: CollectionInfo
  ) {
    super();
  }

  get namespace(): Namespace {
    return new Namespace(this.databaseName, this.collection.name);
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      this.collection.name,
      vscode.TreeItemCollapsibleState.None
    );
    const isView = this.collection.type === 'view';
    const isTimeSeries = this.collection.type === 'timeseries';
    item.iconPath = new vscode.ThemeIcon(
      isView ? 'eye' : isTimeSeries ? 'graph-line' : 'file-code'
    );
    item.contextValue = isView
      ? 'collection.view'
      : isTimeSeries
        ? 'collection.timeseries'
        : 'collection';
    item.tooltip = `${this.namespace.toString()}\nType: ${this.collection.type}${
      isView && this.collection.options?.viewOn
        ? `\nView on: ${String(this.collection.options.viewOn)}`
        : ''
    }`;
    item.command = {
      command: 'mongoCompass.openDocuments',
      title: 'Browse Documents',
      arguments: [this]
    };
    return item;
  }

  override getChildren(): BaseNode[] {
    return [];
  }
}

export class IndexesNode extends BaseNode {
  readonly kind = 'indexes' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly namespace: Namespace
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem('Indexes', vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon('list-tree');
    item.contextValue = 'indexes';
    return item;
  }

  override async getChildren(): Promise<BaseNode[]> {
    try {
      const service = new DataService(this.connection.client, this.connection.options.id);
      const indexes = await service.listIndexes(this.namespace);
      if (indexes.length === 0) {
        return [new InfoNode('No indexes', 'info')];
      }
      return indexes.map((index) => new IndexNode(this.connection, this.namespace, index));
    } catch (err) {
      logger.error('Failed to list indexes', { error: (err as Error).message });
      return [new InfoNode((err as Error).message, 'error', 'error')];
    }
  }
}

export class IndexNode extends BaseNode {
  readonly kind = 'index' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly namespace: Namespace,
    public readonly index: IndexInfo
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const keyDescription = Object.entries(this.index.key ?? {})
      .map(([field, direction]) => `${field}: ${formatDirection(direction)}`)
      .join(', ');
    const item = new vscode.TreeItem(this.index.name, vscode.TreeItemCollapsibleState.None);
    item.description = keyDescription;
    item.iconPath = new vscode.ThemeIcon(
      this.index.unique ? 'key' : 'list-flat'
    );
    item.contextValue = 'index';
    item.tooltip = buildIndexTooltip(this.index);
    return item;
  }
}

export class SearchIndexesNode extends BaseNode {
  readonly kind = 'searchIndexes' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly namespace: Namespace
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Search Indexes',
      vscode.TreeItemCollapsibleState.Collapsed
    );
    item.iconPath = new vscode.ThemeIcon('search');
    item.contextValue = 'searchIndexes';
    return item;
  }

  override async getChildren(): Promise<BaseNode[]> {
    try {
      const service = new DataService(this.connection.client, this.connection.options.id);
      const indexes = await service.listSearchIndexes(this.namespace);
      if (indexes.length === 0) {
        return [new InfoNode('No Atlas Search indexes (Atlas only)', 'info')];
      }
      return indexes.map(
        (index) => new SearchIndexNode(this.connection, this.namespace, index)
      );
    } catch {
      return [new InfoNode('Atlas Search not available', 'info')];
    }
  }
}

export class SearchIndexNode extends BaseNode {
  readonly kind = 'searchIndex' as const;
  constructor(
    public readonly connection: LiveConnection,
    public readonly namespace: Namespace,
    public readonly index: Document
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const name = String(this.index.name ?? 'search-index');
    const status = String(this.index.status ?? '');
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
    item.description = status;
    item.iconPath = new vscode.ThemeIcon('search-fuzzy');
    item.contextValue = 'searchIndex';
    item.tooltip = JSON.stringify(this.index, null, 2);
    return item;
  }
}

export class InfoNode extends BaseNode {
  readonly kind: NodeKind;
  constructor(
    public readonly message: string,
    public readonly icon: string = 'info',
    kind: NodeKind = 'info'
  ) {
    super();
    this.kind = kind;
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(
      this.kind === 'error' ? 'error' : this.icon
    );
    item.contextValue = this.kind;
    return item;
  }
}

// ───────────────────────────── TreeDataProvider ─────────────────────────────

export class MongoExplorerProvider
  implements vscode.TreeDataProvider<BaseNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<BaseNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly disposable: vscode.Disposable;

  constructor(private readonly connectionManager: ConnectionManager) {
    this.disposable = this.connectionManager.onDidChange(() => this.refresh());
  }

  refresh(node?: BaseNode): void {
    this._onDidChangeTreeData.fire(node);
  }

  getTreeItem(element: BaseNode): vscode.TreeItem | Promise<vscode.TreeItem> {
    return element.getTreeItem();
  }

  getChildren(element?: BaseNode): BaseNode[] | Promise<BaseNode[]> {
    if (!element) {
      return this.connectionManager.all.map((c) => new ConnectionNode(c));
    }
    return element.getChildren();
  }

  getParent(element: BaseNode): BaseNode | undefined {
    if (element instanceof DatabasesNode) {
      return new ConnectionNode(element.connection);
    }
    if (element instanceof DatabaseNode) {
      return new DatabasesNode(element.connection);
    }
    if (element instanceof CollectionsNode) {
      return new DatabaseNode(element.connection, {
        name: element.databaseName,
        sizeOnDisk: 0,
        empty: false
      });
    }
    if (element instanceof CollectionNode) {
      return new CollectionsNode(element.connection, element.databaseName);
    }
    if (element instanceof IndexesNode || element instanceof SearchIndexesNode) {
      return new CollectionNode(element.connection, element.namespace.database, {
        name: element.namespace.collection,
        type: 'collection'
      });
    }
    return undefined;
  }

  dispose(): void {
    this.disposable.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

// ───────────────────────────── formatting helpers ─────────────────────────────

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatDirection(direction: unknown): string {
  if (direction === 1) {
    return 'asc';
  }
  if (direction === -1) {
    return 'desc';
  }
  if (direction === '2dsphere') {
    return '2dsphere';
  }
  if (direction === '2d') {
    return '2d';
  }
  if (direction === 'text') {
    return 'text';
  }
  if (direction === 'hashed') {
    return 'hashed';
  }
  return String(direction);
}

function safeHost(connectionString: string): string {
  return hostSummary(connectionString);
}

function buildConnectionTooltip(
  name: string,
  connectionString: string,
  state: string,
  topology?: { serverVersion: string; topologyType: string; isAtlas: boolean },
  error?: string,
  notes?: string,
  color?: string
): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**${name}**\n\n`);
  md.appendMarkdown(`- State: \`${state}\`\n`);
  md.appendMarkdown(`- URI: \`${redactUri(connectionString)}\`\n`);
  if (color) {
    md.appendMarkdown(`- Color: **${color}**\n`);
  }
  if (topology) {
    md.appendMarkdown(`- Server: v${topology.serverVersion} (${topology.topologyType})\n`);
    if (topology.isAtlas) {
      md.appendMarkdown(`- Deployment: **Atlas**\n`);
    }
  }
  if (error) {
    md.appendMarkdown(`- Error: ${error}\n`);
  }
  if (notes) {
    md.appendMarkdown(`\n_${notes}_\n`);
  }
  return md;
}

function connectionThemeColor(color?: string): vscode.ThemeColor | undefined {
  const colorIds: Record<string, string> = {
    green: 'charts.green',
    blue: 'charts.blue',
    red: 'charts.red',
    orange: 'charts.orange',
    purple: 'charts.purple'
  };
  const colorId = color ? colorIds[color] : undefined;
  return colorId ? new vscode.ThemeColor(colorId) : undefined;
}

function buildIndexTooltip(index: IndexInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**Index: ${index.name}**\n\n`);
  md.appendMarkdown('```json\n');
  md.appendMarkdown(JSON.stringify(index, null, 2));
  md.appendMarkdown('\n```');
  return md;
}

export function redactUri(uri: string): string {
  return redactConnectionString(uri);
}
