import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Document } from 'bson';

import { ConnectionStore } from './core/connectionStore';
import { ConnectionManager } from './core/connectionManager';
import { QueryHistoryStore } from './core/queryHistory';
import { MyQueriesStore } from './core/myQueries';
import { DataService, Namespace } from './core/dataService';
import { parseShellBSON, parsePipeline } from './core/bsonParser';
import { getConfig } from './core/config';
import { logger, getOutputChannel } from './core/logger';
import type { ConnectionOptions, LiveConnection, QueryState } from './core/types';

import {
  MongoExplorerProvider,
  ConnectionNode,
  DatabasesNode,
  DatabaseNode,
  CollectionNode,
  IndexesNode,
  IndexNode,
  redactUri
} from './explorer/mongoExplorer';
import { MongoToolsProvider } from './explorer/toolsView';

import { DocumentsPanel } from './webviews/documentsPanel';
import { AggregationPanel } from './webviews/aggregationPanel';
import { DataPanel } from './webviews/dataPanel';

import { promptForConnection, promptForUri } from './commands/connectionForm';
import { connectionStringForDatabase, deriveConnectionName } from './core/connectionString';

interface Services {
  connectionManager: ConnectionManager;
  history: QueryHistoryStore;
  myQueries: MyQueriesStore;
  explorer: MongoExplorerProvider;
}

let services: Services | undefined;
const execFileAsync = promisify(execFile);

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  logger.info('Activating MongoDB Compass extension');

  const store = new ConnectionStore(context, context.secrets);
  const connectionManager = new ConnectionManager(store);
  const history = new QueryHistoryStore(context);
  const myQueries = new MyQueriesStore(context);

  await connectionManager.hydrate();

  const explorer = new MongoExplorerProvider(connectionManager);
  const tools = new MongoToolsProvider();

  services = { connectionManager, history, myQueries, explorer };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('mongoCompass.explorer', explorer),
    vscode.window.registerTreeDataProvider('mongoCompass.tools', tools),
    connectionManager,
    history,
    myQueries,
    explorer
  );

  registerConnectionCommands(context, services);
  registerExplorerCommands(context, services);
  registerCollectionCommands(context, services);
  registerDataCommands(context, services);
  registerToolCommands(context, services);

  // Keep the status bar in sync with the active connection.
  const statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusItem.command = 'mongoCompass.showServerStatus';
  context.subscriptions.push(statusItem);

  const updateStatus = (): void => {
    const active = connectionManager.activeConnection;
    if (active && active.state === 'connected') {
      statusItem.text = `$(database) ${active.options.name}`;
      statusItem.tooltip = `MongoDB: ${redactUri(active.options.connectionString)}\nClick for server status`;
      statusItem.show();
    } else {
      statusItem.hide();
    }
  };
  context.subscriptions.push(connectionManager.onDidChange(updateStatus));
  updateStatus();

  logger.info('MongoDB Compass extension activated');
}

export function deactivate(): void {
  services?.connectionManager.dispose();
  logger.dispose();
}

// ───────────────────────────── helpers ─────────────────────────────

async function requireConnection(
  connectionManager: ConnectionManager,
  connectionId?: string
): Promise<LiveConnection> {
  if (connectionId) {
    return connectionManager.requireClient(connectionId);
  }
  const active = connectionManager.activeConnection;
  if (active) {
    return connectionManager.requireClient(active.options.id);
  }
  const options = await pickConnection(connectionManager, 'Select a connection');
  if (!options) {
    throw new Error('No connection selected');
  }
  return connectionManager.requireClient(options.id);
}

async function pickConnection(
  connectionManager: ConnectionManager,
  placeholder: string
): Promise<ConnectionOptions | undefined> {
  const options = await connectionManager.listOptions();
  if (options.length === 0) {
    const create = await vscode.window.showInformationMessage(
      'No MongoDB connections yet. Add one?',
      'Add Connection'
    );
    if (create) {
      await vscode.commands.executeCommand('mongoCompass.addConnection');
    }
    return undefined;
  }
  if (options.length === 1) {
    return options[0];
  }
  const picked = await vscode.window.showQuickPick(
    options.map((o) => ({
      label: o.name,
      description: redactUri(o.connectionString),
      detail: o.notes,
      connection: o
    })),
    { placeHolder: placeholder }
  );
  return picked?.connection;
}

async function confirmDangerous(message: string): Promise<boolean> {
  if (!getConfig().confirmDangerousOperations) {
    return true;
  }
  const answer = await vscode.window.showWarningMessage(message, { modal: true }, 'Yes');
  return answer === 'Yes';
}

type EnvRef = (name: string) => string;

/**
 * Open an editor terminal that runs a MongoDB CLI tool.
 *
 * Values (URIs with credentials, paths) are passed through the terminal
 * environment so they never show up in the command line or shell history.
 * Windows terminals are pinned to PowerShell because cmd and PowerShell
 * reference environment variables differently from POSIX shells.
 */
