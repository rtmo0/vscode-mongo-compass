import * as vscode from 'vscode';
import type { ConnectionOptions } from './types';
import { logger } from './logger';

const CONNECTIONS_KEY = 'mongoCompass.connections';
const SECRET_PREFIX = 'mongoCompass.uri.';

/**
 * Persists connection definitions.
 *
 * Connection strings may contain credentials, so they are stored in the
 * VS Code SecretStorage (OS keychain) while the non-sensitive metadata lives
 * in global state.
 */
export class ConnectionStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {}

  async loadAll(): Promise<ConnectionOptions[]> {
    const raw = this.context.globalState.get<ConnectionOptions[]>(CONNECTIONS_KEY, []);
    const restored: ConnectionOptions[] = [];
    for (const entry of raw) {
      const secret = await this.secrets.get(SECRET_PREFIX + entry.id);
      restored.push({
        ...entry,
        connectionString: secret ?? entry.connectionString ?? ''
      });
    }
    return restored.sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(connection: ConnectionOptions): Promise<void> {
    const all = await this.loadAll();
    const index = all.findIndex((c) => c.id === connection.id);
    if (index >= 0) {
      all[index] = connection;
    } else {
      all.push(connection);
    }
    await this.persist(all, connection);
  }

  async remove(id: string): Promise<void> {
    const all = await this.loadAll();
    await this.persist(
      all.filter((c) => c.id !== id),
      undefined,
      id
    );
    await this.secrets.delete(SECRET_PREFIX + id);
  }

  private async persist(
    connections: ConnectionOptions[],
    withSecret?: ConnectionOptions,
    removeSecretFor?: string
  ): Promise<void> {
    // Strip the connection string from global state — it lives in SecretStorage.
    const sanitized = connections.map(({ connectionString: _cs, ...rest }) => ({
      ...rest,
      connectionString: ''
    })) as ConnectionOptions[];

    await this.context.globalState.update(CONNECTIONS_KEY, sanitized);

    if (withSecret?.connectionString) {
      await this.secrets.store(SECRET_PREFIX + withSecret.id, withSecret.connectionString);
    }
    if (removeSecretFor) {
      await this.secrets.delete(SECRET_PREFIX + removeSecretFor);
    }
    logger.info('Connection store updated', { count: sanitized.length });
  }

  async touch(id: string): Promise<void> {
    const all = await this.loadAll();
    const target = all.find((c) => c.id === id);
    if (!target) {
      return;
    }
    target.lastUsed = Date.now();
    await this.save(target);
  }
}
