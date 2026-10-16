import * as vscode from 'vscode';
import { MongoClient } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import type { ConnectionManager } from '../connectionManager';
import { logger } from '../logger';

/**
 * Maps a member host as the cluster knows it (e.g. a Kubernetes pod DNS name)
 * to an address this machine can reach (e.g. a `kubectl port-forward`).
 * Returns `undefined` when it does not handle the host.
 */
export type HostResolver = (connectionId: string, host: string) => Promise<string | undefined> | string | undefined;

/**
 * Credentials to use for one member instead of the connection's own, e.g. a
 * shard-local user for shards that do not know the cluster-wide users.
 */
export type CredentialResolver = (connectionId: string, host: string) => Promise<{ username: string; password: string } | undefined> | undefined;

/** Options that only make sense for the seed list of the original connection. */
const SEED_ONLY_OPTIONS = ['replicaset', 'directconnection', 'srvservicename', 'srvmaxhosts', 'loadbalanced'];

/**
 * Build a connection string that reuses the credentials and TLS/auth options of
 * `baseUri` but points at `hosts`. SRV URIs are turned into a plain seed list,
 * keeping the defaults SRV implies (TLS on, `authSource=admin`).
 */
export function connectionStringForHosts(baseUri: string, hosts: string[], direct: boolean): string {
  const source = new ConnectionString(baseUri.trim());
  const target = new ConnectionString('mongodb://localhost');
  target.username = source.username;
  target.password = source.password;
  target.pathname = source.pathname || '/';
  const present = new Set<string>();
  for (const [key, value] of source.searchParams.entries()) {
    if (SEED_ONLY_OPTIONS.includes(key.toLowerCase())) {
      continue;
    }
    present.add(key.toLowerCase());
    target.searchParams.set(key, value);
  }
  if (source.isSRV) {
    if (!present.has('tls') && !present.has('ssl')) {
      target.searchParams.set('tls', 'true');
    }
    if (!present.has('authsource') && source.username) {
      target.searchParams.set('authSource', 'admin');
    }
  }
  if (direct) {
    target.searchParams.set('directConnection', 'true');
  }
  target.hosts = hosts;
  return target.toString();
}

/**
 * Direct connections to individual cluster members.
 *
 * A connection to a replica set or a mongos only ever talks to the primary or
 * the router; per-node commands (`replSetFreeze`, `replSetMaintenance`,
 * `serverStatus` of a secondary, `replSetGetStatus` of a shard, …) need their
 * own `directConnection=true` client. Clients are cached per connection and
 * closed when that connection goes away.
 */
export class NodeClientPool implements vscode.Disposable {
  private readonly clients = new Map<string, Promise<MongoClient>>();
  /** `connectionId|sorted hosts` → the member of that set that last answered `anyMember`. */
  private readonly lastReachable = new Map<string, string>();
  private readonly resolvers = new Set<HostResolver>();
  private readonly credentialResolvers = new Set<CredentialResolver>();
  private readonly subscription: vscode.Disposable;

  constructor(private readonly connectionManager: ConnectionManager) {
    this.subscription = connectionManager.onDidChange(() => {
      for (const key of [...this.clients.keys()]) {
        const connectionId = key.split('|')[0];
        if (this.connectionManager.state(connectionId) !== 'connected') {
          void this.closeKey(key);
        }
      }
    });
  }

  registerResolver(resolver: HostResolver): vscode.Disposable {
    this.resolvers.add(resolver);
    return new vscode.Disposable(() => this.resolvers.delete(resolver));
  }

  registerCredentials(resolver: CredentialResolver): vscode.Disposable {
    this.credentialResolvers.add(resolver);
    return new vscode.Disposable(() => this.credentialResolvers.delete(resolver));
  }

  private async credentialsFor(connectionId: string, host: string): Promise<{ username: string; password: string } | undefined> {
    for (const resolver of this.credentialResolvers) {
      try {
        const credentials = await resolver(connectionId, host);
        if (credentials) {
          return credentials;
        }
      } catch (err) {
        logger.warn('Credential resolver failed', { host, error: (err as Error).message });
      }
    }
    return undefined;
  }