function runMongoToolInTerminal(
  name: string,
  env: Record<string, string>,
  command: (ref: EnvRef) => string
): void {
  const isWindows = process.platform === 'win32';
  const ref: EnvRef = isWindows ? (variable) => `\${env:${variable}}` : (variable) => `\${${variable}}`;
  const terminal = vscode.window.createTerminal({
    name,
    location: vscode.TerminalLocation.Editor,
    env,
    ...(isWindows ? { shellPath: 'powershell.exe', shellArgs: ['-NoLogo'] } : {})
  });
  terminal.show();
  terminal.sendText(command(ref), true);
}

async function ensureMongoToolAvailable(tool: 'mongodump' | 'mongorestore'): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [tool]);
    return true;
  } catch {
    const action = await vscode.window.showErrorMessage(
      `${tool} is not installed or is not available on PATH. Install MongoDB Database Tools and restart VS Code.`,
      'Installation instructions'
    );
    if (action) {
      await vscode.env.openExternal(vscode.Uri.parse('https://www.mongodb.com/docs/database-tools/installation/installation/'));
    }
    return false;
  }
}

function nodeNamespace(node: unknown): Namespace | undefined {
  if (node instanceof CollectionNode) {
    return node.namespace;
  }
  if (node instanceof IndexesNode || node instanceof IndexNode) {
    return node.namespace;
  }
  return undefined;
}

function nodeConnectionId(node: unknown): string | undefined {
  if (node instanceof ConnectionNode) {
    return node.connection.options.id;
  }
  if (node instanceof DatabaseNode) {
    return node.connection.options.id;
  }
  if (node instanceof CollectionNode || node instanceof IndexesNode || node instanceof IndexNode) {
    return node.connection.options.id;
  }
  return undefined;
}

// ───────────────────────────── connection commands ─────────────────────────────

function registerConnectionCommands(context: vscode.ExtensionContext, s: Services): void {
  const { connectionManager, explorer } = s;

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.addConnection', async () => {
      const options = await promptForConnection();
      if (!options) {
        return;
      }
      await connectionManager.addOrUpdate(options);
      explorer.refresh();
      const connect = await vscode.window.showInformationMessage(
        `Connection "${options.name}" saved. Connect now?`,
        'Connect'
      );
      if (connect) {
        await vscode.commands.executeCommand('mongoCompass.connect', options.id);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.connectWithUri', async () => {
      const uri = await promptForUri();
      if (!uri) {
        return;
      }
      const name = deriveNameFromUri(uri);
      const options: ConnectionOptions = {
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name,
        connectionString: uri.trim()
      };
      await connectionManager.addOrUpdate(options);
      explorer.refresh();
      await vscode.commands.executeCommand('mongoCompass.connect', options.id);
    }),

    vscode.commands.registerCommand('mongoCompass.connect', async (arg?: string | ConnectionNode) => {
      const id = typeof arg === 'string' ? arg : arg?.connection.options.id;
      if (!id) {
        const options = await pickConnection(connectionManager, 'Select a connection to connect');
        if (!options) {
          return;
        }
        await connectWithProgress(connectionManager, options.id, explorer);
        return;
      }
      await connectWithProgress(connectionManager, id, explorer);
    }),

    vscode.commands.registerCommand('mongoCompass.disconnect', async (arg?: string | ConnectionNode) => {
      const id = typeof arg === 'string' ? arg : arg?.connection.options.id;
      if (!id) {
        const active = connectionManager.activeConnection;
        if (!active) {
          void vscode.window.showInformationMessage('No active connection.');
          return;
        }
        await connectionManager.disconnect(active.options.id);
        explorer.refresh();
        return;
      }
      await connectionManager.disconnect(id);
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.editConnection', async (arg?: ConnectionNode) => {
      const id = arg?.connection.options.id;
      const existing = id ? connectionManager.get(id)?.options : undefined;
      const options = await promptForConnection(existing);
      if (!options) {
        return;
      }
      await connectionManager.addOrUpdate(options);
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.duplicateConnection', async (arg?: ConnectionNode) => {
      const source = arg?.connection.options ?? (await pickConnection(connectionManager, 'Select a connection to duplicate'));
      if (!source) {
        return;
      }
      const copy: ConnectionOptions = {
        ...source,
        id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: `${source.name} (copy)`,
        lastUsed: undefined
      };
      await connectionManager.addOrUpdate(copy);
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.removeConnection', async (arg?: ConnectionNode) => {
      const id = arg?.connection.options.id;
      const options = id
        ? connectionManager.get(id)?.options
        : await pickConnection(connectionManager, 'Select a connection to remove');
      if (!options) {
        return;
      }
      const confirmed = await confirmDangerous(`Remove connection "${options.name}"?`);
      if (!confirmed) {
        return;
      }
      await connectionManager.remove(options.id);
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.copyConnectionString', async (arg?: ConnectionNode) => {
      const options = arg?.connection.options ?? (await pickConnection(connectionManager, 'Select a connection'));
      if (!options) {
        return;
      }
      await vscode.env.clipboard.writeText(options.connectionString);
      void vscode.window.showInformationMessage('Connection string copied to clipboard.');
    })
  );
}

