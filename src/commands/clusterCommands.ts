import * as vscode from 'vscode';
import { EJSON, type Document } from 'bson';
import type { ConnectionManager } from '../core/connectionManager';
import { ClusterService, compareVersions } from '../core/cluster/clusterService';
import type { ClusterMonitor } from '../core/cluster/clusterMonitor';
import { connectionStringForHosts, type NodeClientPool } from '../core/cluster/nodeClients';
import type { ReconfigPlan } from '../core/cluster/clusterService';
import type { ReplicaMember } from '../core/cluster/types';
import { parseShellBSON } from '../core/bsonParser';
import { DataService } from '../core/dataService';
import { logger } from '../core/logger';
import { ClusterTreeNode, type ClusterTarget, type ClusterTreeProvider } from '../explorer/clusterView';
import { CollectionNode, ConnectionNode, DatabaseNode } from '../explorer/mongoExplorer';
import { ClusterPanel } from '../webviews/clusterPanel';
import { findMongoTool, openMongosh } from './mongoTools';

export interface ClusterCommandServices {
  extensionUri: vscode.Uri;
  connectionManager: ConnectionManager;
  cluster: ClusterService;
  nodes: NodeClientPool;
  tree: ClusterTreeProvider;
  monitor: ClusterMonitor;
}

type TargetArg = ClusterTreeNode | ClusterTarget | ConnectionNode | CollectionNode | DatabaseNode | string | undefined;

/** Normalise whatever a command was invoked with (tree node, panel target, explorer node, id). */
async function resolveTarget(s: ClusterCommandServices, arg: TargetArg): Promise<ClusterTarget | undefined> {
  if (arg instanceof ClusterTreeNode) {
    return arg.target;
  }
  if (arg instanceof ConnectionNode) {
    return { connectionId: arg.connection.options.id };
  }
  if (arg instanceof CollectionNode) {
    return { connectionId: arg.connection.options.id, namespace: arg.namespace.toString(), database: arg.namespace.database };
  }
  if (arg instanceof DatabaseNode) {
    return { connectionId: arg.connection.options.id, database: arg.database.name };
  }
  if (typeof arg === 'string') {
    return { connectionId: arg };
  }
  if (arg && typeof arg === 'object' && 'connectionId' in arg) {
    return arg;
  }
  const connected = s.connectionManager.connected;
  if (connected.length === 0) {
    void vscode.window.showErrorMessage('Connect to a MongoDB deployment first.');
    return undefined;
  }
  if (connected.length === 1) {
    return { connectionId: connected[0].options.id };
  }
  const picked = await vscode.window.showQuickPick(
    connected.map((c) => ({ label: c.options.name, description: c.topology?.topologyType, id: c.options.id })),
    { placeHolder: 'Select a cluster' }
  );
  return picked ? { connectionId: picked.id } : undefined;
}

function requireHost(target: ClusterTarget): string {
  if (!target.host) {
    throw new Error('Select a replica set member.');
  }
  return target.host;
}

async function confirm(message: string, detail: string | undefined, action: string): Promise<boolean> {
  const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, action);
  return answer === action;
}

/** Show a reconfig's safety report and ask before applying it. */
async function confirmPlan(title: string, plan: ReconfigPlan): Promise<boolean> {
  if (plan.report.errors.length) {
    const forceAnswer = await vscode.window.showErrorMessage(
      `${title}: this change is not safe.`,
      { modal: true, detail: [...plan.report.errors.map((e) => `✖ ${e}`), ...plan.report.warnings.map((w) => `⚠ ${w}`)].join('\n') },
      'Show config'
    );
    if (forceAnswer) {
      const doc = await vscode.workspace.openTextDocument({ content: EJSON.stringify(plan.next, undefined, 2, { relaxed: true }), language: 'json' });
      await vscode.window.showTextDocument(doc, { preview: true });
    }
    return false;
  }
  return confirm(title, plan.report.warnings.length ? plan.report.warnings.map((w) => `⚠ ${w}`).join('\n') : `New config version ${plan.next.version}. All safety checks passed.`, 'Apply');
}

