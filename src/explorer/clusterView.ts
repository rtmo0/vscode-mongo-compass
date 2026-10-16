import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { ClusterService } from '../core/cluster/clusterService';
import type {
  ClusterOverview,
  ReplicaMember,
  ReplicaSetInfo,
  RouterInfo,
  ShardedCollectionInfo,
  ShardInfo
} from '../core/cluster/types';
import type { LiveConnection } from '../core/types';
import { logger } from '../core/logger';

/** What a cluster command acts on; tree nodes and the cluster panel both pass one. */
export interface ClusterTarget {
  connectionId: string;
  /** Member or router `host:port`. */
  host?: string;
  /** Replica set name. */
  replicaSet?: string;
  shard?: string;
  namespace?: string;
  database?: string;
  zone?: string;
  state?: string;
}

export abstract class ClusterTreeNode {
  abstract readonly target: ClusterTarget;
  abstract getTreeItem(): vscode.TreeItem;
  getChildren(): ClusterTreeNode[] | Promise<ClusterTreeNode[]> {
    return [];
  }
}

function formatLag(member: ReplicaMember): string {
  if (member.lagSeconds === null || member.state === 'PRIMARY') {
    return '';
  }
  return member.lagSeconds === 0 ? 'in sync' : `${member.lagSeconds}s behind`;
}

function memberIcon(member: ReplicaMember): vscode.ThemeIcon {
  if (member.health !== 1) {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  switch (member.state) {
    case 'PRIMARY':
      return new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.green'));
    case 'SECONDARY':
      if (member.hidden || member.secondaryDelaySecs > 0) {
        return new vscode.ThemeIcon(member.secondaryDelaySecs > 0 ? 'history' : 'eye-closed', new vscode.ThemeColor('charts.blue'));
      }
      return new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'));
    case 'ARBITER':
      return new vscode.ThemeIcon('law');
    case 'STARTUP':
    case 'STARTUP2':
    case 'RECOVERING':
    case 'ROLLBACK':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    default:
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
  }
}

export class MemberNode extends ClusterTreeNode {
  constructor(
    readonly connectionId: string,
    readonly replicaSet: string,
    readonly member: ReplicaMember
  ) {
    super();
  }

  get target(): ClusterTarget {
    return { connectionId: this.connectionId, host: this.member.host, replicaSet: this.replicaSet, state: this.member.state };
  }

  override getTreeItem(): vscode.TreeItem {
    const m = this.member;
    const item = new vscode.TreeItem(m.host, vscode.TreeItemCollapsibleState.None);
    const flags = [
      m.hidden ? 'hidden' : '',
      m.secondaryDelaySecs ? `delay ${m.secondaryDelaySecs}s` : '',
      m.votes === 0 ? 'non-voting' : '',
      m.priority !== 1 && !m.arbiterOnly ? `p${m.priority}` : ''
    ].filter(Boolean);
    item.description = [m.health === 1 ? m.state : 'DOWN', formatLag(m), ...flags].filter(Boolean).join(' · ');
    item.iconPath = memberIcon(m);
    const kind = m.health !== 1 ? 'down' : m.state === 'PRIMARY' ? 'primary' : m.state === 'SECONDARY' ? 'secondary' : m.state === 'ARBITER' ? 'arbiter' : 'other';
    item.contextValue = `cluster.member.${kind}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${m.host}** — ${m.state}\n\n`);
    tooltip.appendMarkdown(`- health: ${m.health === 1 ? 'up' : 'down'}${m.lastHeartbeatMessage ? ` (${m.lastHeartbeatMessage})` : ''}\n`);
    tooltip.appendMarkdown(`- priority ${m.priority}, votes ${m.votes}${m.hidden ? ', hidden' : ''}${m.arbiterOnly ? ', arbiter' : ''}\n`);
    if (m.secondaryDelaySecs) {
      tooltip.appendMarkdown(`- delayed by ${m.secondaryDelaySecs}s\n`);
    }
    if (m.lagSeconds !== null && m.state !== 'PRIMARY') {
      tooltip.appendMarkdown(`- replication lag: ${m.lagSeconds}s\n`);
    }
    if (m.syncSourceHost) {
      tooltip.appendMarkdown(`- syncing from ${m.syncSourceHost}\n`);
    }
    if (m.pingMs !== undefined) {
      tooltip.appendMarkdown(`- ping ${m.pingMs} ms\n`);
    }
    if (m.uptime !== undefined) {
      tooltip.appendMarkdown(`- uptime ${Math.round(m.uptime / 60)} min\n`);
    }
    if (Object.keys(m.tags).length) {
      tooltip.appendMarkdown(`- tags: ${Object.entries(m.tags).map(([k, v]) => `${k}=${v}`).join(', ')}\n`);
    }
    item.tooltip = tooltip;
    return item;
  }
}