async function connectWithProgress(
  connectionManager: ConnectionManager,
  id: string,
  explorer: MongoExplorerProvider
): Promise<void> {
  const name = connectionManager.get(id)?.options.name ?? id;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Connecting to ${name}…`,
      cancellable: false
    },
    async () => {
      try {
        const connection = await connectionManager.connect(id);
        explorer.refresh();
        void vscode.window.showInformationMessage(
          `Connected to ${connection.options.name} (v${connection.topology?.serverVersion ?? 'unknown'})`
        );
      } catch (err) {
        explorer.refresh();
        const message = (err as Error).message;
        logger.error('Connect failed', { id, error: message });
        void vscode.window.showErrorMessage(`Failed to connect: ${message}`);
      }
    }
  );
}

function deriveNameFromUri(uri: string): string {
  return deriveConnectionName(uri);
}

// ───────────────────────────── explorer commands ─────────────────────────────

function registerExplorerCommands(context: vscode.ExtensionContext, s: Services): void {
  const { connectionManager, explorer } = s;

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.refreshExplorer', () => explorer.refresh()),
    vscode.commands.registerCommand('mongoCompass.refreshNode', (node?: unknown) => {
      explorer.refresh(node as never);
    }),

    vscode.commands.registerCommand('mongoCompass.refreshDatabases', () => {
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.refreshCollections', () => {
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.refreshCollection', () => {
      explorer.refresh();
    }),

    vscode.commands.registerCommand('mongoCompass.createDatabase', async (arg?: DatabasesNode) => {
      const connection = arg?.connection ?? connectionManager.activeConnection;
      if (!connection) {
        void vscode.window.showErrorMessage('Connect to a server first.');
        return;
      }
      const dbName = await vscode.window.showInputBox({
        prompt: 'New database name',
        validateInput: (v) => (v.trim() ? null : 'Name is required')
      });
      if (!dbName) {
        return;
      }
      const collName = await vscode.window.showInputBox({
        prompt: 'First collection name (a database needs at least one collection)',
        value: 'myCollection',
        validateInput: (v) => (v.trim() ? null : 'Name is required')
      });
      if (!collName) {
        return;
      }
      try {
        const service = new DataService(connection.client, connection.options.id);
        await service.createDatabase(dbName.trim(), collName.trim());
        explorer.refresh();
        void vscode.window.showInformationMessage(`Database "${dbName}" created.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to create database: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.dropDatabase', async (arg?: DatabaseNode) => {
      if (!arg) {
        return;
      }
      const confirmed = await confirmDangerous(
        `Drop database "${arg.database.name}" and ALL its collections? This cannot be undone.`
      );
      if (!confirmed) {
        return;
      }
      try {
        const service = new DataService(arg.connection.client, arg.connection.options.id);
        await service.dropDatabase(arg.database.name);
        explorer.refresh();
        void vscode.window.showInformationMessage(`Database "${arg.database.name}" dropped.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to drop database: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.showDatabaseStats', async (arg?: DatabaseNode) => {
      if (!arg) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        s.connectionManager,
        s.history,
        s.myQueries,
        'stats',
        { connectionId: arg.connection.options.id, database: arg.database.name },
        `Stats — ${arg.database.name}`
      );
    }),

    vscode.commands.registerCommand(
      'mongoCompass.openMongosh',
      async (arg?: DatabaseNode | CollectionNode) => {
        if (!(arg instanceof DatabaseNode) && !(arg instanceof CollectionNode)) {
          return;
        }
        const databaseName = arg instanceof DatabaseNode ? arg.database.name : arg.databaseName;
        const collectionName = arg instanceof CollectionNode ? arg.collection.name : undefined;
        const uri = connectionStringForDatabase(arg.connection.options.connectionString, databaseName);
        runMongoToolInTerminal(
          `mongosh: ${databaseName}`,
          {
            MONGO_COMPASS_URI: uri,
            MONGO_COMPASS_DATABASE: databaseName,
            MONGO_COMPASS_COLLECTION: collectionName ?? ''
          },
          (ref) => `mongosh "${ref('MONGO_COMPASS_URI')}"`
        );
      }
    ),

    vscode.commands.registerCommand('mongoCompass.showLogs', () => getOutputChannel().show(true))
  );
}

// ───────────────────────────── collection commands ─────────────────────────────

function registerCollectionCommands(context: vscode.ExtensionContext, s: Services): void {
  const { connectionManager, explorer } = s;

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.createCollection', async (arg?: DatabaseNode) => {
      const connection = arg?.connection ?? connectionManager.activeConnection;
      const databaseName = arg instanceof DatabaseNode
        ? arg.database.name
        : await pickDatabase(connection);
      if (!connection || !databaseName) {
        return;
      }
      const name = await vscode.window.showInputBox({
        prompt: `New collection name in "${databaseName}"`,
        validateInput: (v) => (v.trim() ? null : 'Name is required')
      });
      if (!name) {
        return;
      }
      const isTimeSeries = await vscode.window.showQuickPick(['No', 'Yes'], {
        placeHolder: 'Is this a time-series collection?'
      });
      try {
        const service = new DataService(connection.client, connection.options.id);
        const options: Document = {};
        if (isTimeSeries === 'Yes') {
          const timeField = await vscode.window.showInputBox({ prompt: 'Time field', value: 'timestamp' });
          if (!timeField) {
            return;
          }
          options.timeseries = { timeField };
        }
        await service.createCollection(databaseName, name.trim(), options);
        explorer.refresh();
        void vscode.window.showInformationMessage(`Collection "${name}" created.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to create collection: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.createView', async (arg?: DatabaseNode) => {
      const connection = arg?.connection ?? connectionManager.activeConnection;
      const databaseName = arg instanceof DatabaseNode
        ? arg.database.name
        : await pickDatabase(connection);
      if (!connection || !databaseName) {
        return;
      }
      const viewName = await vscode.window.showInputBox({ prompt: 'View name', validateInput: (v) => (v.trim() ? null : 'Required') });
      if (!viewName) {
        return;
      }
      const source = await vscode.window.showInputBox({ prompt: 'Source collection', validateInput: (v) => (v.trim() ? null : 'Required') });
      if (!source) {
        return;
      }
      const pipelineText = await vscode.window.showInputBox({ prompt: 'Pipeline (EJSON array)', value: '[]' });
      if (pipelineText === undefined) {
        return;
      }
      try {
        const pipeline = parsePipeline(pipelineText);
        const service = new DataService(connection.client, connection.options.id);
        await service.createView(databaseName, viewName.trim(), source.trim(), pipeline);
        explorer.refresh();
        void vscode.window.showInformationMessage(`View "${viewName}" created.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to create view: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.dropCollection', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      const confirmed = await confirmDangerous(
        `Drop "${ns.toString()}"? This cannot be undone.`
      );
      if (!confirmed) {
        return;
      }
      try {
        const connection = await connectionManager.requireClient(connectionId);
        const service = new DataService(connection.client, connectionId);
        await service.dropCollection(ns.database, ns.collection);
        explorer.refresh();
        void vscode.window.showInformationMessage(`Collection "${ns.collection}" dropped.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to drop collection: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.renameCollection', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `Rename "${ns.collection}" to`,
        value: ns.collection,
        validateInput: (v) => (v.trim() ? null : 'Required')
      });
      if (!newName) {
        return;
      }
      try {
        const connection = await connectionManager.requireClient(connectionId);
        const service = new DataService(connection.client, connectionId);
        await service.renameCollection(ns.database, ns.collection, newName.trim());
        explorer.refresh();
        void vscode.window.showInformationMessage(`Collection renamed to "${newName}".`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to rename collection: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.duplicateCollection', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      const newName = await vscode.window.showInputBox({
        prompt: `Duplicate "${ns.collection}" into`,
        value: `${ns.collection}_copy`,
        validateInput: (v) => (v.trim() ? null : 'Required')
      });
      if (!newName) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Duplicating ${ns.toString()}…` },
        async (progress) => {
          try {
            const connection = await connectionManager.requireClient(connectionId);
            const service = new DataService(connection.client, connectionId);
            await service.createCollection(ns.database, newName.trim());
            const target = new Namespace(ns.database, newName.trim());
            const cursor = service.collection(ns).find({}).batchSize(getConfig().exportBatchSize);
            let batch: Document[] = [];
            let copied = 0;
            for await (const doc of cursor) {
              batch.push(doc);
              if (batch.length >= getConfig().exportBatchSize) {
                await service.insertMany(target, batch);
                copied += batch.length;
                batch = [];
                progress.report({ message: `${copied} documents…` });
              }
            }
            if (batch.length > 0) {
              await service.insertMany(target, batch);
              copied += batch.length;
            }
            explorer.refresh();
            void vscode.window.showInformationMessage(`Duplicated ${copied} documents into "${newName}".`);
          } catch (err) {
            void vscode.window.showErrorMessage(`Failed to duplicate collection: ${(err as Error).message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('mongoCompass.showCollectionStats', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        s.connectionManager,
        s.history,
        s.myQueries,
        'stats',
        { connectionId, database: ns.database, collection: ns.collection },
        `Stats — ${ns.toString()}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.copyNamespace', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      if (!ns) {
        return;
      }
      await vscode.env.clipboard.writeText(ns.toString());
      void vscode.window.showInformationMessage('Namespace copied.');
    }),

    vscode.commands.registerCommand('mongoCompass.insertDocument', async (arg?: CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      const text = await vscode.window.showInputBox({
        prompt: `Insert document into ${ns.toString()} (EJSON)`,
        value: '{ "name": "" }'
      });
      if (!text) {
        return;
      }
      try {
        const doc = parseShellBSON(text);
        const connection = await connectionManager.requireClient(connectionId);
        const service = new DataService(connection.client, connectionId);
        const insertedId = await service.insertOne(ns, doc);
        void vscode.window.showInformationMessage(`Inserted _id: ${insertedId}`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to insert document: ${(err as Error).message}`);
      }
    })
  );
}