async function openJson(title: string, value: unknown): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({ content: `// ${title}\n${EJSON.stringify(value as Document, undefined, 2, { relaxed: true })}`, language: 'jsonc' });
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function pickShard(s: ClusterCommandServices, connectionId: string, placeHolder: string, exclude?: string): Promise<string | undefined> {
  const connection = await s.connectionManager.requireClient(connectionId);
  const { shards } = await connection.client.db('admin').command({ listShards: 1 });
  const ids = ((shards ?? []) as Document[]).map((x) => String(x._id)).filter((id) => id !== exclude);
  return vscode.window.showQuickPick(ids, { placeHolder });
}

async function pickNamespace(s: ClusterCommandServices, target: ClusterTarget, placeHolder: string): Promise<string | undefined> {
  if (target.namespace) {
    return target.namespace;
  }
  const connection = await s.connectionManager.requireClient(target.connectionId);
  const service = new DataService(connection.client, connection.options.id);
  const databases = (await service.listDatabases()).map((d) => d.name).filter((d) => !['admin', 'local', 'config'].includes(d));
  const database = target.database ?? (await vscode.window.showQuickPick(databases, { placeHolder: 'Database' }));
  if (!database) {
    return undefined;
  }
  const collections = (await service.listCollections(database)).filter((c) => c.type !== 'view').map((c) => c.name);
  const collection = await vscode.window.showQuickPick(collections, { placeHolder });
  return collection ? `${database}.${collection}` : undefined;
}

async function askShardKey(prompt: string, value = '{ _id: "hashed" }'): Promise<Document | undefined> {
  const text = await vscode.window.showInputBox({
    title: prompt,
    prompt: 'Shard key, e.g. { customerId: 1 }, { _id: "hashed" } or { region: 1, orderId: 1 }',
    value,
    validateInput: (v) => {
      try {
        const key = parseShellBSON(v);
        return Object.keys(key).length ? null : 'At least one field is required';
      } catch (err) {
        return (err as Error).message;
      }
    }
  });
  return text === undefined ? undefined : parseShellBSON(text);
}

async function withProgress<T>(title: string, task: (report: (message: string) => void) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, (progress) =>
    task((message) => progress.report({ message }))
  );
}

