import * as vscode from 'vscode';
import type { ConnectionManager } from '../connectionManager';
import { logger } from '../logger';
import type { ClusterService } from './clusterService';

interface SetState {
  primary?: string;
  unhealthy: Set<string>;
  lagging: Set<string>;
}

export interface ClusterHealthSummary {
  connectionId: string;
  sets: number;
  members: number;
  healthy: number;
  problems: string[];
}

/**
 * Polls the replica sets of every connected cluster and reports what changed:
 * elections (a new primary), members that go down or come back, and
 * secondaries that fall behind. A status bar item summarises the health of
 * the active connection.
 */
export class ClusterMonitor implements vscode.Disposable {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly sets = new Map<string, SetState>();
  private readonly summaries = new Map<string, ClusterHealthSummary>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly _onDidUpdate = new vscode.EventEmitter<void>();
  readonly onDidUpdate = this._onDidUpdate.event;

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly cluster: ClusterService
  ) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.statusItem.command = 'mongoCompass.showClusterOverview';
    this.disposables.push(
      this.statusItem,
      this._onDidUpdate,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mongoCompass.cluster')) {
          this.schedule();
        }
      }),
      connectionManager.onDidChange(() => {
        for (const key of [...this.sets.keys()]) {
          if (connectionManager.state(key.split('|')[0]) !== 'connected') {
            this.sets.delete(key);
          }
        }
        for (const id of [...this.summaries.keys()]) {
          if (connectionManager.state(id) !== 'connected') {
            this.summaries.delete(id);
          }
        }
        this.renderStatus();
      })
    );
    this.schedule();
  }

  summary(connectionId: string): ClusterHealthSummary | undefined {
    return this.summaries.get(connectionId);
  }

  /** Check now instead of waiting for the next tick. */
  async checkNow(): Promise<void> {
    await this.tick();
  }

  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    const seconds = vscode.workspace.getConfiguration('mongoCompass.cluster').get<number>('monitorIntervalSeconds', 30);
    if (seconds > 0) {
      this.timer = setInterval(() => void this.tick(), Math.max(5, seconds) * 1000);
      void this.tick();
    } else {
      this.summaries.clear();
      this.renderStatus();
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const config = vscode.workspace.getConfiguration('mongoCompass.cluster');
      const lagThreshold = config.get<number>('lagWarningSeconds', 30);
      const notify = config.get<boolean>('notifications', true);
      for (const connection of this.connectionManager.connected) {
        const kind = connection.topology?.topologyType;
        if (kind !== 'replicaSet' && kind !== 'sharded') {
          continue;
        }
        try {
          const sets = await this.cluster.health(connection.options.id);
          const summary: ClusterHealthSummary = { connectionId: connection.options.id, sets: sets.length, members: 0, healthy: 0, problems: [] };
          for (const set of sets) {
            this.inspectSet(connection.options.name, connection.options.id, set, lagThreshold, notify, summary);
          }
          this.summaries.set(connection.options.id, summary);
        } catch (err) {
          logger.warn('Cluster health check failed', { connection: connection.options.name, error: (err as Error).message });
        }
      }
      this.renderStatus();
      this._onDidUpdate.fire();
    } finally {
      this.running = false;
    }
  }

  private inspectSet(
    connectionName: string,
    connectionId: string,
    set: Awaited<ReturnType<ClusterService['health']>>[number],
    lagThreshold: number,
    notify: boolean,
    summary: ClusterHealthSummary
  ): void {
    if (set.error) {
      summary.problems.push(`${set.name}: ${set.error}`);
      return;
    }
    const key = `${connectionId}|${set.name}`;
    const previous = this.sets.get(key);
    const next: SetState = { primary: set.primary, unhealthy: new Set(), lagging: new Set() };
    const label = `${connectionName} · ${set.name}`;
    const show = (message: string, warning: boolean): void => {
      logger[warning ? 'warn' : 'info'](message);
      if (notify) {
        void (warning ? vscode.window.showWarningMessage(message) : vscode.window.showInformationMessage(message));
      }
    };

    for (const member of set.members) {
      summary.members += 1;
      const healthy = member.health === 1 && ['PRIMARY', 'SECONDARY', 'ARBITER'].includes(member.state);
      if (healthy) {
        summary.healthy += 1;
      } else {
        next.unhealthy.add(member.host);
        summary.problems.push(`${set.name}: ${member.host} is ${member.health === 1 ? member.state : 'unreachable'}`);
      }
      if (member.lagSeconds !== null && member.secondaryDelaySecs === 0 && member.lagSeconds > lagThreshold) {
        next.lagging.add(member.host);
        summary.problems.push(`${set.name}: ${member.host} is ${member.lagSeconds}s behind`);
      }
    }
    if (!set.primary) {
      summary.problems.push(`${set.name}: no primary`);
    }

    if (previous) {
      if (previous.primary !== set.primary) {
        if (set.primary) {
          show(`${label}: ${set.primary} is the new primary${previous.primary ? ` (was ${previous.primary})` : ''}.`, false);
        } else {
          show(`${label}: the replica set lost its primary.`, true);
        }
      }
      for (const host of next.unhealthy) {
        if (!previous.unhealthy.has(host)) {
          show(`${label}: ${host} is down or not healthy.`, true);
        }
      }
      for (const host of previous.unhealthy) {
        if (!next.unhealthy.has(host)) {
          show(`${label}: ${host} is healthy again.`, false);
        }
      }
      for (const host of next.lagging) {
        if (!previous.lagging.has(host)) {
          show(`${label}: ${host} is more than ${lagThreshold}s behind the primary.`, true);
        }
      }
    }
    this.sets.set(key, next);
  }

  private renderStatus(): void {
    const active = this.connectionManager.activeConnection;
    const summary = active ? this.summaries.get(active.options.id) : undefined;
    if (!summary || summary.members === 0) {
      this.statusItem.hide();
      return;
    }
    const ok = summary.problems.length === 0;
    this.statusItem.text = `$(${ok ? 'server-environment' : 'warning'}) ${summary.healthy}/${summary.members}`;
    this.statusItem.backgroundColor = ok ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
    this.statusItem.tooltip = ok
      ? `Cluster healthy: ${summary.healthy} of ${summary.members} members in ${summary.sets} replica set(s).\nClick for the cluster overview.`
      : `Cluster problems:\n${summary.problems.join('\n')}\n\nClick for the cluster overview.`;
    this.statusItem.show();
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