export class ReplicaSetNode extends ClusterTreeNode {
  constructor(
    readonly connectionId: string,
    readonly info: ReplicaSetInfo,
    private readonly label: string = info.name,
    private readonly shard?: string
  ) {
    super();
  }

  get target(): ClusterTarget {
    return {
      connectionId: this.connectionId,
      replicaSet: this.info.name,
      shard: this.shard,
      host: this.info.primary ?? this.info.members[0]?.host
    };
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.Expanded);
    if (this.info.error) {
      item.description = 'not reachable directly';
      item.tooltip = this.info.error;
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'));
      item.collapsibleState = vscode.TreeItemCollapsibleState.None;
      item.contextValue = this.shard ? 'cluster.shard' : 'cluster.rs.unreachable';
      return item;
    }
    const healthy = this.info.members.filter((m) => m.health === 1).length;
    const oplog = this.info.oplog?.windowHours !== undefined && this.info.oplog.windowHours !== null ? ` · oplog ${this.info.oplog.windowHours}h` : '';
    item.description = `${this.label !== this.info.name ? `${this.info.name} · ` : ''}${healthy}/${this.info.members.length} healthy${this.info.term !== undefined ? ` · term ${this.info.term}` : ''}${oplog}`;
    item.iconPath = new vscode.ThemeIcon(this.info.configsvr ? 'settings-gear' : 'layers', this.info.primary ? undefined : new vscode.ThemeColor('charts.red'));
    item.contextValue = this.shard ? 'cluster.shard' : 'cluster.rs';
    item.tooltip = `${this.info.name}\nprimary: ${this.info.primary ?? 'none'}\nconfig version ${this.info.configVersion ?? '?'}`;
    return item;
  }

  override getChildren(): ClusterTreeNode[] {
    return this.info.members.map((m) => new MemberNode(this.connectionId, this.info.name, m));
  }
}

class ShardNode extends ReplicaSetNode {
  constructor(connectionId: string, readonly shardInfo: ShardInfo) {
    super(
      connectionId,
      shardInfo.replicaSet ?? { name: shardInfo.replicaSetName ?? shardInfo.id, members: [], configsvr: false, error: 'not loaded' },
      shardInfo.id,
      shardInfo.id
    );
  }

  override getTreeItem(): vscode.TreeItem {
    const item = super.getTreeItem();
    const extra = [this.shardInfo.draining ? 'DRAINING' : '', this.shardInfo.zones.length ? `zones: ${this.shardInfo.zones.join(', ')}` : ''].filter(Boolean);
    if (extra.length) {
      item.description = `${item.description ?? ''} · ${extra.join(' · ')}`;
    }
    if (this.shardInfo.draining) {
      item.iconPath = new vscode.ThemeIcon('debug-step-out', new vscode.ThemeColor('charts.orange'));
    }
    return item;
  }

  override getChildren(): ClusterTreeNode[] {
    if (this.shardInfo.replicaSet?.error || !this.shardInfo.replicaSet) {
      return this.shardInfo.hosts.map((host) => new InfoNode(this.connectionId, host, 'unknown state', 'server'));
    }
    return super.getChildren();
  }
}

class RouterNode extends ClusterTreeNode {
  constructor(
    readonly connectionId: string,
    readonly router: RouterInfo
  ) {
    super();
  }

