import * as vscode from 'vscode';
import { EJSON, type Document } from 'bson';
import { BaseWebviewPanel } from './baseWebview';
import type { ConnectionManager } from '../core/connectionManager';
import type { ClusterService } from '../core/cluster/clusterService';
import { parseShellBSON } from '../core/bsonParser';
import type { ClusterTarget } from '../explorer/clusterView';

/**
 * Cluster overview dashboard: topology diagram, replica set members with
 * their actions, sharding (balancer, collections, chunk/data distribution,
 * zones), users and roles, and a guarded replica set config editor.
 *
 * Member, shard and balancer actions run the same commands as the Cluster
 * view's context menus, so the safety checks and prompts are shared.
 */
export class ClusterPanel extends BaseWebviewPanel {
  protected get panelKey(): string {
    return `cluster:${this.connectionId}`;
  }

  protected get title(): string {
    return `Cluster — ${this.connectionManager.get(this.connectionId)?.options.name ?? 'MongoDB'}`;
  }

  protected get webviewName(): string {
    return 'cluster';
  }

  static open(
    extensionUri: vscode.Uri,
    connectionManager: ConnectionManager,
    cluster: ClusterService,
    connectionId: string,
    tab?: string
  ): ClusterPanel {
    return new ClusterPanel(extensionUri, connectionManager, cluster, connectionId, tab);
  }

  private constructor(
    extensionUri: vscode.Uri,
    private readonly connectionManager: ConnectionManager,
    private readonly cluster: ClusterService,
    private readonly connectionId: string,
    private readonly initialTab?: string
  ) {
    super(extensionUri);
    if (this.initializePanel(vscode.ViewColumn.Active)) {
      // Read the cluster while the webview is still loading.
      this.initialLoad = this.load();
      this.initialLoad.catch(() => undefined);
    }
    this.registerHandlers();
  }

  private initialLoad?: Promise<unknown>;

  protected override onPanelReused(): void {
    this.post('select', { tab: this.initialTab });
  }

  private async load(): Promise<unknown> {
    const overview = await this.cluster.overview(this.connectionId);
    return JSON.parse(EJSON.stringify(overview, { relaxed: true }));
  }

