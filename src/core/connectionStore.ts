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
  /** Serialises read-modify-write cycles so concurrent saves cannot drop each other's changes. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly secrets: vscode.SecretStorage
  ) {}

  async loadAll(): Promise<ConnectionOptions[]> {
    const restored = await Promise.all(
      this.readMetadata().map(async (entry) => {
        const secret = await this.secrets.get(SECRET_PREFIX + entry.id);
        return { ...entry, connectionString: secret ?? entry.connectionString ?? '' };
      })
    );
    return restored.sort((a, b) => a.name.localeCompare(b.name));
  }

  save(connection: ConnectionOptions): Promise<void> {
    return this.mutate(async (entries) => {
      if (connection.connectionString) {
        await this.secrets.store(SECRET_PREFIX + connection.id, connection.connectionString);
      }
      const index = entries.findIndex((c) => c.id === connection.id);
      if (index >= 0) {
        entries[index] = connection;
      } else {
        entries.push(connection);
      }
      return true;
    });
  }

  remove(id: string): Promise<void> {
    return this.mutate(async (entries) => {
      const index = entries.findIndex((c) => c.id === id);
      if (index >= 0) {
        entries.splice(index, 1);
      }
      await this.secrets.delete(SECRET_PREFIX + id);
      return index >= 0;
    });
  }

  /** Record when a connection was last used. Touches metadata only, never the keychain. */
  touch(id: string, lastUsed = Date.now()): Promise<void> {
    return this.mutate((entries) => {
      const target = entries.find((c) => c.id === id);
      if (!target) {
        return false;
      }
      target.lastUsed = lastUsed;
      return true;
    });
  }

  /** Stored metadata; `connectionString` is empty except for entries saved before SecretStorage. */
  private readMetadata(): ConnectionOptions[] {
    return this.context.globalState
      .get<ConnectionOptions[]>(CONNECTIONS_KEY, [])
      .map((entry) => ({ ...entry }));
  }

  /**
   * Run `change` on the stored metadata and write it back if it returns true.
   * Changes run one at a time, each on the result of the previous one.
   */
  private mutate(change: (entries: ConnectionOptions[]) => boolean | Promise<boolean>): Promise<void> {
    const run = this.queue.then(async () => {
      const entries = this.readMetadata();
      await this.migrateLegacyConnectionStrings(entries);
      if (!(await change(entries))) {
        return;
      }
      // Strip connection strings from global state — they live in SecretStorage.
      const sanitized = entries.map((entry) => ({ ...entry, connectionString: '' }));
      await this.context.globalState.update(CONNECTIONS_KEY, sanitized);
      logger.info('Connection store updated', { count: sanitized.length });
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Move plain-text connection strings left in global state into SecretStorage before they are stripped. */
  private async migrateLegacyConnectionStrings(entries: ConnectionOptions[]): Promise<void> {
    for (const entry of entries) {
      if (!entry.connectionString) {
        continue;
      }
      const key = SECRET_PREFIX + entry.id;
      if ((await this.secrets.get(key)) === undefined) {
        await this.secrets.store(key, entry.connectionString);
      }
    }
  }
}