  /** The address to use for `host`, after any registered resolver. */
  async resolve(connectionId: string, host: string): Promise<string> {
    for (const resolver of this.resolvers) {
      try {
        const mapped = await resolver(connectionId, host);
        if (mapped) {
          return mapped;
        }
      } catch (err) {
        logger.warn('Host resolver failed', { host, error: (err as Error).message });
      }
    }
    return host;
  }

  /** A client connected straight to one member (`directConnection=true`). */
  async direct(connectionId: string, host: string): Promise<MongoClient> {
    const key = `${connectionId}|${host}`;
    let pending = this.clients.get(key);
    if (!pending) {
      pending = this.open(connectionId, host);
      this.clients.set(key, pending);
      pending.catch(() => {
        if (this.clients.get(key) === pending) {
          this.clients.delete(key);
        }
      });
    }
    return pending;
  }

  /**
   * The first member of `hosts` that answers, for commands any member can serve.
   * The member that answered last time is tried first, so an unreachable host
   * early in the list does not cost a connect timeout on every call.
   */
  async anyMember(connectionId: string, hosts: string[]): Promise<{ host: string; client: MongoClient }> {
    const key = `${connectionId}|${[...hosts].sort().join(',')}`;
    const preferred = this.lastReachable.get(key);
    const ordered = preferred && hosts.includes(preferred) ? [preferred, ...hosts.filter((h) => h !== preferred)] : hosts;
    const errors: string[] = [];
    for (const host of ordered) {
      try {
        const client = await this.direct(connectionId, host);
        await client.db('admin').command({ ping: 1 });
        this.lastReachable.set(key, host);
        return { host, client };
      } catch (err) {
        errors.push(`${host}: ${(err as Error).message}`);
      }
    }
    throw new Error(errors.length ? `No member is reachable — ${errors.join('; ')}` : 'No hosts to connect to');
  }

  /** Close every cached client of a connection, e.g. after its credentials changed. */
  async closeConnection(connectionId: string): Promise<void> {
    await Promise.all(
      [...this.clients.keys()].filter((key) => key.startsWith(`${connectionId}|`)).map((key) => this.closeKey(key))
    );
  }

  dispose(): void {
    this.subscription.dispose();
    for (const key of [...this.clients.keys()]) {
      void this.closeKey(key);
    }
  }

  private async open(connectionId: string, host: string): Promise<MongoClient> {
    const connection = this.connectionManager.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown connection "${connectionId}"`);
    }
    const address = await this.resolve(connectionId, host);
    let uri = connectionStringForHosts(connection.options.connectionString, [address], true);
    const credentials = await this.credentialsFor(connectionId, host);
    if (credentials) {
      const cs = new ConnectionString(uri);
      cs.username = encodeURIComponent(credentials.username);
      cs.password = encodeURIComponent(credentials.password);
      // A shard-local user signs in with a password, whatever the connection itself uses.
      for (const key of [...cs.searchParams.keys()]) {
        if (/^authmechanism(properties)?$/i.test(key)) {
          cs.searchParams.delete(key);
        }
      }
      cs.searchParams.set('authSource', 'admin');
      uri = cs.toString();
    }
    const client = new MongoClient(uri, {
      appName: 'MongoDB Compass for VS Code (cluster)',
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      ...(credentials ? {} : await this.connectionManager.authOptions(connectionId, uri))
    });
    try {
      await client.connect();
    } catch (err) {
      await client.close(true).catch(() => undefined);
      throw new Error(`Cannot reach ${host}${address !== host ? ` (via ${address})` : ''}: ${(err as Error).message}`);
    }
    return client;
  }

  private async closeKey(key: string): Promise<void> {
    const pending = this.clients.get(key);
    this.clients.delete(key);
    if (!pending) {
      return;
    }
    try {
      const client = await pending;
      await client.close(true);
    } catch {
      // never connected
    }
  }
}