export function registerClusterCommands(context: vscode.ExtensionContext, s: ClusterCommandServices): void {
  const { cluster } = s;

  /** Register a command that resolves its target, reports errors and refreshes the views. */
  const command = (id: string, handler: (target: ClusterTarget) => Promise<string | void>): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg: TargetArg) => {
        let target: ClusterTarget | undefined;
        try {
          target = await resolveTarget(s, arg);
          if (!target) {
            return;
          }
          const message = await handler(target);
          if (message) {
            void vscode.window.showInformationMessage(message);
          }
        } catch (err) {
          const message = (err as Error).message;
          logger.error(`${id} failed`, { error: message });
          void vscode.window.showErrorMessage(message);
        } finally {
          if (target) {
            s.tree.refresh(target.connectionId);
            void s.monitor.checkNow();
          }
        }
      })
    );
  };

  // ───────────────────────────── views ─────────────────────────────

  command('mongoCompass.showClusterOverview', async (t) => {
    ClusterPanel.open(s.extensionUri, s.connectionManager, cluster, t.connectionId);
  });

  command('mongoCompass.cluster.manageUsers', async (t) => {
    ClusterPanel.open(s.extensionUri, s.connectionManager, cluster, t.connectionId, 'users');
  });

  context.subscriptions.push(vscode.commands.registerCommand('mongoCompass.cluster.refresh', () => s.tree.refresh()));

  // ───────────────────────────── members ─────────────────────────────

  command('mongoCompass.cluster.stepDown', async (t) => {
    const host = requireHost(t);
    const seconds = await vscode.window.showQuickPick(
      [
        { label: '60 seconds', value: 60, description: 'default' },
        { label: '120 seconds', value: 120 },
        { label: '300 seconds', value: 300, description: 'longer maintenance' }
      ],
      { title: `Step down ${host}`, placeHolder: 'How long the old primary stays ineligible' }
    );
    if (!seconds) {
      return;
    }
    await withProgress(`Stepping down ${host}`, async (report) => {
      await cluster.stepDown(t.connectionId, { host, stepDownSecs: seconds.value, catchUpSecs: 10 }).catch((err: Error) => {
        if (!/connection|closed|interrupted/i.test(err.message)) {
          throw err;
        }
      });
      report('Waiting for the election…');
      const primary = await cluster.waitForPrimary(t.connectionId, undefined, 60_000).catch(() => undefined);
      void vscode.window.showInformationMessage(primary ? `${primary} is the new primary.` : 'Step-down done; no primary yet.');
    });
  });

  command('mongoCompass.cluster.makePrimary', async (t) => {
    const host = requireHost(t);
    if (!(await confirm(`Make ${host} the primary?`, 'Other secondaries are frozen for up to 2 minutes and the current primary steps down. Clients see a short election (usually a few seconds).', 'Elect'))) {
      return;
    }
    return withProgress(`Electing ${host}`, (report) => cluster.makePrimary(t.connectionId, host, report));
  });

  command('mongoCompass.cluster.freeze', async (t) => {
    const host = requireHost(t);
    const value = await vscode.window.showInputBox({ title: `Freeze ${host}`, prompt: 'Seconds the member must not seek election (0 unfreezes)', value: '120', validateInput: (v) => (/^\d+$/.test(v) ? null : 'A number of seconds') });
    if (value === undefined) {
      return;
    }
    await cluster.freeze(t.connectionId, host, Number(value));
    return Number(value) ? `${host} is frozen for ${value}s.` : `${host} is unfrozen.`;
  });

  command('mongoCompass.cluster.unfreeze', async (t) => {
    await cluster.freeze(t.connectionId, requireHost(t), 0);
    return `${t.host} is unfrozen.`;
  });

  command('mongoCompass.cluster.maintenance', async (t) => {
    const host = requireHost(t);
    const enable = t.state !== 'RECOVERING';
    if (enable && !(await confirm(`Put ${host} into maintenance mode?`, 'The member switches to RECOVERING and stops serving reads until maintenance is turned off.', 'Enable'))) {
      return;
    }
    await cluster.setMaintenance(t.connectionId, host, enable);
    return `${host}: maintenance ${enable ? 'on' : 'off'}.`;
  });

  command('mongoCompass.cluster.syncFrom', async (t) => {
    const host = requireHost(t);
    const { info } = await cluster.replicaSetFor(t.connectionId, host);
    const source = await vscode.window.showQuickPick(
      info.members.filter((m) => m.host !== host && m.health === 1 && !m.arbiterOnly).map((m) => ({ label: m.host, description: m.state })),
      { title: `${host} syncs from…` }
    );
    if (!source) {
      return;
    }
    const result = await cluster.syncFrom(t.connectionId, host, source.label);
    return `${host} now syncs from ${source.label}${result.prevSyncTarget ? ` (was ${String(result.prevSyncTarget)})` : ''}.`;
  });

  command('mongoCompass.cluster.memberSettings', async (t) => {
    const host = requireHost(t);
    const { info } = await cluster.replicaSetFor(t.connectionId, host);
    const member = info.members.find((m) => m.host === host) as ReplicaMember | undefined;
    if (!member) {
      throw new Error(`${host} is not in the replica set config.`);
    }
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Priority', description: `now ${member.priority}`, key: 'priority' },
        { label: 'Votes', description: `now ${member.votes}`, key: 'votes' },
        { label: member.hidden ? 'Unhide' : 'Hide', description: 'hidden members are invisible to clients and never primary', key: 'hidden' },
        { label: 'Replication delay', description: `now ${member.secondaryDelaySecs}s`, key: 'delay' },
        { label: 'Tags', description: Object.entries(member.tags).map(([k, v]) => `${k}=${v}`).join(', ') || 'none', key: 'tags' }
      ],
      { title: `Member settings — ${host}` }
    );
    if (!choice) {
      return;
    }
    let changes: Parameters<typeof ClusterService.updateMemberTransform>[1] = {};
    switch (choice.key) {
      case 'priority': {
        const value = await vscode.window.showInputBox({ prompt: 'Priority (0 = never primary, higher wins elections)', value: String(member.priority), validateInput: (v) => (/^\d+(\.\d+)?$/.test(v) && Number(v) <= 1000 ? null : '0–1000') });
        if (value === undefined) {
          return;
        }
        changes = { priority: Number(value) };
        break;
      }
      case 'votes': {
        const value = await vscode.window.showQuickPick(['1', '0'], { placeHolder: 'Votes (a non-voting member also gets priority 0)' });
        if (!value) {
          return;
        }
        changes = { votes: Number(value) };
        break;
      }
      case 'hidden':
        changes = { hidden: !member.hidden };
        if (member.hidden) {
          changes.priority = 1;
        }
        break;
      case 'delay': {
        const value = await vscode.window.showInputBox({ prompt: 'Delay in seconds (0 disables; a delayed member gets priority 0 and should be hidden)', value: String(member.secondaryDelaySecs), validateInput: (v) => (/^\d+$/.test(v) ? null : 'Seconds') });
        if (value === undefined) {
          return;
        }
        changes = { secondaryDelaySecs: Number(value), ...(Number(value) > 0 ? { hidden: true } : {}) };
        break;
      }
      case 'tags': {
        const value = await vscode.window.showInputBox({ prompt: 'Tags as key=value, comma separated (empty clears)', value: Object.entries(member.tags).map(([k, v]) => `${k}=${v}`).join(', ') });
        if (value === undefined) {
          return;
        }
        changes = {
          tags: Object.fromEntries(
            value
              .split(',')
              .map((pair) => pair.split('=').map((x) => x.trim()))
              .filter((pair) => pair[0])
              .map(([k, v]) => [k, v ?? ''])
          )
        };
        break;
      }
    }
    const plan = await cluster.planReconfig(t.connectionId, ClusterService.updateMemberTransform(host, changes), host);
    if (!(await confirmPlan(`Change ${choice.label.toLowerCase()} of ${host}?`, plan))) {
      return;
    }
    await cluster.applyReconfig(t.connectionId, plan.next, { host });
    return `${host} updated (config version ${plan.next.version}).`;
  });

  command('mongoCompass.cluster.addMember', async (t) => {
    const host = await vscode.window.showInputBox({
      title: `Add a member${t.replicaSet ? ` to ${t.replicaSet}` : ''}`,
      prompt: 'host:port of a mongod started with the same --replSet (and keyFile, if auth is on)',
      placeHolder: 'mongo-4.example.internal:27017',
      validateInput: (v) => (/^[^\s:]+:\d+$/.test(v.trim()) ? null : 'host:port')
    });
    if (!host) {
      return;
    }
    const kind = await vscode.window.showQuickPick(
      [
        { label: 'Secondary', description: 'votes, can become primary', value: 'secondary' },
        { label: 'Hidden secondary', description: 'for backups / analytics; priority 0', value: 'hidden' },
        { label: 'Delayed secondary', description: 'hidden, lagging by a fixed time (protection from mistakes)', value: 'delayed' },
        { label: 'Non-voting secondary', description: 'beyond 7 voting members', value: 'nonvoting' },
        { label: 'Arbiter', description: 'votes, holds no data', value: 'arbiter' }
      ],
      { title: `Member type for ${host}` }
    );
    if (!kind) {
      return;
    }
    let delay = 0;
    if (kind.value === 'delayed') {
      const value = await vscode.window.showInputBox({ prompt: 'Delay in seconds', value: '3600', validateInput: (v) => (/^\d+$/.test(v) && Number(v) > 0 ? null : 'Seconds > 0') });
      if (!value) {
        return;
      }
      delay = Number(value);
    }
    const plan = await cluster.planReconfig(
      t.connectionId,
      ClusterService.addMemberTransform({
        host: host.trim(),
        arbiterOnly: kind.value === 'arbiter',
        hidden: kind.value === 'hidden' || kind.value === 'delayed',
        secondaryDelaySecs: delay || undefined,
        votes: kind.value === 'nonvoting' ? 0 : 1
      }),
      t.host
    );
    if (!(await confirmPlan(`Add ${host} as ${kind.label.toLowerCase()}?`, plan))) {
      return;
    }
    await cluster.applyReconfig(t.connectionId, plan.next, { host: t.host });
    return `${host} added; it runs an initial sync before it becomes SECONDARY.`;
  });

  command('mongoCompass.cluster.removeMember', async (t) => {
    const host = requireHost(t);
    if (t.state === 'PRIMARY') {
      throw new Error(`${host} is the primary. Step it down first.`);
    }
    const plan = await cluster.planReconfig(t.connectionId, ClusterService.removeMemberTransform(host), host);
    if (!(await confirmPlan(`Remove ${host} from ${t.replicaSet ?? 'the replica set'}?`, plan))) {
      return;
    }
    await cluster.applyReconfig(t.connectionId, plan.next, { host });
    return `${host} removed from the replica set. Shut its mongod down before reusing the data directory.`;
  });

  // ───────────────────────────── per node ─────────────────────────────

  command('mongoCompass.cluster.nodeStatus', async (t) => {
    const host = requireHost(t);
    await openJson(`serverStatus — ${host}`, await cluster.nodeServerStatus(t.connectionId, host));
  });

  command('mongoCompass.cluster.nodeLog', async (t) => {
    const lines = await cluster.nodeLog(t.connectionId, t.host);
    const doc = await vscode.workspace.openTextDocument({ content: lines.join('\n'), language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  command('mongoCompass.cluster.nodeShell', async (t) => {
    const host = requireHost(t);
    const mongosh = await findMongoTool('mongosh');
    const connection = s.connectionManager.get(t.connectionId);
    if (!mongosh || !connection) {
      return;
    }
    const address = await s.nodes.resolve(t.connectionId, host);
    openMongosh(`mongosh: ${host}`, mongosh, connectionStringForHosts(connection.options.connectionString, [address], true));
  });

  command('mongoCompass.cluster.openOplog', async (t) => {
    await vscode.commands.executeCommand('mongoCompass.openDocuments', t.connectionId, 'local', 'oplog.rs', {
      sort: { $natural: -1 },
      sortText: '{ $natural: -1 }'
    });
  });

  // ───────────────────────────── sharding ─────────────────────────────

  command('mongoCompass.cluster.shardCollection', async (t) => {
    const namespace = await pickNamespace(s, t, 'Collection to shard');
    if (!namespace) {
      return;
    }
    const strategy = await vscode.window.showQuickPick(
      [
        { label: 'Hashed', description: 'even distribution of writes; range queries go to all shards', value: 'hashed' },
        { label: 'Ranged', description: 'targeted range queries; choose a high-cardinality, non-monotonic key', value: 'ranged' }
      ],
      { title: `Shard ${namespace}` }
    );
    if (!strategy) {
      return;
    }
    const key = await askShardKey(`Shard key for ${namespace}`, strategy.value === 'hashed' ? '{ _id: "hashed" }' : '{ customerId: 1, _id: 1 }');
    if (!key) {
      return;
    }
    const unique = strategy.value === 'ranged'
      ? (await vscode.window.showQuickPick(['No', 'Yes'], { placeHolder: 'Enforce uniqueness of the shard key?' })) === 'Yes'
      : false;
    if (!(await confirm(`Shard ${namespace} on ${JSON.stringify(key)}?`, 'The shard key can be refined or the collection resharded later, but choose carefully: it decides how data and queries are spread. An index on the key is created when the collection is empty; otherwise it must exist.', 'Shard'))) {
      return;
    }
    try {
      await withProgress(`Sharding ${namespace}`, () => cluster.shardCollection(t.connectionId, namespace, key, { unique }));
    } catch (err) {
      if (!/create an index/i.test((err as Error).message)) {
        throw err;
      }
      const create = await vscode.window.showWarningMessage(`${namespace} has data, so it needs an index on ${JSON.stringify(key)} first. Create it now?`, { modal: true, detail: 'Building the index on a large collection takes time and I/O on every shard member.' }, 'Create index and shard');
      if (!create) {
        return;
      }
      const connection = await s.connectionManager.requireClient(t.connectionId);
      const [database, ...rest] = namespace.split('.');
      await withProgress(`Creating index ${JSON.stringify(key)}`, () => connection.client.db(database).collection(rest.join('.')).createIndex(key, unique ? { unique: true } : {}));
      await withProgress(`Sharding ${namespace}`, () => cluster.shardCollection(t.connectionId, namespace, key, { unique }));
    }
    return `${namespace} is sharded on ${JSON.stringify(key)}.`;
  });

  command('mongoCompass.cluster.reshardCollection', async (t) => {
    const namespace = await pickNamespace(s, t, 'Collection to reshard');
    const key = namespace ? await askShardKey(`New shard key for ${namespace}`) : undefined;
    if (!namespace || !key) {
      return;
    }
    if (!(await confirm(`Reshard ${namespace} on ${JSON.stringify(key)}?`, 'Resharding copies the whole collection (5.0+). It needs free disk space of about 1.2× the collection on each shard and blocks writes for up to 2 seconds at the end.', 'Reshard'))) {
      return;
    }
    await withProgress(`Resharding ${namespace} (this can take a long time)`, () => cluster.reshardCollection(t.connectionId, namespace, key));
    return `${namespace} resharded.`;
  });

  command('mongoCompass.cluster.refineShardKey', async (t) => {
    const namespace = await pickNamespace(s, t, 'Collection');
    const key = namespace ? await askShardKey(`Refined key for ${namespace} (current key as prefix + new suffix fields)`, '{ customerId: 1, orderId: 1 }') : undefined;
    if (!namespace || !key) {
      return;
    }
    await cluster.refineShardKey(t.connectionId, namespace, key);
    return `Shard key of ${namespace} refined to ${JSON.stringify(key)}.`;
  });

  command('mongoCompass.cluster.unshardCollection', async (t) => {
    const namespace = await pickNamespace(s, t, 'Collection to unshard');
    if (!namespace) {
      return;
    }
    const shard = await pickShard(s, t.connectionId, 'Shard that keeps the whole collection');
    if (!shard || !(await confirm(`Unshard ${namespace} onto ${shard}?`, 'All data of the collection moves to one shard (8.0+).', 'Unshard'))) {
      return;
    }
    await withProgress(`Unsharding ${namespace}`, () => cluster.unshardCollection(t.connectionId, namespace, shard));
    return `${namespace} now lives on ${shard}.`;
  });

  command('mongoCompass.cluster.moveCollection', async (t) => {
    const namespace = await pickNamespace(s, t, 'Unsharded collection to move');
    const shard = namespace ? await pickShard(s, t.connectionId, 'Target shard') : undefined;
    if (!namespace || !shard) {
      return;
    }
    await withProgress(`Moving ${namespace} to ${shard}`, () => cluster.moveCollection(t.connectionId, namespace, shard));
    return `${namespace} moved to ${shard}.`;
  });

  command('mongoCompass.cluster.analyzeShardKey', async (t) => {
    const connection = await s.connectionManager.requireClient(t.connectionId);
    if (compareVersions(connection.topology?.serverVersion ?? '0', '7.0') < 0) {
      throw new Error('analyzeShardKey needs MongoDB 7.0 or newer.');
    }
    const namespace = await pickNamespace(s, t, 'Collection');
    const key = namespace ? await askShardKey(`Candidate shard key for ${namespace}`, '{ customerId: 1 }') : undefined;
    if (!namespace || !key) {
      return;
    }
    const analyze = (): Promise<Document> => withProgress(`Analyzing ${JSON.stringify(key)}`, () => cluster.analyzeShardKey(t.connectionId, namespace, key));
    let result: Document;
    try {
      result = await analyze();
    } catch (err) {
      if (!/supporting index/i.test((err as Error).message)) {
        throw err;
      }
      const create = await vscode.window.showWarningMessage(`analyzeShardKey needs an index that starts with ${JSON.stringify(key)}. Create it now?`, { modal: true }, 'Create index');
      if (!create) {
        return;
      }
      const [database, ...rest] = namespace.split('.');
      await withProgress(`Creating index ${JSON.stringify(key)}`, () => connection.client.db(database).collection(rest.join('.')).createIndex(key));
      result = await analyze();
    }
    await openJson(`analyzeShardKey ${namespace} ${JSON.stringify(key)} — look at keyCharacteristics.numDistinctValues, mostCommonValues and monotonicity`, result);
  });

  command('mongoCompass.cluster.toggleCollectionBalancing', async (t) => {
    const namespace = await pickNamespace(s, t, 'Sharded collection');
    if (!namespace) {
      return;
    }
    const overview = await cluster.overview(t.connectionId);
    const current = overview.sharding?.collections.find((c) => c.namespace === namespace);
    const enable = current ? !current.balancingEnabled : true;
    await cluster.setCollectionBalancing(t.connectionId, namespace, enable);
    return `Balancing ${enable ? 'enabled' : 'disabled'} for ${namespace}.`;
  });

  command('mongoCompass.cluster.addShard', async (t) => {
    const value = await vscode.window.showInputBox({
      title: 'Add shard',
      prompt: 'Replica set connection: <replSetName>/<host1:port>,<host2:port> (members started with --shardsvr)',
      placeHolder: 'shard2/mongo-s2-a:27018,mongo-s2-b:27018,mongo-s2-c:27018',
      validateInput: (v) => (/^[^/\s]+\/[^\s]+$/.test(v.trim()) || /^[^\s:/]+:\d+$/.test(v.trim()) ? null : 'rsName/host:port,…')
    });
    if (!value) {
      return;
    }
    const name = await vscode.window.showInputBox({ prompt: 'Shard name (optional; defaults to the replica set name)' });
    const result = await withProgress('Adding shard', () => cluster.addShard(t.connectionId, value.trim(), name?.trim() || undefined));
    return `Shard ${String(result.shardAdded ?? name ?? value)} added. The balancer starts moving chunks to it.`;
  });

  command('mongoCompass.cluster.removeShard', async (t) => {
    const shard = t.shard ?? (await pickShard(s, t.connectionId, 'Shard to remove'));
    if (!shard) {
      return;
    }
    if (!(await confirm(`Remove shard ${shard}?`, 'The balancer moves every chunk off the shard (this can take hours). Databases whose primary shard it is must be moved with movePrimary. Run this command again to follow progress; it finishes when the state is "completed".', 'Start draining'))) {
      return;
    }
    const result = await cluster.removeShard(t.connectionId, shard);
    const dbs = (result.dbsToMove ?? []) as string[];
    if (dbs.length) {
      const move = await vscode.window.showWarningMessage(
        `${shard} is the primary shard of: ${dbs.join(', ')}. Move them now?`,
        'Move primaries'
      );
      if (move) {
        const to = await pickShard(s, t.connectionId, 'Move the databases to', shard);
        if (to) {
          for (const db of dbs) {
            await withProgress(`movePrimary ${db} → ${to}`, () => cluster.movePrimary(t.connectionId, db, to));
          }
        }
      }
    }
    return `removeShard ${shard}: ${String(result.state ?? result.msg ?? 'started')}${result.remaining ? ` — remaining ${JSON.stringify(result.remaining)}` : ''}`;
  });

  command('mongoCompass.cluster.movePrimary', async (t) => {
    const database = t.database ?? (await vscode.window.showInputBox({ prompt: 'Database' }));
    const to = database ? await pickShard(s, t.connectionId, `New primary shard for ${database}`) : undefined;
    if (!database || !to) {
      return;
    }
    if (!(await confirm(`Move the primary of ${database} to ${to}?`, 'Unsharded collections of the database are copied to the new shard. Writes to them are blocked while they move.', 'Move'))) {
      return;
    }
    await withProgress(`movePrimary ${database} → ${to}`, () => cluster.movePrimary(t.connectionId, database, to));
    return `${database} now has ${to} as its primary shard.`;
  });

  command('mongoCompass.cluster.startBalancer', async (t) => {
    await cluster.setBalancerRunning(t.connectionId, true);
    return 'Balancer started.';
  });

  command('mongoCompass.cluster.stopBalancer', async (t) => {
    if (!(await confirm('Stop the balancer?', 'It finishes the current migration first. Remember to start it again — chunks stop being spread while it is off.', 'Stop'))) {
      return;
    }
    await withProgress('Stopping the balancer', () => cluster.setBalancerRunning(t.connectionId, false));
    return 'Balancer stopped.';
  });

  command('mongoCompass.cluster.balancerWindow', async (t) => {
    const value = await vscode.window.showInputBox({
      title: 'Balancer window',
      prompt: 'Active window as HH:MM-HH:MM in the config servers\' time zone; empty to balance at any time',
      placeHolder: '23:00-06:00',
      validateInput: (v) => (!v.trim() || /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v.trim()) ? null : 'HH:MM-HH:MM')
    });
    if (value === undefined) {
      return;
    }
    const [start, stop] = value.trim().split('-');
    await cluster.setBalancerWindow(t.connectionId, value.trim() ? { start, stop } : null);
    return value.trim() ? `The balancer runs between ${start} and ${stop}.` : 'Balancer window removed.';
  });

  command('mongoCompass.cluster.addShardToZone', async (t) => {
    const shard = t.shard ?? (await pickShard(s, t.connectionId, 'Shard'));
    const zone = shard ? await vscode.window.showInputBox({ prompt: `Zone for ${shard}`, placeHolder: 'EU' }) : undefined;
    if (!shard || !zone) {
      return;
    }
    await cluster.addShardToZone(t.connectionId, shard, zone.trim());
    return `${shard} is in zone ${zone}. Assign key ranges to the zone from the cluster overview.`;
  });

  command('mongoCompass.cluster.removeShardFromZone', async (t) => {
    const shard = t.shard ?? (await pickShard(s, t.connectionId, 'Shard'));
    const zone = t.zone ?? (shard ? await vscode.window.showInputBox({ prompt: `Zone to remove ${shard} from` }) : undefined);
    if (!shard || !zone) {
      return;
    }
    await cluster.removeShardFromZone(t.connectionId, shard, zone);
    return `${shard} removed from zone ${zone}.`;
  });

  // ───────────────────────────── settings ─────────────────────────────

  command('mongoCompass.cluster.setFcv', async (t) => {
    const connection = await s.connectionManager.requireClient(t.connectionId);
    const version = connection.topology?.serverVersion ?? '';
    const [major, minor] = version.split('.');
    const current = `${major}.${minor}`;
    const candidates = [...new Set([current, `${Number(major) - 1}.0`, '8.0', '7.0', '6.0'])].filter((v) => compareVersions(v, current) <= 0);
    const picked = await vscode.window.showQuickPick(candidates, { title: `featureCompatibilityVersion (server ${version})`, placeHolder: 'Raise after an upgrade is final; lower before a downgrade' });
    if (!picked) {
      return;
    }
    if (!(await confirm(`Set featureCompatibilityVersion to ${picked}?`, 'Raising FCV enables features that persist on disk; downgrading the binaries afterwards needs FCV lowered again first.', 'Set'))) {
      return;
    }
    await withProgress(`setFeatureCompatibilityVersion ${picked}`, () => cluster.setFeatureCompatibilityVersion(t.connectionId, picked));
    return `featureCompatibilityVersion is ${picked}.`;
  });

  command('mongoCompass.cluster.setDefaultWriteConcern', async (t) => {
    const picked = await vscode.window.showQuickPick(
      [
        { label: 'majority', value: { w: 'majority' }, description: 'durable across failovers (default since 5.0)' },
        { label: '1', value: { w: 1 }, description: 'acknowledged by the primary only' },
        { label: 'majority, wtimeout 5s', value: { w: 'majority', wtimeout: 5000 } }
      ],
      { title: 'Cluster-wide default write concern (setDefaultRWConcern)' }
    );
    if (!picked) {
      return;
    }
    await cluster.setDefaultWriteConcern(t.connectionId, picked.value);
    return `Default write concern: ${JSON.stringify(picked.value)}.`;
  });

  command('mongoCompass.database.profiler', async (t) => {
    const database = t.database ?? (await vscode.window.showInputBox({ prompt: 'Database' }));
    if (!database) {
      return;
    }
    const current = await cluster.getProfilingLevel(t.connectionId, database);
    const level = await vscode.window.showQuickPick(
      [
        { label: 'Off', value: 0, description: current.level === 0 ? 'current' : '' },
        { label: 'Slow operations', value: 1, description: current.level === 1 ? 'current' : '' },
        { label: 'All operations', value: 2, description: `${current.level === 2 ? 'current · ' : ''}heavy; for short debugging sessions` },
        { label: 'Open system.profile', value: -1, description: 'browse recorded operations, newest first' }
      ],
      { title: `Profiler — ${database} (slowms ${current.slowms})` }
    );
    if (!level) {
      return;
    }
    if (level.value === -1) {
      await vscode.commands.executeCommand('mongoCompass.openDocuments', t.connectionId, database, 'system.profile', { sort: { ts: -1 }, sortText: '{ ts: -1 }' });
      return;
    }
    let slowms = current.slowms;
    if (level.value === 1) {
      const value = await vscode.window.showInputBox({ prompt: 'Slow operation threshold (ms)', value: String(current.slowms), validateInput: (v) => (/^\d+$/.test(v) ? null : 'Milliseconds') });
      if (value === undefined) {
        return;
      }
      slowms = Number(value);
    }
    await cluster.setProfilingLevel(t.connectionId, database, level.value, slowms);
    return `Profiler on ${database}: ${level.label.toLowerCase()}${level.value === 1 ? ` (> ${slowms} ms)` : ''}. On a replica set it applies to the member you are connected to.`;
  });
}
