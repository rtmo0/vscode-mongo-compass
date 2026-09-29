import * as vscode from 'vscode';
import { MongoClient, type Document, type ReadPreferenceMode } from 'mongodb';
import type {
  ConnectionOptions,
  ConnectionState,
  LiveConnection,
  TopologyInfo
} from './types';
import { ConnectionStore } from './connectionStore';
import { getConfig } from './config';
import { logger } from './logger';

export class ConnectionManager {
  private readonly connections = new Map<string, LiveConnection>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  constructor(private readonly store: ConnectionStore) {}

  get all(): LiveConnection[] {
    return [...this.connections.values()];
  }

  get connected(): LiveConnection[] {
    return this.all.filter((c) => c.state === 'connected');
  }

  get(id: string): LiveConnection | undefined {
    return this.connections.get(id);
  }

  state(id: string): ConnectionState {
    return this.connections.get(id)?.state ?? 'disconnected';
  }

  /** Load persisted connections into memory (without connecting). */
  async hydrate(): Promise<void> {
    const saved = await this.store.loadAll();
    for (const options of saved) {
      if (!this.connections.has(options.id)) {
        this.connections.set(options.id, { options, client: undefined as never, state: 'disconnected' });
      }
    }
    this._onDidChange.fire();
  }

  async listOptions(): Promise<ConnectionOptions[]> {
    return this.store.loadAll();
  }

  async addOrUpdate(options: ConnectionOptions): Promise<void> {
    await this.store.save(options);
    const existing = this.connections.get(options.id);
    if (existing && existing.state === 'connected') {
      await this.disconnect(options.id);
    }
    this.connections.set(options.id, { options, client: undefined as never, state: 'disconnected' });
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.connections.delete(id);
    await this.store.remove(id);
    this._onDidChange.fire();
  }

  async connect(id: string): Promise<LiveConnection> {
    const entry = this.connections.get(id);
    if (!entry) {
      throw new Error(`Unknown connection "${id}"`);
    }
    if (entry.state === 'connected' && entry.client) {
      return entry;
    }

    entry.state = 'connecting';
    entry.error = undefined;
    this._onDidChange.fire();

    const config = getConfig();
    const uri = entry.options.connectionString;
    if (!uri) {
      entry.state = 'error';
      entry.error = 'Connection string is empty';
      this._onDidChange.fire();
      throw new Error(entry.error);
    }

    try {
      const client = new MongoClient(uri, {
        serverSelectionTimeoutMS:
          entry.options.serverSelectionTimeoutMS ?? config.connectionTimeoutMS,
        readPreference: (entry.options.readPreference ?? config.readPreference) as ReadPreferenceMode,
        monitorCommands: false,
        directConnection: false,
        appName: 'MongoDB Compass for VS Code'
      });

      await client.connect();
      const topology = await readTopology(client);

      entry.client = client;
      entry.state = 'connected';
      entry.topology = topology;
      entry.options.lastUsed = Date.now();
      await this.store.save(entry.options);

      logger.info('Connected', {
        connection: entry.options.name,
        version: topology.serverVersion,
        topology: topology.topologyType
      });
      this._onDidChange.fire();
      return entry;
    } catch (err) {
      entry.state = 'error';
      entry.error = (err as Error).message;
      logger.error('Connection failed', { connection: entry.options.name, error: entry.error });
      this._onDidChange.fire();
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.connections.get(id);
    if (!entry) {
      return;
    }
    if (entry.client) {
      try {
        await entry.client.close(true);
      } catch (err) {
        logger.warn('Error while closing client', { error: (err as Error).message });
      }
    }
    entry.client = undefined as never;
    entry.state = 'disconnected';
    entry.topology = undefined;
    this._onDidChange.fire();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.all.map((c) => this.disconnect(c.options.id)));
  }

  /** Ensure a connection is live and return its MongoClient. */
  async requireClient(id: string): Promise<LiveConnection> {
    const entry = this.connections.get(id);
    if (!entry) {
      throw new Error(`Unknown connection "${id}"`);
    }
    if (entry.state !== 'connected' || !entry.client) {
      return this.connect(id);
    }
    return entry;
  }

  /** The most recently used connected connection, used as an implicit default. */
  get activeConnection(): LiveConnection | undefined {
    const connected = this.connected;
    if (connected.length === 0) {
      return undefined;
    }
    return connected.sort((a, b) => (b.options.lastUsed ?? 0) - (a.options.lastUsed ?? 0))[0];
  }

  dispose(): void {
    void this.disconnectAll();
    this._onDidChange.dispose();
  }
}

async function readTopology(client: MongoClient): Promise<TopologyInfo> {
  const admin = client.db('admin');
  let buildInfo: Document = {};
  try {
    buildInfo = await admin.command({ buildInfo: 1 });
  } catch (err) {
    logger.warn('buildInfo failed', { error: (err as Error).message });
  }

  let hello: Document = {};
  try {
    hello = await admin.command({ hello: 1 });
  } catch {
    try {
      hello = await admin.command({ isMaster: 1 });
    } catch (err) {
      logger.warn('hello/isMaster failed', { error: (err as Error).message });
    }
  }

  const version = String(buildInfo.version ?? hello.maxWireVersion ?? 'unknown');
  const modules = (buildInfo.modules ?? []) as string[];
  const isAtlas = /\.mongodb\.net$/i.test(String(hello.me ?? hello.primary ?? '')) ||
    /\.mongodb\.dev$/i.test(String(hello.me ?? hello.primary ?? ''));

  return {
    serverVersion: version,
    topologyType: String(hello.msg ?? (hello.setName ? 'replicaSet' : hello.hosts ? 'sharded' : 'standalone')),
    isAtlas,
    isDataLake: Boolean(buildInfo.dataLake),
    isGenuine: !modules.includes('amazon-documentdb') && !modules.includes('cosmosdb'),
    isEnterprise: modules.includes('enterprise'),
    buildEnvironment: buildInfo.buildEnvironment as Document | undefined
  };
}
