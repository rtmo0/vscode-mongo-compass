import * as vscode from 'vscode';
import type { ConnectionManager } from '../core/connectionManager';
import type { NodeClientPool } from '../core/cluster/nodeClients';
import { logger } from '../core/logger';
import type { ConnectionOptions } from '../core/types';
import { AtlasProvider } from './atlas/atlasProvider';
import type { AtlasCredentials } from './atlas/atlasClient';
import { DockerProvider } from './docker/dockerProvider';
import { KubernetesProvider } from './kubernetes/kubernetesProvider';
import { PortForwardManager } from './kubernetes/portForward';
import { LocalProvider } from './local/localProvider';
import type { DeploymentProvider, DeploymentRecord, DeploymentSpec, ProviderContext, ProviderId } from './types';

const RECORDS_KEY = 'mongoCompass.deployments';
const PASSWORD_PREFIX = 'mongoCompass.deployment.password.';
const ATLAS_CREDENTIALS_KEY = 'mongoCompass.atlas.credentials';

/**
 * Deployments the extension created or attached, with the provider that runs
 * each one. Records live in global state, admin passwords in SecretStorage.
 * Every deployment gets a saved connection, so the explorer, the cluster
 * view and all data tools work on it like on any other server.
 */
export class DeploymentRegistry implements vscode.Disposable {
  readonly docker: DockerProvider;
  readonly local: LocalProvider;
  readonly kubernetes: KubernetesProvider;
  readonly atlas: AtlasProvider;
  readonly forwards = new PortForwardManager();