  get target(): ClusterTarget {
    return { connectionId: this.connectionId, host: this.router.host };
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.router.host, vscode.TreeItemCollapsibleState.None);
    item.description = [this.router.version ? `v${this.router.version}` : '', this.router.stale ? 'stale' : 'up', this.router.upSeconds ? `${Math.round(this.router.upSeconds / 60)} min` : '']
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon('git-merge', this.router.stale ? new vscode.ThemeColor('charts.yellow') : new vscode.ThemeColor('charts.green'));
    item.contextValue = 'cluster.router';
    item.tooltip = `mongos ${this.router.host}\nlast ping ${this.router.ping ?? 'never'}`;
    return item;
  }
}

class CollectionNode extends ClusterTreeNode {
  constructor(
    readonly connectionId: string,
    readonly collection: ShardedCollectionInfo
  ) {
    super();
  }

  get target(): ClusterTarget {
    const [database] = this.collection.namespace.split('.');
    return { connectionId: this.connectionId, namespace: this.collection.namespace, database };
  }

  override getTreeItem(): vscode.TreeItem {
    const c = this.collection;
    const item = new vscode.TreeItem(c.namespace, vscode.TreeItemCollapsibleState.None);
    const shards = Object.entries(c.chunksByShard).map(([shard, n]) => `${shard}:${n}`).join(' ');
    item.description = `${JSON.stringify(c.key)} · ${c.totalChunks} chunks${shards ? ` (${shards})` : ''}${c.balancingEnabled ? '' : ' · balancing off'}`;
    item.iconPath = new vscode.ThemeIcon('split-horizontal');
    item.contextValue = `cluster.shardedCollection.${c.balancingEnabled ? 'balanced' : 'unbalanced'}`;
    item.tooltip = `${c.namespace}\nshard key ${JSON.stringify(c.key)}${c.unique ? ' (unique)' : ''}\n${shards}`;
    return item;
  }
}

class GroupNode extends ClusterTreeNode {
  constructor(
    readonly target: ClusterTarget,
    private readonly label: string,
    private readonly icon: string,
    private readonly children: ClusterTreeNode[],
    private readonly contextValue: string,
    private readonly description?: string,
    private readonly expanded = true
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, this.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    item.iconPath = new vscode.ThemeIcon(this.icon);
    item.contextValue = this.contextValue;
    item.description = this.description ?? String(this.children.length);
    return item;
  }

  override getChildren(): ClusterTreeNode[] {
    return this.children;
  }
}

class InfoNode extends ClusterTreeNode {
  constructor(
    readonly connectionId: string,
    private readonly label: string,
    private readonly description: string,
    private readonly icon: string,
    private readonly color?: string,
    private readonly contextValue = 'cluster.info'
  ) {
    super();
  }

  get target(): ClusterTarget {
    return { connectionId: this.connectionId };
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.label, vscode.TreeItemCollapsibleState.None);
    item.description = this.description;
    item.tooltip = `${this.label}${this.description ? `\n${this.description}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(this.icon, this.color ? new vscode.ThemeColor(this.color) : undefined);
    item.contextValue = this.contextValue;
    return item;
  }
}

export class ClusterRootNode extends ClusterTreeNode {
  constructor(
    readonly connection: LiveConnection,
    private readonly cluster: ClusterService,
    private readonly cache: Map<string, ClusterOverview | Error>
  ) {
    super();
  }