  private registerHandlers(): void {
    this.registerHandler('ready', async (_msg, respond) => {
      const pending = this.initialLoad ?? this.load();
      this.initialLoad = undefined;
      try {
        respond({ data: await pending, tab: this.initialTab });
      } catch (err) {
        respond({ error: (err as Error).message, tab: this.initialTab });
      }
    });

    this.registerHandler('refresh', async (_msg, respond) => {
      respond({ data: await this.load() });
    });

    /** Run a cluster command; it shows its own prompts and confirmations. */
    this.registerHandler('action', async (msg, respond) => {
      const payload = msg.payload as { command: string; target: Partial<ClusterTarget> };
      if (!payload.command.startsWith('mongoCompass.cluster.')) {
        throw new Error(`Unknown action ${payload.command}`);
      }
      await vscode.commands.executeCommand(payload.command, { ...payload.target, connectionId: this.connectionId });
      respond({ ok: true });
    });

    this.registerHandler('getConfig', async (msg, respond) => {
      const payload = msg.payload as { host?: string };
      const { client } = await this.cluster.replicaSetFor(this.connectionId, payload.host);
      const { config } = await client.db('admin').command({ replSetGetConfig: 1 });
      respond({ text: EJSON.stringify(config, undefined, 2, { relaxed: true }) });
    });

    this.registerHandler('previewConfig', async (msg, respond) => {
      const payload = msg.payload as { host?: string; text: string };
      const edited = this.parseConfig(payload.text);
      const plan = await this.cluster.planReconfig(this.connectionId, () => edited, payload.host);
      respond({ report: plan.report, version: plan.next.version });
    });

    this.registerHandler('applyConfig', async (msg, respond) => {
      const payload = msg.payload as { host?: string; text: string; force: boolean };
      const edited = this.parseConfig(payload.text);
      const plan = await this.cluster.planReconfig(this.connectionId, () => edited, payload.host);
      if (plan.report.errors.length && !payload.force) {
        throw new Error(plan.report.errors.join(' '));
      }
      const answer = await vscode.window.showWarningMessage(
        `Apply replica set config version ${plan.next.version}${payload.force ? ' with force: true' : ''}?`,
        {
          modal: true,
          detail: [...plan.report.errors.map((e) => `✖ ${e}`), ...plan.report.warnings.map((w) => `⚠ ${w}`)].join('\n') || 'All checks passed.'
        },
        'Apply'
      );
      if (answer !== 'Apply') {
        respond({ cancelled: true });
        return;
      }
      await this.cluster.applyReconfig(this.connectionId, plan.next, { force: payload.force, host: payload.host });
      respond({ ok: true });
    });

    // ── users ──
    this.registerHandler('listUsers', async (_msg, respond) => {
      respond({ users: await this.cluster.listUsers(this.connectionId) });
    });

    this.registerHandler('listRoles', async (msg, respond) => {
      const payload = msg.payload as { db: string };
      respond({ roles: await this.cluster.listRoles(this.connectionId, payload.db || 'admin') });
    });

    this.registerHandler('createUser', async (msg, respond) => {
      const p = msg.payload as { db: string; user: string; password: string; roles: Array<{ role: string; db: string }> };
      if (!p.user || !p.password) {
        throw new Error('User name and password are required.');
      }
      await this.cluster.createUser(this.connectionId, p.db || 'admin', p.user, p.password, p.roles);
      respond({ ok: true });
    });

    this.registerHandler('dropUser', async (msg, respond) => {
      const p = msg.payload as { db: string; user: string };
      const answer = await vscode.window.showWarningMessage(`Drop user ${p.user}@${p.db}?`, { modal: true }, 'Drop');
      if (answer !== 'Drop') {
        respond({ cancelled: true });
        return;
      }
      await this.cluster.dropUser(this.connectionId, p.db, p.user);
      respond({ ok: true });
    });

    this.registerHandler('changePassword', async (msg, respond) => {
      const p = msg.payload as { db: string; user: string };
      const password = await vscode.window.showInputBox({ prompt: `New password for ${p.user}@${p.db}`, password: true, validateInput: (v) => (v ? null : 'Required') });
      if (!password) {
        respond({ cancelled: true });
        return;
      }
      await this.cluster.changePassword(this.connectionId, p.db, p.user, password);
      respond({ ok: true });
    });

    this.registerHandler('grantRoles', async (msg, respond) => {
      const p = msg.payload as { db: string; user: string; roles: Array<{ role: string; db: string }>; revoke?: boolean };
      if (p.revoke) {
        await this.cluster.revokeRoles(this.connectionId, p.db, p.user, p.roles);
      } else {
        await this.cluster.grantRoles(this.connectionId, p.db, p.user, p.roles);
      }
      respond({ ok: true });
    });

    // ── sharding forms ──
    this.registerHandler('zoneRange', async (msg, respond) => {
      const p = msg.payload as { namespace: string; min: string; max: string; zone: string | null };
      await this.cluster.updateZoneKeyRange(this.connectionId, p.namespace, parseDocument(p.min), parseDocument(p.max), p.zone);
      respond({ ok: true });
    });

    this.registerHandler('moveRange', async (msg, respond) => {
      const p = msg.payload as { namespace: string; min: string; toShard: string };
      const result = await this.cluster.moveRange(this.connectionId, p.namespace, parseDocument(p.min), p.toShard);
      respond({ result: EJSON.stringify(result, { relaxed: true }) });
    });

    this.registerHandler('split', async (msg, respond) => {
      const p = msg.payload as { namespace: string; middle: string };
      await this.cluster.splitAt(this.connectionId, p.namespace, parseDocument(p.middle));
      respond({ ok: true });
    });
  }

  private parseConfig(text: string): Document {
    return parseDocument(text);
  }
}

/** Extended JSON (what the panel shows, e.g. `{"$minKey": 1}`) or mongosh syntax (what users type). */
function parseDocument(text: string): Document {
  try {
    return EJSON.parse(text, { relaxed: true }) as Document;
  } catch {
    return parseShellBSON(text);
  }
}
