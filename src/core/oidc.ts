import * as vscode from 'vscode';
import * as path from 'path';
import { EventEmitter } from 'events';
import type { MongoClientOptions } from 'mongodb';
import { ConnectionString } from 'mongodb-connection-string-url';
import type {
  AuthFlowType,
  DeviceFlowInformation,
  MongoDBOIDCLogEventsMap,
  MongoDBOIDCPlugin,
  TypedEventEmitter
} from '@mongodb-js/oidc-plugin';
import type { ConnectionAuthProvider } from './connectionManager';
import type { ConnectionOptions } from './types';
import { logger } from './logger';

type PluginModule = typeof import('./oidcPluginBundle');

const SECRET_PREFIX = 'mongoCompass.oidc.';

/** The driver's default `ALLOWED_HOSTS`: hosts it sends OIDC tokens to without asking. */
const DEFAULT_ALLOWED_HOSTS = ['*.mongodb.net', '*.mongodb-qa.net', '*.mongodb-dev.net', '*.mongodbgov.net', 'localhost', '127.0.0.1', '::1'];

function parse(uri: string): ConnectionString | undefined {
  try {
    return new ConnectionString(uri.trim());
  } catch {
    return undefined;
  }
}

function param(cs: ConnectionString, name: string): string | undefined {
  for (const [key, value] of cs.searchParams.entries()) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return value;
    }
  }
  return undefined;
}

/**
 * True when the URI asks for OIDC with a person signing in. With an
 * `ENVIRONMENT` (azure, gcp, k8s) the driver gets a workload token by itself.
 */
export function usesHumanOidc(uri: string): boolean {
  const cs = parse(uri);
  if (!cs || param(cs, 'authMechanism')?.toUpperCase() !== 'MONGODB-OIDC') {
    return false;
  }
  return !/(^|,)\s*ENVIRONMENT\s*:/i.test(param(cs, 'authMechanismProperties') ?? '');
}

/** `host:port` or `[v6]:port` → host. */
function hostName(host: string): string {
  if (host.startsWith('[')) {
    return host.slice(1, host.indexOf(']'));
  }
  return host.replace(/:\d+$/, '');
}

function matches(host: string, patterns: string[]): boolean {
  return patterns.some((p) => host === p || (p.startsWith('*.') && host.endsWith(p.slice(1))));
}

/**
 * True when the driver would refuse to send tokens to the hosts of `uri`
 * until the user marks the endpoint as trusted.
 */
export function oidcNeedsTrust(uri: string): boolean {
  const cs = parse(uri);
  return Boolean(cs && usesHumanOidc(uri) && cs.hosts.some((h) => !matches(hostName(h), DEFAULT_ALLOWED_HOSTS)));
}

/**
 * `ALLOWED_HOSTS` for a trusted endpoint: the hosts of the URI, and for SRV
 * the domain its records must live in (the driver checks hosts after SRV
 * resolution).
 */
export function trustedHosts(uri: string): string[] {
  const cs = parse(uri);
  const hosts = new Set(DEFAULT_ALLOWED_HOSTS);
  for (const host of (cs?.hosts ?? []).map(hostName)) {
    hosts.add(host);
    const parent = host.split('.').slice(1).join('.');
    if (cs?.isSRV && parent.includes('.')) {
      hosts.add(`*.${parent}`);
    }
  }
  return [...hosts];
}

/** `uri` with `authMechanism=MONGODB-OIDC` and without a password (OIDC never uses one). */
export function withOidc(uri: string): string {
  const cs = new ConnectionString(uri.trim());
  for (const key of [...cs.searchParams.keys()]) {
    if (key.toLowerCase() === 'authmechanism' || key.toLowerCase() === 'authsource') {
      cs.searchParams.delete(key);
    }
  }
  cs.password = '';
  cs.searchParams.set('authMechanism', 'MONGODB-OIDC');
  return cs.toString();
}

interface PluginEntry {
  plugin: MongoDBOIDCPlugin;
  /** Aborts a sign-in that is still waiting, e.g. when the user disconnects. */
  abort: AbortController;
  dispose(): void;
}

/**
 * OIDC sign-in for connections that use `authMechanism=MONGODB-OIDC`, the
 * way Compass and mongosh do it: the identity provider's page opens in the
 * browser, and the tokens are kept per connection in the OS keychain so the
 * next session can refresh them instead of asking again.
 *
 * One plugin instance per connection, shared by its main client and its
 * direct member clients (same deployment and user, as the plugin requires).
 */