  private readonly providers: Map<ProviderId, DeploymentProvider>;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connectionManager: ConnectionManager,
    nodes: NodeClientPool
  ) {
    this.docker = new DockerProvider(() => this.all);
    this.local = new LocalProvider(() => this.all, () => context.globalStorageUri.fsPath);
    this.kubernetes = new KubernetesProvider(this.forwards);
    this.atlas = new AtlasProvider(() => this.atlasCredentials());
    const passwordHook = (record: DeploymentRecord): Promise<string | undefined> => this.password(record);
    this.docker.passwordHook = passwordHook;
    this.local.passwordHook = passwordHook;
    this.providers = new Map<ProviderId, DeploymentProvider>([
      ['docker', this.docker],
      ['local', this.local],
      ['kubernetes', this.kubernetes],
      ['atlas', this.atlas]
    ]);

    // Members of Kubernetes deployments are only reachable through port-forwards.
    this.disposables.push(
      nodes.registerResolver(async (connectionId, host) => {
        const record = this.all.find((r) => r.connectionId === connectionId);
        const provider = record ? this.provider(record.spec.provider) : undefined;
        return record && provider?.resolveHost ? provider.resolveHost(record, host) : undefined;
      }),
      nodes.registerCredentials(async (connectionId, host) => {
        const record = this.all.find((r) => r.connectionId === connectionId);
        const provider = record ? this.provider(record.spec.provider) : undefined;
        return record && provider?.credentialsFor ? provider.credentialsFor(record, host) : undefined;
      }),
      this.forwards,
      this._onDidChange
    );
  }

  get all(): DeploymentRecord[] {
    return this.context.globalState.get<DeploymentRecord[]>(RECORDS_KEY, []);
  }

  get(id: string): DeploymentRecord | undefined {
    return this.all.find((r) => r.id === id);
  }

  byConnection(connectionId: string): DeploymentRecord | undefined {
    return this.all.find((r) => r.connectionId === connectionId);
  }

  provider(id: ProviderId): DeploymentProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Unknown provider ${id}`);
    }
    return provider;
  }

  get providerList(): DeploymentProvider[] {
    return [...this.providers.values()];
  }

  refresh(): void {
    this._onDidChange.fire();
  }

  /** Persist a record (insert or replace), serialised so concurrent saves do not drop changes. */
  save(record: DeploymentRecord): Promise<void> {
    const run = this.queue.then(async () => {
      const records = this.all.filter((r) => r.id !== record.id);
      records.push(structuredClone(record));
      records.sort((a, b) => a.spec.name.localeCompare(b.spec.name));
      await this.context.globalState.update(RECORDS_KEY, records);
      this._onDidChange.fire();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private removeRecord(id: string): Promise<void> {
    const run = this.queue.then(async () => {
      await this.context.globalState.update(RECORDS_KEY, this.all.filter((r) => r.id !== id));
      await this.context.secrets.delete(PASSWORD_PREFIX + id);
      this._onDidChange.fire();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async password(record: DeploymentRecord): Promise<string | undefined> {
    return this.context.secrets.get(PASSWORD_PREFIX + record.id);
  }

  async setPassword(record: DeploymentRecord, password: string): Promise<void> {
    await this.context.secrets.store(PASSWORD_PREFIX + record.id, password);
  }

  async atlasCredentials(): Promise<AtlasCredentials | undefined> {
    const raw = await this.context.secrets.get(ATLAS_CREDENTIALS_KEY);
    return raw ? (JSON.parse(raw) as AtlasCredentials) : undefined;
  }

  async setAtlasCredentials(credentials: AtlasCredentials | undefined): Promise<void> {
    if (credentials) {
      await this.context.secrets.store(ATLAS_CREDENTIALS_KEY, JSON.stringify(credentials));
    } else {
      await this.context.secrets.delete(ATLAS_CREDENTIALS_KEY);
    }
    this._onDidChange.fire();
  }

  storageDir(record: DeploymentRecord): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'deployments', record.id);
  }

  providerContext(progress: (message: string) => void, token: vscode.CancellationToken): ProviderContext {
    return {
      progress,
      token,
      password: (record) => this.password(record),
      save: (record) => this.save(record),
      storageDir: (record) => this.storageDir(record)
    };
  }

  /** Run a provider operation with a notification showing its progress. */
  async withProgress<T>(title: string, task: (ctx: ProviderContext) => Promise<T>): Promise<T> {
    return vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (progress, token) =>
        task(
          this.providerContext((message) => {
            logger.info(`${title}: ${message}`);
            progress.report({ message });
          }, token)
        )
    );
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  /** Create a deployment and the saved connection for it. */
  async create(spec: DeploymentSpec, password: string | undefined): Promise<DeploymentRecord> {
    const record: DeploymentRecord = {
      id: `dep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      spec,
      createdAt: Date.now(),
      provisioning: { state: 'creating' }
    };
    if (password) {
      await this.setPassword(record, password);
    }
    await this.save(record);
    const provider = this.provider(spec.provider);
    try {
      await this.withProgress(`Creating ${spec.name} (${provider.label})`, (ctx) => provider.create(record, ctx));
      record.provisioning = undefined;
      await this.save(record);
      await this.ensureConnection(record);
      return record;
    } catch (err) {
      record.provisioning = { state: 'failed', message: (err as Error).message };
      await this.save(record);
      throw err;
    }
  }

  /** Register an existing deployment (Kubernetes resource, Atlas cluster) without creating anything. */
  async attach(spec: DeploymentSpec, password: string | undefined): Promise<DeploymentRecord> {
    const record: DeploymentRecord = {
      id: `dep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      spec,
      createdAt: Date.now()
    };
    if (password) {
      await this.setPassword(record, password);
    }
    await this.save(record);
    return record;
  }

  /**
   * Create or update the saved connection of a deployment. Returns its id.
   * Providers whose address changes (port-forwards) update it on every connect.
   */
  async ensureConnection(record: DeploymentRecord): Promise<string> {
    const provider = this.provider(record.spec.provider);
    const password = record.spec.auth ? await this.password(record) : undefined;
    const uri = await provider.connectionString(record, password);
    const existing = record.connectionId ? this.connectionManager.get(record.connectionId) : undefined;
    if (existing && existing.options.connectionString === uri) {
      return existing.options.id;
    }
    const options: ConnectionOptions = {
      ...(existing?.options ?? {}),
      id: existing?.options.id ?? `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: existing?.options.name ?? record.spec.name,
      connectionString: uri,
      notes: existing?.options.notes ?? `${provider.label} deployment created with MongoDB Compass for VS Code`
    };
    await this.connectionManager.addOrUpdate(options);
    if (record.connectionId !== options.id) {
      record.connectionId = options.id;
      await this.save(record);
    }
    return options.id;
  }

  /** Bring up whatever the connection needs (port-forwards) and connect. */
  async connect(record: DeploymentRecord): Promise<string> {
    const provider = this.provider(record.spec.provider);
    await provider.prepareConnection?.(record);
    const connectionId = await this.ensureConnection(record);
    await this.connectionManager.connect(connectionId);
    return connectionId;
  }

  async destroy(record: DeploymentRecord, keepData: boolean, removeConnection: boolean): Promise<void> {
    const provider = this.provider(record.spec.provider);
    if (record.connectionId) {
      await this.connectionManager.disconnect(record.connectionId);
    }
    await this.withProgress(`Destroying ${record.spec.name}`, (ctx) => provider.destroy(record, ctx, { keepData }));
    await this.forget(record, removeConnection);
  }

  /** Drop the record (and optionally its connection) but leave the deployment running. */
  async forget(record: DeploymentRecord, removeConnection: boolean): Promise<void> {
    if (record.spec.kubernetes) {
      this.forwards.stopNamespace(record.spec.kubernetes.context, record.spec.kubernetes.namespace);
    }
    if (removeConnection && record.connectionId && this.connectionManager.get(record.connectionId)) {
      await this.connectionManager.remove(record.connectionId);
    }
    await this.removeRecord(record.id);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }
}