async function pickDatabase(connection?: LiveConnection): Promise<string | undefined> {
  if (!connection) {
    void vscode.window.showErrorMessage('Connect to a server first.');
    return undefined;
  }
  const service = new DataService(connection.client, connection.options.id);
  const databases = await service.listDatabases();
  const picked = await vscode.window.showQuickPick(
    databases.map((d) => d.name),
    { placeHolder: 'Select a database' }
  );
  return picked;
}

// ───────────────────────────── data / view commands ─────────────────────────────

function registerDataCommands(context: vscode.ExtensionContext, s: Services): void {
  const { connectionManager } = s;

  const openDocuments = async (
    connectionId?: string,
    database?: string,
    collection?: string,
    query?: Partial<QueryState>
  ): Promise<void> => {
    let ns: Namespace | undefined;
    let connId = connectionId;

    if (database && collection) {
      ns = new Namespace(database, collection);
    }
    if (!connId) {
      const connection = await requireConnection(connectionManager);
      connId = connection.options.id;
    }
    if (!ns) {
      const connection = await connectionManager.requireClient(connId);
      const picked = await pickCollection(connection);
      if (!picked) {
        return;
      }
      ns = picked;
    }
    DocumentsPanel.open(
      context.extensionUri,
      connectionManager,
      s.history,
      s.myQueries,
      connId,
      ns,
      query
    );
  };

  const openAggregation = async (
    connectionId?: string,
    database?: string,
    collection?: string,
    pipeline?: string
  ): Promise<void> => {
    let ns: Namespace | undefined;
    let connId = connectionId;
    if (database && collection) {
      ns = new Namespace(database, collection);
    }
    if (!connId) {
      const connection = await requireConnection(connectionManager);
      connId = connection.options.id;
    }
    if (!ns) {
      const connection = await connectionManager.requireClient(connId);
      const picked = await pickCollection(connection);
      if (!picked) {
        return;
      }
      ns = picked;
    }
    AggregationPanel.open(
      context.extensionUri,
      connectionManager,
      s.history,
      s.myQueries,
      connId,
      ns,
      pipeline
    );
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.openDocuments', async (arg?: CollectionNode | string, database?: string, collection?: string, query?: Partial<QueryState>) => {
      if (arg instanceof CollectionNode) {
        DocumentsPanel.open(
          context.extensionUri,
          connectionManager,
          s.history,
          s.myQueries,
          arg.connection.options.id,
          arg.namespace
        );
        return;
      }
      await openDocuments(typeof arg === 'string' ? arg : undefined, database, collection, query);
    }),

    vscode.commands.registerCommand('mongoCompass.openAggregation', async (arg?: CollectionNode | string, database?: string, collection?: string, pipeline?: string) => {
      if (arg instanceof CollectionNode) {
        AggregationPanel.open(
          context.extensionUri,
          connectionManager,
          s.history,
          s.myQueries,
          arg.connection.options.id,
          arg.namespace
        );
        return;
      }
      await openAggregation(typeof arg === 'string' ? arg : undefined, database, collection, pipeline);
    }),

    vscode.commands.registerCommand('mongoCompass.openIndexes', async (arg?: CollectionNode) => {
      const { ns, connId } = await resolveNamespace(connectionManager, arg);
      if (!ns || !connId) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'indexes',
        { connectionId: connId, database: ns.database, collection: ns.collection },
        `Indexes — ${ns.toString()}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.openSchema', async (arg?: CollectionNode) => {
      const { ns, connId } = await resolveNamespace(connectionManager, arg);
      if (!ns || !connId) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'schema',
        { connectionId: connId, database: ns.database, collection: ns.collection },
        `Schema — ${ns.toString()}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.openValidation', async (arg?: CollectionNode) => {
      const { ns, connId } = await resolveNamespace(connectionManager, arg);
      if (!ns || !connId) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'validation',
        { connectionId: connId, database: ns.database, collection: ns.collection },
        `Validation — ${ns.toString()}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.explainQuery', async (arg?: CollectionNode) => {
      const { ns, connId } = await resolveNamespace(connectionManager, arg);
      if (!ns || !connId) {
        return;
      }
      const filterText = await vscode.window.showInputBox({
        prompt: `Filter to explain on ${ns.toString()}`,
        value: '{}'
      });
      if (filterText === undefined) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running explain…' },
        async () => {
          try {
            const filter = parseShellBSON(filterText);
            const connection = await connectionManager.requireClient(connId);
            const service = new DataService(connection.client, connId);
            const explain = await service.explainFind(ns, {
              filter,
              filterText,
              project: {},
              projectText: '',
              sort: {},
              sortText: '',
              collation: null,
              collationText: '',
              skip: 0,
              limit: getConfig().defaultLimit,
              maxTimeMS: getConfig().maxTimeMS
            });
            DataPanel.open(
              context.extensionUri,
              connectionManager,
              s.history,
              s.myQueries,
              'explain',
              { connectionId: connId, database: ns.database, collection: ns.collection, extra: { explain } },
              `Explain — ${ns.toString()}`
            );
          } catch (err) {
            void vscode.window.showErrorMessage(`Explain failed: ${(err as Error).message}`);
          }
        }
      );
    }),

    vscode.commands.registerCommand('mongoCompass.createIndex', async (arg?: IndexesNode | CollectionNode) => {
      const ns = nodeNamespace(arg);
      const connectionId = nodeConnectionId(arg);
      if (!ns || !connectionId) {
        return;
      }
      const keysText = await vscode.window.showInputBox({ prompt: 'Index keys (EJSON)', value: '{ "field": 1 }' });
      if (!keysText) {
        return;
      }
      const optionsText = await vscode.window.showInputBox({ prompt: 'Index options (EJSON, optional)', value: '{}' });
      if (optionsText === undefined) {
        return;
      }
      try {
        const keys = parseShellBSON(keysText);
        const options = optionsText.trim() ? parseShellBSON(optionsText) : {};
        const connection = await connectionManager.requireClient(connectionId);
        const service = new DataService(connection.client, connectionId);
        const name = await service.createIndex(ns, keys, options);
        s.explorer.refresh();
        void vscode.window.showInformationMessage(`Index "${name}" created.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to create index: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.dropIndex', async (arg?: IndexNode) => {
      if (!(arg instanceof IndexNode)) {
        return;
      }
      const confirmed = await confirmDangerous(`Drop index "${arg.index.name}"?`);
      if (!confirmed) {
        return;
      }
      try {
        const service = new DataService(arg.connection.client, arg.connection.options.id);
        await service.dropIndex(arg.namespace, arg.index.name);
        s.explorer.refresh();
        void vscode.window.showInformationMessage(`Index "${arg.index.name}" dropped.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Failed to drop index: ${(err as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('mongoCompass.exportToLanguage', async (arg?: CollectionNode) => {
      const { ns, connId } = await resolveNamespace(connectionManager, arg);
      if (!ns || !connId) {
        return;
      }
      const { EXPORT_LANGUAGES, exportToLanguage } = await import('./core/exportToLanguage');
      const picked = await vscode.window.showQuickPick(
        EXPORT_LANGUAGES.map((l) => ({ label: l.label, id: l.id })),
        { placeHolder: 'Export query to…' }
      );
      if (!picked) {
        return;
      }
      const connection = connectionManager.get(connId);
      const code = exportToLanguage(picked.id, {
        database: ns.database,
        collection: ns.collection,
        query: {
          filter: {},
          filterText: '',
          project: {},
          projectText: '',
          sort: {},
          sortText: '',
          collation: null,
          collationText: '',
          skip: 0,
          limit: getConfig().defaultLimit,
          maxTimeMS: getConfig().maxTimeMS
        },
        connectionString: connection?.options.connectionString
      });
      const doc = await vscode.workspace.openTextDocument({ content: code, language: languageForExport(picked.id) });
      await vscode.window.showTextDocument(doc);
    }),

    vscode.commands.registerCommand('mongoCompass.openShellSnippet', async (arg?: CollectionNode) => {
      const { ns } = await resolveNamespace(connectionManager, arg);
      if (!ns) {
        return;
      }
      const { exportToLanguage } = await import('./core/exportToLanguage');
      const code = exportToLanguage('shell', {
        database: ns.database,
        collection: ns.collection,
        query: {
          filter: {},
          filterText: '',
          project: {},
          projectText: '',
          sort: {},
          sortText: '',
          collation: null,
          collationText: '',
          skip: 0,
          limit: getConfig().defaultLimit,
          maxTimeMS: getConfig().maxTimeMS
        }
      });
      await vscode.env.clipboard.writeText(code);
      void vscode.window.showInformationMessage('mongosh snippet copied to clipboard.');
    })
  );
}

async function resolveNamespace(
  connectionManager: ConnectionManager,
  arg?: CollectionNode
): Promise<{ ns?: Namespace; connId?: string }> {
  if (arg instanceof CollectionNode) {
    return { ns: arg.namespace, connId: arg.connection.options.id };
  }
  const connection = await requireConnection(connectionManager);
  const ns = await pickCollection(connection);
  return { ns, connId: connection.options.id };
}

async function pickCollection(connection: LiveConnection): Promise<Namespace | undefined> {
  const service = new DataService(connection.client, connection.options.id);
  const database = await pickDatabase(connection);
  if (!database) {
    return undefined;
  }
  const collections = await service.listCollections(database);
  const picked = await vscode.window.showQuickPick(
    collections.map((c) => ({ label: c.name, description: c.type })),
    { placeHolder: `Select a collection in ${database}` }
  );
  if (!picked) {
    return undefined;
  }
  return new Namespace(database, picked.label);
}

function languageForExport(id: string): string {
  switch (id) {
    case 'javascript':
    case 'shell':
      return 'javascript';
    case 'typescript':
      return 'typescript';
    case 'python':
      return 'python';
    case 'java':
      return 'java';
    case 'csharp':
      return 'csharp';
    case 'go':
      return 'go';
    case 'php':
      return 'php';
    case 'ruby':
      return 'ruby';
    case 'rust':
      return 'rust';
    default:
      return 'plaintext';
  }
}

// ───────────────────────────── tool commands ─────────────────────────────

function registerToolCommands(context: vscode.ExtensionContext, s: Services): void {
  const { connectionManager } = s;

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.dumpDatabase', async (arg?: DatabaseNode) => {
      if (!await ensureMongoToolAvailable('mongodump')) {
        return;
      }
      const connection = arg?.connection ?? await requireConnection(connectionManager);
      const databaseName = arg?.database.name ?? await pickDatabase(connection);
      if (!databaseName) {
        return;
      }
      const safeDatabaseName = databaseName.replace(/[^a-zA-Z0-9._-]+/g, '_');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = await vscode.window.showSaveDialog({
        title: `Export ${databaseName} as mongodump`,
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${safeDatabaseName}-${timestamp}.archive.gz`)),
        filters: { 'Compressed mongodump archive': ['archive.gz', 'gz'] }
      });
      if (!target) {
        return;
      }

      runMongoToolInTerminal(
        `mongodump: ${databaseName}`,
        {
          MONGO_COMPASS_URI: connectionStringForDatabase(connection.options.connectionString, databaseName),
          MONGO_COMPASS_DUMP: target.fsPath
        },
        (ref) =>
          `mongodump --uri="${ref('MONGO_COMPASS_URI')}" --archive="${ref('MONGO_COMPASS_DUMP')}" --gzip`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.restoreDatabase', async (arg?: DatabaseNode | DatabasesNode) => {
      if (!await ensureMongoToolAvailable('mongorestore')) {
        return;
      }
      const connection = arg?.connection ?? connectionManager.activeConnection;
      if (!connection) {
        void vscode.window.showErrorMessage('Connect to a server first.');
        return;
      }

      const selectedDatabaseName = arg instanceof DatabaseNode ? arg.database.name : undefined;
      const databaseName = selectedDatabaseName ?? await vscode.window.showInputBox({
        title: 'Import mongodump',
        prompt: 'Target database name',
        validateInput: (value) => value.trim() ? null : 'Database name is required'
      });
      if (!databaseName) {
        return;
      }

      const sourceDatabaseName = await vscode.window.showInputBox({
        title: 'Import mongodump',
        prompt: 'Database name stored in the dump',
        value: databaseName,
        validateInput: (value) => value.trim() ? null : 'Source database name is required'
      });
      if (!sourceDatabaseName) {
        return;
      }

      const source = await vscode.window.showOpenDialog({
        title: 'Select mongodump archive or dump directory',
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { 'MongoDB dump archives': ['archive', 'gz'], 'All files': ['*'] }
      });
      if (!source?.[0]) {
        return;
      }

      const restoreMode = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Keep existing collections and restore dump documents', drop: false },
          { label: 'Replace', description: 'Drop collections from the dump before restoring them', drop: true }
        ],
        { title: 'Restore mode', placeHolder: 'Choose how to handle existing collections' }
      );
      if (!restoreMode) {
        return;
      }

      const dumpPath = source[0].fsPath;
      const sourceStat = await vscode.workspace.fs.stat(source[0]);
      const isDirectory = (sourceStat.type & vscode.FileType.Directory) !== 0;
      const isGzip = dumpPath.toLowerCase().endsWith('.gz');
      runMongoToolInTerminal(
        `Restore: ${databaseName.trim()}`,
        {
          MONGO_COMPASS_URI: connection.options.connectionString,
          MONGO_COMPASS_DATABASE: databaseName.trim(),
          MONGO_COMPASS_SOURCE_DATABASE: sourceDatabaseName.trim(),
          MONGO_COMPASS_DUMP: dumpPath
        },
        (ref) => ['mongorestore',
          `--uri="${ref('MONGO_COMPASS_URI')}"`,
          `--nsFrom="${ref('MONGO_COMPASS_SOURCE_DATABASE')}.*"`,
          `--nsTo="${ref('MONGO_COMPASS_DATABASE')}.*"`,
          restoreMode.drop ? '--drop' : '',
          isGzip ? '--gzip' : '',
          isDirectory ? `"${ref('MONGO_COMPASS_DUMP')}"` : `--archive="${ref('MONGO_COMPASS_DUMP')}"`
        ].filter(Boolean).join(' ')
      );
    }),

    vscode.commands.registerCommand('mongoCompass.exportCollection', async (arg?: CollectionNode) => {
      if (!await ensureMongoToolAvailable('mongodump')) {
        return;
      }
      if (!(arg instanceof CollectionNode)) {
        return;
      }

      const ns = arg.namespace;
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const target = await vscode.window.showSaveDialog({
        title: `Export ${ns.toString()} as mongodump`,
        defaultUri: vscode.Uri.file(path.join(os.homedir(), `${ns.database}-${ns.collection}-${timestamp}.archive.gz`)),
        filters: { 'Compressed mongodump archive': ['gz'] }
      });
      if (!target) {
        return;
      }

      runMongoToolInTerminal(
        `mongodump: ${ns.toString()}`,
        {
          MONGO_COMPASS_URI: connectionStringForDatabase(arg.connection.options.connectionString, ns.database),
          MONGO_COMPASS_COLLECTION: ns.collection,
          MONGO_COMPASS_DUMP: target.fsPath
        },
        (ref) =>
          `mongodump --uri="${ref('MONGO_COMPASS_URI')}" --collection="${ref('MONGO_COMPASS_COLLECTION')}" ` +
          `--archive="${ref('MONGO_COMPASS_DUMP')}" --gzip`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.importCollection', async (arg?: CollectionNode) => {
      if (!await ensureMongoToolAvailable('mongorestore')) {
        return;
      }
      if (!(arg instanceof CollectionNode)) {
        return;
      }

      const source = await vscode.window.showOpenDialog({
        title: `Import mongodump into ${arg.namespace.toString()}`,
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { 'MongoDB dump archives': ['archive', 'gz'], 'All files': ['*'] }
      });
      if (!source?.[0]) {
        return;
      }

      const restoreMode = await vscode.window.showQuickPick(
        [
          { label: 'Merge', description: 'Keep existing documents', drop: false },
          { label: 'Replace', description: 'Drop the collection before restoring it', drop: true }
        ],
        { title: 'Import mode' }
      );
      if (!restoreMode) {
        return;
      }

      const dumpPath = source[0].fsPath;
      const sourceStat = await vscode.workspace.fs.stat(source[0]);
      const isDirectory = (sourceStat.type & vscode.FileType.Directory) !== 0;
      const isGzip = dumpPath.toLowerCase().endsWith('.gz');
      runMongoToolInTerminal(
        `mongorestore: ${arg.namespace.toString()}`,
        {
          MONGO_COMPASS_URI: arg.connection.options.connectionString,
          MONGO_COMPASS_DATABASE: arg.namespace.database,
          MONGO_COMPASS_COLLECTION: arg.namespace.collection,
          MONGO_COMPASS_DUMP: dumpPath
        },
        (ref) => ['mongorestore',
          `--uri="${ref('MONGO_COMPASS_URI')}"`,
          `--nsInclude="*.${ref('MONGO_COMPASS_COLLECTION')}"`,
          `--nsFrom="*.${ref('MONGO_COMPASS_COLLECTION')}"`,
          `--nsTo="${ref('MONGO_COMPASS_DATABASE')}.${ref('MONGO_COMPASS_COLLECTION')}"`,
          restoreMode.drop ? '--drop' : '',
          isGzip ? '--gzip' : '',
          isDirectory ? `"${ref('MONGO_COMPASS_DUMP')}"` : `--archive="${ref('MONGO_COMPASS_DUMP')}"`
        ].filter(Boolean).join(' ')
      );
    }),

    vscode.commands.registerCommand('mongoCompass.showServerStatus', async () => {
      const connection = await requireConnection(connectionManager);
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'serverStatus',
        { connectionId: connection.options.id },
        `Server Status — ${connection.options.name}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.showPerformanceMetrics', async (arg?: ConnectionNode) => {
      const connection = arg instanceof ConnectionNode
        ? await connectionManager.requireClient(arg.connection.options.id)
        : await requireConnection(connectionManager);
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'performanceMetrics',
        { connectionId: connection.options.id },
        'Performance Metrics'
      );
    }),

    vscode.commands.registerCommand('mongoCompass.showCurrentOp', async () => {
      const connection = await requireConnection(connectionManager);
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'currentOp',
        { connectionId: connection.options.id },
        `Current Operations — ${connection.options.name}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.showQueryHistory', () => {
      const connection = connectionManager.activeConnection;
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'queryHistory',
        { connectionId: connection?.options.id ?? '' },
        'Query History'
      );
    }),

    vscode.commands.registerCommand('mongoCompass.clearQueryHistory', async () => {
      const confirmed = await confirmDangerous('Clear all query history?');
      if (!confirmed) {
        return;
      }
      s.history.clear();
      void vscode.window.showInformationMessage('Query history cleared.');
    }),

    vscode.commands.registerCommand('mongoCompass.showSavedQueries', () => {
      const connection = connectionManager.activeConnection;
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'savedQueries',
        { connectionId: connection?.options.id ?? '' },
        'My Queries'
      );
    }),

    vscode.commands.registerCommand('mongoCompass.runCommand', async (arg?: DatabaseNode) => {
      const connection = arg?.connection ?? connectionManager.activeConnection ?? (await requireConnection(connectionManager));
      const database =
        arg instanceof DatabaseNode ? arg.database.name : await pickDatabase(connection);
      if (!database) {
        return;
      }
      DataPanel.open(
        context.extensionUri,
        connectionManager,
        s.history,
        s.myQueries,
        'databaseCommand',
        {
          connectionId: connection.options.id,
          database,
          extra: { commandText: '{\n  ping: 1\n}' }
        },
        `Database Command — ${database}`
      );
    }),

    vscode.commands.registerCommand('mongoCompass.killOp', async () => {
      void vscode.window.showInformationMessage('Use the Current Operations view to kill an operation.');
      await vscode.commands.executeCommand('mongoCompass.showCurrentOp');
    })
  );
}