export class OidcAuth implements ConnectionAuthProvider, vscode.Disposable {
  private readonly plugins = new Map<string, Promise<PluginEntry>>();
  private module?: PluginModule;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    /** Folder holding `oidc-plugin.js`. */
    private readonly bundleDir: string
  ) {}

  async clientOptions(connection: ConnectionOptions, uri: string): Promise<MongoClientOptions | undefined> {
    if (!usesHumanOidc(uri)) {
      return undefined;
    }
    const { plugin } = await this.entry(connection.id);
    return {
      authMechanismProperties: {
        ...plugin.mongoClientOptions.authMechanismProperties,
        ...(connection.oidcTrustedEndpoint ? { ALLOWED_HOSTS: trustedHosts(uri) } : {})
      }
    } as MongoClientOptions;
  }

  async release(id: string): Promise<void> {
    const pending = this.plugins.get(id);
    if (!pending) {
      return;
    }
    this.plugins.delete(id);
    const entry = await pending.catch(() => undefined);
    if (!entry) {
      return;
    }
    await this.save(id, entry.plugin);
    entry.abort.abort();
    entry.dispose();
    await entry.plugin.destroy().catch(() => undefined);
  }

  async forget(id: string): Promise<void> {
    const pending = this.plugins.get(id);
    this.plugins.delete(id);
    const entry = await pending?.catch(() => undefined);
    if (entry) {
      entry.abort.abort();
      entry.dispose();
      await entry.plugin.destroy().catch(() => undefined);
    }
    await this.secrets.delete(SECRET_PREFIX + id);
  }

  dispose(): void {
    for (const id of [...this.plugins.keys()]) {
      void this.release(id);
    }
  }

  private entry(id: string): Promise<PluginEntry> {
    let pending = this.plugins.get(id);
    if (!pending) {
      pending = this.create(id);
      this.plugins.set(id, pending);
      pending.catch(() => {
        if (this.plugins.get(id) === pending) {
          this.plugins.delete(id);
        }
      });
    }
    return pending;
  }

  private async create(id: string): Promise<PluginEntry> {
    const { createMongoDBOIDCPlugin } = this.load();
    const serializedState = await this.secrets.get(SECRET_PREFIX + id);
    const abort = new AbortController();
    const events = new EventEmitter() as unknown as TypedEventEmitter<MongoDBOIDCLogEventsMap>;
    const config = vscode.workspace.getConfiguration('mongoCompass.oidc');
    const plugin = createMongoDBOIDCPlugin({
      serializedState,
      signal: abort.signal,
      logger: events,
      redirectURI: config.get<string>('redirectURI')?.trim() || undefined,
      allowedFlows: (): AuthFlowType[] =>
        vscode.workspace.getConfiguration('mongoCompass.oidc').get<boolean>('deviceAuthFlow', false)
          ? ['auth-code', 'device-auth']
          : ['auth-code'],
      openBrowser: async ({ url }) => openBrowser(url),
      notifyDeviceFlow: (info) => notifyDeviceFlow(info)
    });

    // Keep the keychain copy current, so a token refreshed in the background survives a restart.
    let saveTimer: ReturnType<typeof setTimeout> | undefined;
    events.on('mongodb-oidc-plugin:state-updated', () => {
      if (saveTimer) {
        clearTimeout(saveTimer);
      }
      saveTimer = setTimeout(() => void this.save(id, plugin), 1000);
    });
    events.on('mongodb-oidc-plugin:auth-attempt-started', (e) => logger.info('OIDC sign-in started', { connection: id, flow: e.flow }));
    events.on('mongodb-oidc-plugin:auth-attempt-succeeded', () => logger.info('OIDC sign-in succeeded', { connection: id }));
    events.on('mongodb-oidc-plugin:auth-attempt-failed', (e) => logger.warn('OIDC sign-in failed', { connection: id, error: e.error }));
    events.on('mongodb-oidc-plugin:refresh-failed', (e) => logger.warn('OIDC token refresh failed', { connection: id, error: e.error }));
    events.on('mongodb-oidc-plugin:local-listen-failed', (e) => logger.warn('OIDC redirect server could not listen', { url: e.url, error: e.error }));
    events.on('mongodb-oidc-plugin:deserialization-failed', (e) => logger.warn('Stored OIDC state ignored', { connection: id, error: e.error }));
    events.on('mongodb-oidc-plugin:request-token-started', (e) => logger.info('OIDC token requested', { connection: id, issuer: e.issuer, clientId: e.clientId }));

    return {
      plugin,
      abort,
      dispose: () => {
        if (saveTimer) {
          clearTimeout(saveTimer);
        }
      }
    };
  }

  private async save(id: string, plugin: MongoDBOIDCPlugin): Promise<void> {
    try {
      await this.secrets.store(SECRET_PREFIX + id, await plugin.serialize());
    } catch (err) {
      logger.warn('Could not store OIDC state', { connection: id, error: (err as Error).message });
    }
  }

  private load(): PluginModule {
    if (!this.module) {
      // The plugin relies on the web `fetch` and WebCrypto APIs of Node.js 20+.
      if (typeof fetch !== 'function' || !globalThis.crypto?.subtle) {
        throw new Error(`OIDC sign-in needs a newer VS Code: its extension host runs Node.js ${process.version}, 20 or later is required.`);
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.module = require(path.join(this.bundleDir, 'oidc-plugin.js')) as PluginModule;
    }
    return this.module;
  }
}

/**
 * Open `url` in the user's browser. In a remote window, forward the local
 * redirect server first so the browser on the user's machine can reach it.
 */
async function openBrowser(url: string): Promise<void> {
  let target = url;
  if (vscode.env.remoteName) {
    const local = new URL(url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(local.hostname)) {
      const external = await vscode.env.asExternalUri(vscode.Uri.parse(`${local.protocol}//${local.host}/`));
      target = `${external.scheme}://${external.authority}${local.pathname}${local.search}`;
    }
  }
  if (!(await openExternal(target))) {
    throw new Error('The browser was not opened for the OIDC sign-in.');
  }
}

function openExternal(url: string): Thenable<boolean> {
  // VS Code accepts the string as is; a parsed `Uri` would re-encode the query of the sign-in URL.
  return vscode.env.openExternal(url as unknown as vscode.Uri);
}

function notifyDeviceFlow(info: DeviceFlowInformation): void {
  void vscode.window
    .showInformationMessage(
      `MongoDB sign-in: open ${info.verificationUrl} and enter the code ${info.userCode}.`,
      'Copy Code and Open'
    )
    .then(async (choice) => {
      if (choice) {
        await vscode.env.clipboard.writeText(info.userCode);
        await openExternal(info.verificationUrl);
      }
    });
}
