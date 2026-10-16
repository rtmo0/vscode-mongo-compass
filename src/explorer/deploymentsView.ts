import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { DeploymentRegistry } from '../deploy/registry';
import type { DeploymentNode, DeploymentRecord, DeploymentStatus } from '../deploy/types';
import { logger } from '../core/logger';

const PROVIDER_ICONS: Record<string, string> = {
  docker: 'package',
  local: 'server-process',
  kubernetes: 'symbol-namespace',
  atlas: 'cloud'
};

const STATE_COLORS: Record<string, string | undefined> = {
  running: 'charts.green',
  degraded: 'charts.yellow',
  stopped: undefined,
  paused: 'charts.blue',
  creating: 'charts.blue',
  updating: 'charts.blue',
  deleting: 'charts.orange',
  error: 'charts.red',
  unknown: 'charts.yellow'
};

export abstract class DeploymentTreeNode {
  abstract getTreeItem(): vscode.TreeItem;
  getChildren(): DeploymentTreeNode[] | Promise<DeploymentTreeNode[]> {
    return [];
  }
}

export class DeploymentItem extends DeploymentTreeNode {
  constructor(
    readonly record: DeploymentRecord,
    private readonly status: DeploymentStatus | Error | undefined,
    private readonly connected: boolean
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const { spec } = this.record;
    const item = new vscode.TreeItem(spec.name, vscode.TreeItemCollapsibleState.Collapsed);
    const state = this.status instanceof Error ? 'error' : this.status?.state ?? '…';
    const flavor = spec.kubernetes ? ` (${spec.kubernetes.flavor})` : spec.atlas ? ` (${spec.atlas.tier})` : '';
    item.description = `${spec.provider}${flavor} · ${spec.topology} · ${state}${this.connected ? ' · connected' : ''}`;
    item.iconPath = new vscode.ThemeIcon(PROVIDER_ICONS[spec.provider] ?? 'server', STATE_COLORS[state] ? new vscode.ThemeColor(STATE_COLORS[state] as string) : undefined);
    item.contextValue = `deployment.${spec.provider}.${state}${spec.kubernetes?.imported || spec.atlas?.imported ? '.imported' : ''}`;
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${spec.name}** — ${spec.provider}${flavor}\n\n`);
    tooltip.appendMarkdown(`- ${spec.topology}, MongoDB ${spec.version}\n`);
    if (spec.topology !== 'standalone') {
      tooltip.appendMarkdown(`- ${spec.members} members per replica set${spec.arbiter ? ' + arbiter' : ''}\n`);
    }
    if (spec.topology === 'sharded') {
      tooltip.appendMarkdown(`- ${spec.shards} shards, ${spec.configServers} config servers, ${spec.routers} routers\n`);
    }
    if (spec.kubernetes) {
      tooltip.appendMarkdown(`- ${spec.kubernetes.context} / ${spec.kubernetes.namespace} / ${spec.kubernetes.resourceName}\n`);
    }
    if (spec.docker) {
      tooltip.appendMarkdown(`- ports ${spec.docker.basePort}–${spec.docker.basePort + spec.docker.portRange - 1} on 127.0.0.1\n`);
    }
    if (this.status instanceof Error) {
      tooltip.appendMarkdown(`\n$(error) ${this.status.message}\n`);
    } else if (this.status?.message) {
      tooltip.appendMarkdown(`\n${this.status.message}\n`);
    }
    if (this.record.provisioning?.message) {
      tooltip.appendMarkdown(`\n$(error) ${this.record.provisioning.message}\n`);
    }
    tooltip.supportThemeIcons = true;
    item.tooltip = tooltip;
    return item;
  }

  override getChildren(): DeploymentTreeNode[] {
    if (this.status instanceof Error) {
      return [new MessageItem(this.status.message, 'error')];
    }
    const children: DeploymentTreeNode[] = [];
    if (this.record.provisioning?.state === 'failed') {
      children.push(new MessageItem(`Creation failed: ${this.record.provisioning.message ?? ''}`, 'error'));
    }
    if (this.status?.message) {
      children.push(new MessageItem(this.status.message, 'info'));
    }
    const nodes = this.status?.nodes ?? [];
    const sets = [...new Set(nodes.map((n) => n.replicaSet ?? ''))];
    if (sets.length > 1 || (sets.length === 1 && sets[0] && this.record.spec.topology === 'sharded')) {
      for (const set of sets) {
        const members = nodes.filter((n) => (n.replicaSet ?? '') === set);
        children.push(new GroupItem(this.record, set || 'routers', members.map((n) => new NodeItem(this.record, n))));
      }
    } else {
      children.push(...nodes.map((n) => new NodeItem(this.record, n)));
    }
    if (!nodes.length && !this.status?.message) {
      children.push(new MessageItem('No nodes', 'info'));
    }
    return children;
  }
}

class GroupItem extends DeploymentTreeNode {
  constructor(
    readonly record: DeploymentRecord,
    readonly replicaSet: string,
    private readonly children: NodeItem[]
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.replicaSet, vscode.TreeItemCollapsibleState.Expanded);
    const running = this.children.filter((c) => c.node.status === 'running').length;
    item.description = `${running}/${this.children.length} running`;
    item.iconPath = new vscode.ThemeIcon(this.replicaSet === 'routers' ? 'git-merge' : this.replicaSet === 'cfg' ? 'settings-gear' : 'layers');
    item.contextValue = this.replicaSet === 'routers' ? `deploymentGroup.${this.record.spec.provider}.routers` : `deploymentGroup.${this.record.spec.provider}.rs`;
    return item;
  }

  override getChildren(): DeploymentTreeNode[] {
    return this.children;
  }
}

export class NodeItem extends DeploymentTreeNode {
  constructor(
    readonly record: DeploymentRecord,
    readonly node: DeploymentNode
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const n = this.node;
    const item = new vscode.TreeItem(n.name, vscode.TreeItemCollapsibleState.None);
    item.description = [n.memberState, n.role !== 'mongod' && n.role !== 'pod' ? n.role : '', n.status !== 'running' ? n.status : '', n.address?.startsWith('localhost') ? n.address : '']
      .filter(Boolean)
      .join(' · ');
    const color =
      n.status === 'running'
        ? n.memberState === 'PRIMARY'
          ? 'charts.green'
          : n.memberState && !['SECONDARY', 'ARBITER'].includes(n.memberState)
            ? 'charts.yellow'
            : 'charts.blue'
        : n.status === 'error'
          ? 'charts.red'
          : n.status === 'paused'
            ? 'charts.purple'
            : 'charts.yellow';
    const icon = n.role === 'mongos' ? 'git-merge' : n.role === 'arbiter' ? 'law' : n.memberState === 'PRIMARY' ? 'star-full' : n.status === 'running' ? 'circle-filled' : n.status === 'paused' ? 'debug-pause' : 'circle-outline';
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.contextValue = `deploymentNode.${this.record.spec.provider}.${n.role}.${n.status}`;
    item.tooltip = [`${n.name} (${n.role})`, n.address, n.memberState, n.status, n.detail].filter(Boolean).join('\n');
    return item;
  }
}

class MessageItem extends DeploymentTreeNode {
  constructor(
    private readonly message: string,
    private readonly kind: 'info' | 'error'
  ) {
    super();
  }

  override getTreeItem(): vscode.TreeItem {
    const item = new vscode.TreeItem(this.message, vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(this.kind === 'error' ? 'error' : 'info', this.kind === 'error' ? new vscode.ThemeColor('charts.red') : undefined);
    item.tooltip = this.message;
    item.contextValue = 'deploymentMessage';
    return item;
  }
}

/**
 * The "Deployments" view: everything the extension created or attached, with
 * its nodes (containers, pods, processes or Atlas hosts) and their state.
 * Refreshes periodically while visible.
 */
export class DeploymentsTreeProvider implements vscode.TreeDataProvider<DeploymentTreeNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<DeploymentTreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly statuses = new Map<string, DeploymentStatus | Error>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private visible = false;
  private loading: Promise<void> | undefined;

  constructor(
    private readonly registry: DeploymentRegistry,
    private readonly connectionManager: ConnectionManager
  ) {
    this.disposables.push(
      registry.onDidChange(() => this.refresh()),
      connectionManager.onDidChange(() => this._onDidChangeTreeData.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mongoCompass.deployments.refreshIntervalSeconds')) {
          this.schedule();
        }
      })
    );
  }

  /** Track visibility so polling only runs while the view is shown. */
  attach(view: vscode.TreeView<DeploymentTreeNode>): void {
    this.visible = view.visible;
    this.disposables.push(
      view.onDidChangeVisibility((e) => {
        this.visible = e.visible;
        this.schedule();
        if (e.visible) {
          this.refresh();
        }
      })
    );
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const seconds = vscode.workspace.getConfiguration('mongoCompass.deployments').get<number>('refreshIntervalSeconds', 15);
    if (this.visible && seconds > 0) {
      this.timer = setInterval(() => this.refresh(), Math.max(5, seconds) * 1000);
    }
  }

  refresh(): void {
    this.loading = undefined;
    this._onDidChangeTreeData.fire();
  }

  status(recordId: string): DeploymentStatus | Error | undefined {
    return this.statuses.get(recordId);
  }

  private async loadStatuses(records: DeploymentRecord[]): Promise<void> {
    await Promise.all(
      records.map(async (record) => {
        try {
          const provider = this.registry.provider(record.spec.provider);
          const status = await Promise.race([
            provider.status(record),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Status timed out')), 30_000))
          ]);
          this.statuses.set(record.id, status);
        } catch (err) {
          logger.warn('Deployment status failed', { deployment: record.spec.name, error: (err as Error).message });
          this.statuses.set(record.id, err as Error);
        }
      })
    );
  }

  getTreeItem(element: DeploymentTreeNode): vscode.TreeItem {
    return element.getTreeItem();
  }

  async getChildren(element?: DeploymentTreeNode): Promise<DeploymentTreeNode[]> {
    if (element) {
      return element.getChildren();
    }
    const records = this.registry.all;
    if (!this.loading) {
      this.loading = this.loadStatuses(records);
    }
    await this.loading;
    return records.map(
      (record) =>
        new DeploymentItem(
          record,
          this.statuses.get(record.id),
          Boolean(record.connectionId && this.connectionManager.state(record.connectionId) === 'connected')
        )
    );
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this._onDidChangeTreeData.dispose();
  }
}