  get target(): ClusterTarget {
    return { connectionId: this.connection.options.id };
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.connection.options.name, vscode.TreeItemCollapsibleState.Expanded);
    const cached = this.cache.get(this.connection.options.id);
    const kind = this.connection.topology?.topologyType ?? 'unknown';
    item.description = cached instanceof Error ? 'error' : cached ? `${cached.kind} · v${cached.serverVersion}${cached.featureCompatibilityVersion ? ` · FCV ${cached.featureCompatibilityVersion}` : ''}` : kind;
    item.iconPath = new vscode.ThemeIcon(kind === 'sharded' ? 'type-hierarchy' : kind === 'replicaSet' ? 'layers' : 'server');
    item.contextValue = `cluster.root.${kind}`;
    item.tooltip = 'Click the dashboard icon for the cluster overview';
    return item;
  }

  override async getChildren(): Promise<ClusterTreeNode[]> {
    const id = this.connection.options.id;
    let overview = this.cache.get(id);
    if (!overview) {
      try {
        overview = await this.cluster.overview(id);
      } catch (err) {
        overview = err as Error;
        logger.warn('Cluster overview failed', { connection: this.connection.options.name, error: (err as Error).message });
      }
      this.cache.set(id, overview);
    }
    if (overview instanceof Error) {
      return [new InfoNode(id, overview.message, '', 'error', 'charts.red')];
    }

    const nodes: ClusterTreeNode[] = [];
    if (overview.warnings.length) {
      nodes.push(
        new GroupNode(
          { connectionId: id },
          'Warnings',
          'warning',
          overview.warnings.map((w) => new InfoNode(id, w, '', 'warning', 'charts.yellow')),
          'cluster.warnings',
          undefined,
          false
        )
      );
    }
    if (overview.kind === 'standalone') {
      nodes.push(new InfoNode(id, overview.host ?? 'standalone server', 'standalone — no replication or failover', 'server'));
      return nodes;
    }
    if (overview.kind === 'replicaSet' && overview.replicaSet) {
      nodes.push(new ReplicaSetNode(id, overview.replicaSet));
      return nodes;
    }
    const sharding = overview.sharding;
    if (!sharding) {
      return nodes;
    }
    const balancer = sharding.balancer;
    nodes.push(
      new InfoNode(
        id,
        'Balancer',
        balancer.error ? balancer.error : `${balancer.running ? 'running' : 'stopped'}${balancer.inBalancerRound ? ' · balancing now' : ''}${balancer.window ? ` · window ${balancer.window.start}–${balancer.window.stop}` : ''}`,
        balancer.running ? 'debug-start' : 'debug-pause',
        balancer.running ? 'charts.green' : 'charts.yellow',
        `cluster.balancer.${balancer.running ? 'running' : 'stopped'}`
      )
    );
    nodes.push(new GroupNode({ connectionId: id }, 'Routers', 'git-merge', sharding.routers.map((r) => new RouterNode(id, r)), 'cluster.routers', undefined, false));
    if (sharding.configServers) {
      nodes.push(new ReplicaSetNode(id, sharding.configServers, 'Config servers'));
    }
    nodes.push(new GroupNode({ connectionId: id }, 'Shards', 'database', sharding.shards.map((s) => new ShardNode(id, s)), 'cluster.shards'));
    nodes.push(
      new GroupNode(
        { connectionId: id },
        'Sharded collections',
        'split-horizontal',
        sharding.collections.length ? sharding.collections.map((c) => new CollectionNode(id, c)) : [new InfoNode(id, 'No sharded collections', '', 'info')],
        'cluster.collections',
        String(sharding.collections.length),
        false
      )
    );
    return nodes;
  }
}

/** The "Cluster" view: topology, members, shards and routers of every connected deployment. */
export class ClusterTreeProvider implements vscode.TreeDataProvider<ClusterTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<ClusterTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly cache = new Map<string, ClusterOverview | Error>();
  private readonly subscription: vscode.Disposable;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly cluster: ClusterService
  ) {
    this.subscription = connectionManager.onDidChange(() => this.refresh());
  }

  /** Reload the topology (all connections, or one). */
  refresh(connectionId?: string): void {
    if (connectionId) {
      this.cache.delete(connectionId);
    } else {
      this.cache.clear();
    }
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: ClusterTreeNode): vscode.TreeItem {
    return element.getTreeItem();
  }

  getChildren(element?: ClusterTreeNode): ClusterTreeNode[] | Promise<ClusterTreeNode[]> {
    if (element) {
      return element.getChildren();
    }
    return this.connectionManager.connected.map((c) => new ClusterRootNode(c, this.cluster, this.cache));
  }

  dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }
}
