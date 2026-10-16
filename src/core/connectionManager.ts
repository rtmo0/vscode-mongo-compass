import * as vscode from 'vscode';
import {
  MongoClient,
  type Document,
  type MongoClientOptions,
  type ReadPreferenceMode
} from 'mongodb';
import { parseConnectionString } from './connectionString';
import type {
  ConnectedConnection,
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
  /** In-flight connection attempts, shared by every caller of `connect`. */
  private readonly pending = new Map<string, Promise<ConnectedConnection>>();
  /** Bumped by `disconnect` so an in-flight attempt knows it was cancelled. */
  private readonly generations = new Map<string, number>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** Runs before a connection is opened, e.g. to start a port-forward and refresh its URI. */
  private beforeConnect?: (id: string) => Promise<void>;

  constructor(private readonly store: ConnectionStore) {}

  setBeforeConnect(hook: ((id: string) => Promise<void>) | undefined): void {
    this.beforeConnect = hook;
  }

  get all(): LiveConnection[] {
    return [...this.connections.values()];
  }

  get connected(): ConnectedConnection[] {
    return this.all.filter(isConnected);
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
        this.connections.set(options.id, { options, state: 'disconnected' });
      }
    }
    this._onDidChange.fire();
  }

  async listOptions(): Promise<ConnectionOptions[]> {
    return this.store.loadAll();
  }

  async addOrUpdate(options: ConnectionOptions): Promise<void> {
    await this.store.save(options);
    // Also cancels an attempt that is still connecting with the old options.
    await this.disconnect(options.id);
    this.connections.set(options.id, { options, state: 'disconnected' });
    this._onDidChange.fire();
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.connections.delete(id);
    await this.store.remove(id);
    this._onDidChange.fire();
  }

  /**
   * Connect, or join the attempt already in progress, so concurrent callers
   * share one MongoClient instead of each opening (and leaking) their own.
   */
  connect(id: string): Promise<ConnectedConnection> {
    const entry = this.connections.get(id);
    if (!entry) {
      return Promise.reject(new Error(`Unknown connection "${id}"`));
    }
    if (isConnected(entry)) {
      return Promise.resolve(entry);
    }
    const inFlight = this.pending.get(id);
    if (inFlight) {
      return inFlight;
    }
    const prepare = this.beforeConnect ? this.beforeConnect(id) : Promise.resolve();
    const attempt = prepare.then(() => {
      // The hook may have replaced the entry (e.g. with a new connection string).
      const current = this.connections.get(id);
      if (!current) {
        throw new Error(`Unknown connection "${id}"`);
      }
      return isConnected(current) ? current : this.open(id, current);
    }).finally(() => {
      if (this.pending.get(id) === attempt) {
        this.pending.delete(id);
      }
    });
    this.pending.set(id, attempt);
    return attempt;
  }

  private async open(id: string, entry: LiveConnection): Promise<ConnectedConnection> {
    const generation = this.generation(id);
    const isCurrent = (): boolean =>
      this.generation(id) === generation && this.connections.get(id) === entry;

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

    let client: MongoClient | undefined;
    try {
      // Options passed to MongoClient override the URI, so only fall back to
      // the global settings when neither the connection nor its URI sets them.
      const uriOptions = uriOptionNames(uri);
      const clientOptions: MongoClientOptions = {
        monitorCommands: false,
        appName: 'MongoDB Compass for VS Code'
      };
      if (entry.options.serverSelectionTimeoutMS !== undefined) {
        clientOptions.serverSelectionTimeoutMS = entry.options.serverSelectionTimeoutMS;
      } else if (!uriOptions.has('serverselectiontimeoutms')) {
        clientOptions.serverSelectionTimeoutMS = config.connectionTimeoutMS;
      }
      if (entry.options.readPreference) {
        clientOptions.readPreference = entry.options.readPreference;
      } else if (!uriOptions.has('readpreference')) {
        clientOptions.readPreference = config.readPreference as ReadPreferenceMode;
      }

      client = new MongoClient(uri, clientOptions);

      await client.connect();
      const topology = await readTopology(client);

      if (!isCurrent()) {
        throw new Error(`Connection to "${entry.options.name}" was cancelled`);
      }

      entry.client = client;
      entry.state = 'connected';
      entry.topology = topology;
      entry.options.lastUsed = Date.now();

      logger.info('Connected', {
        connection: entry.options.name,
        version: topology.serverVersion,
        topology: topology.topologyType
      });
      this._onDidChange.fire();

      try {
        await this.store.touch(id, entry.options.lastUsed);
      } catch (err) {
        logger.warn('Could not record last use', { connection: entry.options.name, error: (err as Error).message });
      }
      return entry as ConnectedConnection;
    } catch (err) {
      if (client && entry.client !== client) {
        await client.close(true).catch(() => undefined);
      }
      // A cancelled attempt leaves the state that `disconnect` already set.
      if (isCurrent()) {
        entry.state = 'error';
        entry.error = (err as Error).message;
        logger.error('Connection failed', { connection: entry.options.name, error: entry.error });
        this._onDidChange.fire();
      }
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const entry = this.connections.get(id);
    if (!entry) {
      return;
    }
    this.generations.set(id, this.generation(id) + 1);
    this.pending.delete(id);

    const client = entry.client;
    entry.client = undefined;
    entry.state = 'disconnected';
    entry.topology = undefined;
    this._onDidChange.fire();

    if (client) {
      try {
        await client.close(true);
      } catch (err) {
        logger.warn('Error while closing client', { error: (err as Error).message });
      }
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(this.all.map((c) => this.disconnect(c.options.id)));
  }

  /** Ensure a connection is live and return it with its MongoClient. */
  async requireClient(id: string): Promise<ConnectedConnection> {
    return this.connect(id);
  }

  /** The most recently used connected connection, used as an implicit default. */
  get activeConnection(): ConnectedConnection | undefined {
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

  private generation(id: string): number {
    return this.generations.get(id) ?? 0;
  }
}

function isConnected(entry: LiveConnection): entry is ConnectedConnection {
  return entry.state === 'connected' && entry.client !== undefined;
}

/** Lower-cased names of the options set in a connection string's query. */
function uriOptionNames(uri: string): Set<string> {
  try {
    return new Set(Object.keys(parseConnectionString(uri).options).map((key) => key.toLowerCase()));
  } catch {
    return new Set();
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
  // `me` / `primary` are `host:port`; a mongos reports neither, so fall back to the seed list.
  const hosts = [hello.me, hello.primary, ...(hello.hosts ?? [])].filter(Boolean).map(String);
  if (hosts.length === 0) {
    hosts.push(...client.options.hosts.map((h) => h.toString()));
  }
  const isAtlas = hosts.some((h) => /\.mongodb\.(net|dev)(:\d+)?$/i.test(h));

  return {
    serverVersion: version,
    topologyType: hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replicaSet' : 'standalone',
    isAtlas,
    isDataLake: Boolean(buildInfo.dataLake),
    isGenuine: !modules.includes('amazon-documentdb') && !modules.includes('cosmosdb'),
    isEnterprise: modules.includes('enterprise'),
    buildEnvironment: buildInfo.buildEnvironment as Document | undefined
  };
}
