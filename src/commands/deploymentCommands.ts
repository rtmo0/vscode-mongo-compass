import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import type { ConnectionManager } from '../core/connectionManager';
import type { ClusterService } from '../core/cluster/clusterService';
import { logger } from '../core/logger';
import { DeploymentItem, NodeItem, type DeploymentsTreeProvider } from '../explorer/deploymentsView';
import type { DeploymentRegistry } from '../deploy/registry';
import { Kubectl } from '../deploy/kubernetes/kubectl';
import { findFreePortRange, generatePassword, slugify, which } from '../deploy/process';
import { connectionStringForHosts } from '../core/cluster/nodeClients';
import { portsNeeded, replicaSetNames } from '../deploy/managedCluster';
import { rollingOperation } from '../deploy/rolling';
import type { AtlasCredentials } from '../deploy/atlas/atlasClient';
import type {
  AtlasSpec,
  DeploymentNode,
  DeploymentProvider,
  DeploymentRecord,
  DeploymentSpec,
  KubernetesFlavor,
  MemberKind,
  ProviderContext,
  ProviderId,
  TopologyKind
} from '../deploy/types';
import { findMongoTool, openMongosh, runMongoTool } from './mongoTools';

export interface DeploymentCommandServices {
  connectionManager: ConnectionManager;
  cluster: ClusterService;
  registry: DeploymentRegistry;
  tree: DeploymentsTreeProvider;
  refreshExplorer: () => void;
}

const DOCKER_VERSIONS = ['8.0', '7.0', '6.0'];
const DOCKER_PORT_RANGE = 20;

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}

/** Throw `Cancelled` when a prompt was dismissed, so wizards can bail out in one place. */
function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Cancelled();
  }
  return value;
}

async function pick<T>(items: Array<vscode.QuickPickItem & { value: T }>, title: string, placeHolder?: string): Promise<T> {
  const picked = await vscode.window.showQuickPick(items, { title, placeHolder, ignoreFocusOut: true });
  return required(picked).value;
}

async function ask(title: string, prompt: string, value = '', validate?: (v: string) => string | null, password = false): Promise<string> {
  return required(await vscode.window.showInputBox({ title, prompt, value, validateInput: validate, password, ignoreFocusOut: true }));
}

const isCount = (min: number, max: number) => (v: string): string | null =>
  /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max ? null : `A number from ${min} to ${max}`;

/** Ask for confirmation, typing the name when the target is protected (prod contexts, attached deployments). */
async function confirmDanger(message: string, detail: string, typeToConfirm?: string): Promise<boolean> {
  if (typeToConfirm) {
    const typed = await vscode.window.showInputBox({
      title: message,
      prompt: `${detail}\n\nType "${typeToConfirm}" to confirm.`,
      ignoreFocusOut: true,
      validateInput: (v) => (v === typeToConfirm ? null : `Type ${typeToConfirm}`)
    });
    return typed === typeToConfirm;
  }
  const answer = await vscode.window.showWarningMessage(message, { modal: true, detail }, 'Continue');
  return answer === 'Continue';
}

/** Name to type before changing a deployment in a protected Kubernetes context. */
function protection(record: DeploymentRecord): string | undefined {
  const k8s = record.spec.kubernetes;
  if (k8s && Kubectl.isProtected(k8s.context)) {
    return k8s.context;
  }
  return undefined;
}

export function registerDeploymentCommands(context: vscode.ExtensionContext, s: DeploymentCommandServices): void {
  const { registry } = s;

  const resolveRecord = async (arg: unknown): Promise<DeploymentRecord | undefined> => {
    if (arg instanceof DeploymentItem || arg instanceof NodeItem) {
      return registry.get(arg.record.id) ?? arg.record;
    }
    if (typeof arg === 'string') {
      return registry.get(arg);
    }
    const records = registry.all;
    if (!records.length) {
      void vscode.window.showInformationMessage('No deployments yet. Create one first.');
      return undefined;
    }
    if (records.length === 1) {
      return records[0];
    }
    const picked = await vscode.window.showQuickPick(
      records.map((r) => ({ label: r.spec.name, description: `${r.spec.provider} · ${r.spec.topology}`, record: r })),
      { placeHolder: 'Select a deployment' }
    );
    return picked?.record;
  };

  const resolveNode = async (record: DeploymentRecord, arg: unknown, placeHolder: string, filter: (n: DeploymentNode) => boolean = () => true): Promise<DeploymentNode | undefined> => {
    if (arg instanceof NodeItem) {
      return arg.node;
    }
    const status = await registry.provider(record.spec.provider).status(record);
    const nodes = status.nodes.filter(filter);
    const picked = await vscode.window.showQuickPick(
      nodes.map((n) => ({ label: n.name, description: [n.memberState, n.role, n.status].filter(Boolean).join(' · '), node: n })),
      { placeHolder }
    );
    return picked?.node;
  };

  /** Register a command: resolve the deployment, check the provider supports it, report errors, refresh. */
  const command = (
    id: string,
    capability: keyof DeploymentProvider | undefined,
    handler: (record: DeploymentRecord, provider: DeploymentProvider, arg: unknown) => Promise<string | void>
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (arg: unknown) => {
        try {
          const record = await resolveRecord(arg);
          if (!record) {
            return;
          }
          const provider = registry.provider(record.spec.provider);
          if (capability && typeof provider[capability] !== 'function') {
            throw new Error(`${provider.label} deployments do not support this operation.`);
          }
          const message = await handler(record, provider, arg);
          if (message) {
            void vscode.window.showInformationMessage(message);
          }
        } catch (err) {
          if (err instanceof Cancelled || (err as Error).message === 'Cancelled') {
            return;
          }
          logger.error(`${id} failed`, { error: (err as Error).message });
          void vscode.window.showErrorMessage((err as Error).message);
        } finally {
          s.tree.refresh();
        }
      })
    );
  };

  const connectionFor = async (record: DeploymentRecord): Promise<string> => {
    if (record.connectionId && s.connectionManager.state(record.connectionId) === 'connected') {
      return record.connectionId;
    }
    return registry.connect(record);
  };

  // ───────────────────────────── create ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.deploy.create', async (providerArg?: ProviderId) => {
      try {
        const result = await createWizard(s, providerArg);
        if (!result) {
          return;
        }
        const record = await registry.create(result.spec, result.password);
        s.refreshExplorer();
        const next = await vscode.window.showInformationMessage(
          `Deployment "${record.spec.name}" is ready.`,
          'Connect & show cluster',
          'Copy password'
        );
        if (next === 'Connect & show cluster') {
          const connectionId = await registry.connect(record);
          s.refreshExplorer();
          await vscode.commands.executeCommand('mongoCompass.showClusterOverview', connectionId);
        } else if (next === 'Copy password' && result.password) {
          await vscode.env.clipboard.writeText(result.password);
        }
      } catch (err) {
        if (err instanceof Cancelled) {
          return;
        }
        logger.error('Create deployment failed', { error: (err as Error).message });
        void vscode.window.showErrorMessage(`Deployment failed: ${(err as Error).message}`, 'Show log').then((a) => a && logger.show());
      } finally {
        s.tree.refresh();
      }
    })
  );

  // ───────────────────────────── attach / import ─────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('mongoCompass.deploy.attachKubernetes', async () => {
      try {
        const unavailable = await Kubectl.available();
        if (unavailable) {
          throw new Error(unavailable);
        }
        const { kubectl } = await pickKubeTarget('Attach existing deployment');
        const found = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Looking for MongoDB in ${kubectl.namespace}…` }, () => registry.kubernetes.discover(kubectl));
        if (!found.length) {
          void vscode.window.showInformationMessage(`No Percona, MongoDBCommunity or mongo StatefulSet found in ${kubectl.context}/${kubectl.namespace}.`);
          return;
        }
        const target = await pick(found.map((f) => ({ label: f.name, description: f.detail, value: f })), 'Deployment to attach');
        let username = 'root';
        let password: string | undefined;
        let topology: TopologyKind = 'replicaSet';
        let members = 3;
        let selector: string | undefined;
        let serviceName: string | undefined;
        if (target.flavor === 'percona') {
          const sharded = Boolean((target.object.spec?.sharding as { enabled?: boolean } | undefined)?.enabled);
          topology = sharded ? 'sharded' : 'replicaSet';
          members = Number(((target.object.spec?.replsets ?? []) as Array<{ size?: number }>)[0]?.size ?? 3);
          const usersSecret = String((target.object.spec?.secrets as { users?: string } | undefined)?.users ?? `${target.name}-secrets`);
          const which = await pick(
            [
              { label: 'Cluster admin', description: 'MONGODB_CLUSTER_ADMIN — manage replica sets and sharding (no data access)', value: 'CLUSTER_ADMIN' },
              { label: 'Database admin', description: 'MONGODB_DATABASE_ADMIN — read and write data', value: 'DATABASE_ADMIN' },
              { label: 'Enter credentials', value: 'manual' }
            ],
            'Credentials'
          );
          if (which !== 'manual') {
            username = (await kubectl.secretValue(usersSecret, `MONGODB_${which}_USER`)) ?? '';
            password = await kubectl.secretValue(usersSecret, `MONGODB_${which}_PASSWORD`);
          }
        } else if (target.flavor === 'community') {
          members = Number(target.object.spec?.members ?? 3);
          const user = ((target.object.spec?.users ?? []) as Array<{ name: string; passwordSecretRef?: { name: string; key?: string } }>)[0];
          if (user) {
            username = user.name;
            if (user.passwordSecretRef) {
              password = await kubectl.secretValue(user.passwordSecretRef.name, user.passwordSecretRef.key ?? 'password');
            }
          }
        } else {
          members = Number(target.object.spec?.replicas ?? 1);
          const labels = ((target.object.spec?.selector as { matchLabels?: Record<string, string> } | undefined)?.matchLabels ?? {});
          selector = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',');
          serviceName = String(target.object.spec?.serviceName ?? target.name);
          topology = await pick(
            [
              { label: 'Replica set', value: 'replicaSet' as TopologyKind },
              { label: 'Standalone', value: 'standalone' as TopologyKind }
            ],
            'Topology of the StatefulSet'
          );
        }
        if (!password || !username) {
          username = await ask('Credentials', 'User name (empty if authentication is disabled)', username);
          password = username ? await ask('Credentials', `Password for ${username}`, '', undefined, true) : undefined;
        }
        const spec: DeploymentSpec = {
          name: await ask('Name', 'Name in VS Code', target.name),
          provider: 'kubernetes',
          topology,
          version: '',
          members,
          arbiter: false,
          shards: 1,
          configServers: 3,
          routers: 1,
          auth: Boolean(username),
          username,
          kubernetes: {
            context: kubectl.context,
            namespace: kubectl.namespace,
            flavor: target.flavor,
            resourceName: target.name,
            storageSize: '',
            imported: true,
            selector,
            serviceName
          }
        };
        const record = await registry.attach(spec, password);
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${spec.name}…` }, () => registry.connect(record));
        s.refreshExplorer();
        void vscode.window.showInformationMessage(`Attached ${spec.name}; connected through kubectl port-forward.`);
      } catch (err) {
        if (!(err instanceof Cancelled)) {
          void vscode.window.showErrorMessage((err as Error).message);
        }
      } finally {
        s.tree.refresh();
      }
    }),

    vscode.commands.registerCommand('mongoCompass.deploy.atlasSignIn', async () => {
      try {
        const kind = await pick(
          [
            { label: 'Service account', description: 'client ID + secret (recommended)', value: 'serviceAccount' as const },
            { label: 'API key', description: 'public + private key (digest auth)', value: 'apiKey' as const }
          ],
          'Atlas credentials'
        );
        let credentials: AtlasCredentials;
        if (kind === 'serviceAccount') {
          credentials = {
            kind,
            clientId: await ask('Atlas service account', 'Client ID', '', (v) => (v.trim() ? null : 'Required')),
            clientSecret: await ask('Atlas service account', 'Client secret', '', (v) => (v ? null : 'Required'), true)
          };
        } else {
          credentials = {
            kind,
            publicKey: await ask('Atlas API key', 'Public key', '', (v) => (v.trim() ? null : 'Required')),
            privateKey: await ask('Atlas API key', 'Private key', '', (v) => (v ? null : 'Required'), true)
          };
        }
        await registry.setAtlasCredentials(credentials);
        const projects = await registry.atlas.projects();
        void vscode.window.showInformationMessage(`Signed in to Atlas — ${projects.length} project(s) visible.`, 'Import clusters').then((a) => {
          if (a) {
            void vscode.commands.executeCommand('mongoCompass.deploy.importAtlas');
          }
        });
      } catch (err) {
        if (!(err instanceof Cancelled)) {
          await registry.setAtlasCredentials(undefined);
          void vscode.window.showErrorMessage(`Atlas sign-in failed: ${(err as Error).message}`);
        }
      }
    }),

    vscode.commands.registerCommand('mongoCompass.deploy.atlasSignOut', async () => {
      await registry.setAtlasCredentials(undefined);
      void vscode.window.showInformationMessage('Atlas credentials removed.');
    }),

    vscode.commands.registerCommand('mongoCompass.deploy.importAtlas', async () => {
      try {
        if (!(await registry.atlasCredentials())) {
          await vscode.commands.executeCommand('mongoCompass.deploy.atlasSignIn');
          if (!(await registry.atlasCredentials())) {
            return;
          }
        }
        const projects = await registry.atlas.projects();
        const project = await pick(projects.map((p) => ({ label: p.name, description: p.id, value: p })), 'Atlas project');
        const clusters = await registry.atlas.clusters(project.id);
        const known = new Set(registry.all.filter((r) => r.spec.atlas?.projectId === project.id).map((r) => r.spec.atlas?.clusterName));
        const picked = await vscode.window.showQuickPick(
          clusters.filter((c) => !known.has(c.name)).map((c) => ({ label: c.name, description: `${c.flex ? 'Flex' : c.clusterType ?? ''} · ${c.stateName ?? ''} · ${c.mongoDBVersion ?? ''}`, cluster: c })),
          { canPickMany: true, title: `Import clusters from ${project.name}` }
        );
        if (!picked?.length) {
          return;
        }
        for (const item of picked) {
          const c = item.cluster;
          const region = c.replicationSpecs?.[0]?.regionConfigs?.[0];
          const size = region?.electableSpecs?.instanceSize ?? '';
          const atlasSpec: AtlasSpec = {
            projectId: project.id,
            projectName: project.name,
            clusterName: c.name,
            tier: c.flex ? 'flex' : size === 'M0' ? 'free' : 'dedicated',
            instanceSize: size || undefined,
            cloudProvider: ((region?.backingProviderName ?? region?.providerName ?? c.providerSettings?.backingProviderName ?? 'AWS') as AtlasSpec['cloudProvider']),
            region: region?.regionName ?? c.providerSettings?.regionName ?? '',
            imported: true
          };
          const username = await vscode.window.showInputBox({ title: `Database user for ${c.name}`, prompt: 'Existing Atlas database user (empty to set later)', ignoreFocusOut: true });
          const password = username ? await vscode.window.showInputBox({ title: `Database user for ${c.name}`, prompt: `Password of ${username}`, password: true, ignoreFocusOut: true }) : undefined;
          await registry.attach(
            {
              name: c.name,
              provider: 'atlas',
              topology: c.clusterType === 'SHARDED' ? 'sharded' : 'replicaSet',
              version: c.mongoDBMajorVersion ?? c.mongoDBVersion ?? '',
              members: region?.electableSpecs?.nodeCount ?? 3,
              arbiter: false,
              shards: c.replicationSpecs?.length ?? 1,
              configServers: 3,
              routers: 1,
              auth: Boolean(username),
              username: username ?? '',
              atlas: atlasSpec
            },
            password
          );
        }
        void vscode.window.showInformationMessage(`Imported ${picked.length} Atlas cluster(s).`);
      } catch (err) {
        if (!(err instanceof Cancelled)) {
          void vscode.window.showErrorMessage((err as Error).message);
        }
      } finally {
        s.tree.refresh();
      }
    }),

    vscode.commands.registerCommand('mongoCompass.deploy.refresh', () => s.tree.refresh())
  );

  // ───────────────────────────── lifecycle ─────────────────────────────

  command('mongoCompass.deploy.connect', undefined, async (record) => {
    const connectionId = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${record.spec.name}…` }, () => registry.connect(record));
    s.refreshExplorer();
    await vscode.commands.executeCommand('mongoCompass.showClusterOverview', connectionId);
  });

  command('mongoCompass.deploy.start', 'start', async (record, provider) => {
    if (protection(record) && !(await confirmDanger(`Start ${record.spec.name}?`, `Context ${record.spec.kubernetes?.context} is protected.`, protection(record)))) {
      return;
    }
    await registry.withProgress(`Starting ${record.spec.name}`, (ctx) => (provider.start as NonNullable<DeploymentProvider['start']>)(record, ctx));
    return `${record.spec.name} started.`;
  });

  command('mongoCompass.deploy.stop', 'stop', async (record, provider) => {
    if (!(await confirmDanger(`Stop ${record.spec.name}?`, record.spec.provider === 'atlas' ? 'The Atlas cluster is paused (compute is not billed while paused).' : 'All nodes shut down cleanly. Data is kept.', protection(record)))) {
      return;
    }
    if (record.connectionId) {
      await s.connectionManager.disconnect(record.connectionId);
    }
    await registry.withProgress(`Stopping ${record.spec.name}`, (ctx) => (provider.stop as NonNullable<DeploymentProvider['stop']>)(record, ctx));
    s.refreshExplorer();
    return `${record.spec.name} stopped.`;
  });

  command('mongoCompass.deploy.destroy', undefined, async (record) => {
    const imported = record.spec.kubernetes?.imported || record.spec.atlas?.imported;
    const keep = await pick(
      [
        { label: 'Delete everything', description: record.spec.provider === 'atlas' ? 'the Atlas cluster is terminated' : 'containers / pods / processes and their data', value: false },
        ...(record.spec.provider !== 'atlas' ? [{ label: 'Keep data', description: 'remove the nodes but keep volumes / PVCs / data folders', value: true }] : [])
      ],
      `Destroy ${record.spec.name}`
    );
    const typed = imported || protection(record) || record.spec.provider === 'atlas' ? record.spec.name : undefined;
    if (!(await confirmDanger(`Destroy ${record.spec.name}?`, `${keep ? 'Nodes are removed, data is kept.' : 'All data is deleted permanently.'}${imported ? ' This deployment was not created by the extension.' : ''}`, typed))) {
      return;
    }
    await registry.destroy(record, keep, true);
    s.refreshExplorer();
    return `${record.spec.name} destroyed.`;
  });

  command('mongoCompass.deploy.forget', undefined, async (record) => {
    const removeConnection = await pick(
      [
        { label: 'Forget deployment and its connection', value: true },
        { label: 'Forget deployment, keep the connection', value: false }
      ],
      `Forget ${record.spec.name} (nothing is deleted)`
    );
    await registry.forget(record, removeConnection);
    s.refreshExplorer();
  });

  // ───────────────────────────── topology changes ─────────────────────────────

  const pickReplicaSet = async (record: DeploymentRecord, arg: unknown): Promise<string> => {
    if (arg instanceof NodeItem && arg.node.replicaSet) {
      return arg.node.replicaSet;
    }
    let sets = replicaSetNames(record);
    if (!sets.length) {
      const status = await registry.provider(record.spec.provider).status(record);
      sets = [...new Set(status.nodes.map((n) => n.replicaSet).filter((x): x is string => Boolean(x)))];
    }
    if (!sets.length) {
      sets = ['rs0'];
    }
    return sets.length === 1 ? sets[0] : pick(sets.map((x) => ({ label: x, value: x })), 'Replica set');
  };

  command('mongoCompass.deploy.addMember', 'addMember', async (record, provider, arg) => {
    if (record.spec.topology === 'standalone') {
      throw new Error('A standalone server has no replica set. Create a replica set deployment instead.');
    }
    const replicaSet = await pickReplicaSet(record, arg);
    const kind = await pick<MemberKind>(
      [
        { label: 'Secondary', value: 'secondary' },
        { label: 'Hidden secondary', description: 'priority 0, invisible to clients', value: 'hidden' },
        { label: 'Arbiter', description: 'votes but holds no data', value: 'arbiter' }
      ],
      `Add a member to ${replicaSet}`
    );
    if (protection(record) && !(await confirmDanger(`Add a member in ${record.spec.kubernetes?.context}?`, 'Protected context.', protection(record)))) {
      return;
    }
    const added = await registry.withProgress(`Adding a member to ${replicaSet}`, (ctx) => (provider.addMember as NonNullable<DeploymentProvider['addMember']>)(record, ctx, replicaSet, kind));
    return `Added ${added}.`;
  });

  command('mongoCompass.deploy.removeMember', 'removeMember', async (record, provider, arg) => {
    const node = await resolveNode(record, arg, 'Member to remove', (n) => Boolean(n.replicaSet) && n.role !== 'mongos');
    if (!node) {
      return;
    }
    if (!(await confirmDanger(`Remove ${node.name}?`, `It leaves replica set ${node.replicaSet} (a primary steps down first) and its node is deleted with its data.`, protection(record)))) {
      return;
    }
    await registry.withProgress(`Removing ${node.name}`, (ctx) => (provider.removeMember as NonNullable<DeploymentProvider['removeMember']>)(record, ctx, node.id));
    return `${node.name} removed.`;
  });

  command('mongoCompass.deploy.scale', 'scaleReplicaSet', async (record, provider, arg) => {
    const replicaSet = await pickReplicaSet(record, arg);
    const members = Number(await ask(`Scale ${replicaSet}`, 'Number of data-bearing members', String(record.spec.members), isCount(1, 7)));
    if (!(await confirmDanger(`Scale ${replicaSet} of ${record.spec.name} to ${members} members?`, 'Members are added or removed one at a time.', protection(record)))) {
      return;
    }
    await registry.withProgress(`Scaling ${replicaSet}`, (ctx) => (provider.scaleReplicaSet as NonNullable<DeploymentProvider['scaleReplicaSet']>)(record, ctx, replicaSet, members));
    return `${replicaSet} scaled to ${members}.`;
  });

  command('mongoCompass.deploy.addShard', 'addShard', async (record, provider) => {
    if (record.spec.topology !== 'sharded') {
      throw new Error('Shards can only be added to sharded deployments.');
    }
    if (!(await confirmDanger(`Add a shard to ${record.spec.name}?`, `A new replica set of ${record.spec.members} member(s) is created and registered with addShard.`, protection(record)))) {
      return;
    }
    const name = await registry.withProgress(`Adding a shard to ${record.spec.name}`, (ctx) => (provider.addShard as NonNullable<DeploymentProvider['addShard']>)(record, ctx));
    return `Shard ${name} added. The balancer moves chunks to it over time.`;
  });

  command('mongoCompass.deploy.removeShard', 'removeShard', async (record, provider, arg) => {
    let shard = arg instanceof NodeItem ? arg.node.replicaSet : undefined;
    if (!shard || shard === 'cfg') {
      const status = await provider.status(record);
      const shards = [...new Set(status.nodes.map((n) => n.replicaSet).filter((x): x is string => Boolean(x) && x !== 'cfg' && !/cfg/.test(x as string)))];
      shard = await pick(shards.map((x) => ({ label: x, value: x })), 'Shard to remove');
    }
    if (!(await confirmDanger(`Remove shard ${shard}?`, 'Its chunks are moved to the other shards first (removeShard + movePrimary); this can take a while. The nodes are deleted once draining completes.', protection(record) ?? (record.spec.provider === 'atlas' ? record.spec.name : undefined)))) {
      return;
    }
    await registry.withProgress(`Removing shard ${shard}`, (ctx) => (provider.removeShard as NonNullable<DeploymentProvider['removeShard']>)(record, ctx, shard as string));
    return `Shard ${shard} removed.`;
  });

  command('mongoCompass.deploy.addRouter', 'addRouter', async (record, provider) => {
    const added = await registry.withProgress(`Adding a router to ${record.spec.name}`, (ctx) => (provider.addRouter as NonNullable<DeploymentProvider['addRouter']>)(record, ctx));
    if (record.connectionId && record.spec.provider !== 'kubernetes') {
      await registry.ensureConnection(record);
    }
    return `Router ${added} added.`;
  });

  command('mongoCompass.deploy.removeRouter', 'removeRouter', async (record, provider, arg) => {
    const node = await resolveNode(record, arg, 'Router to remove', (n) => n.role === 'mongos');
    if (!node || !(await confirmDanger(`Remove router ${node.name}?`, 'Clients connected to it reconnect to another router.', protection(record)))) {
      return;
    }
    await registry.withProgress(`Removing ${node.name}`, (ctx) => (provider.removeRouter as NonNullable<DeploymentProvider['removeRouter']>)(record, ctx, node.id));
    if (record.connectionId && record.spec.provider !== 'kubernetes') {
      await registry.ensureConnection(registry.get(record.id) ?? record);
    }
    return `${node.name} removed.`;
  });

  // ───────────────────────────── nodes ─────────────────────────────

  const nodeCommand = (id: string, capability: keyof DeploymentProvider, verb: string, run: (record: DeploymentRecord, provider: DeploymentProvider, node: DeploymentNode, ctx: ProviderContext) => Promise<unknown>, danger?: string): void => {
    command(id, capability, async (record, provider, arg) => {
      const node = await resolveNode(record, arg, `Node to ${verb.toLowerCase()}`);
      if (!node) {
        return;
      }
      if (danger && !(await confirmDanger(`${verb} ${node.name}?`, danger, protection(record)))) {
        return;
      }
      await registry.withProgress(`${verb} ${node.name}`, (ctx) => run(record, provider, node, ctx));
      return `${verb}: ${node.name} done.`;
    });
  };

  nodeCommand('mongoCompass.deploy.restartNode', 'restartNode', 'Restart', (r, p, n, ctx) => (p.restartNode as NonNullable<DeploymentProvider['restartNode']>)(r, ctx, n.id), 'If it is the primary, an election follows.');
  nodeCommand('mongoCompass.deploy.startNode', 'start', 'Start', (r, p, n, ctx) => (p.start as NonNullable<DeploymentProvider['start']>)(r, ctx, n.id));
  nodeCommand('mongoCompass.deploy.stopNode', 'stop', 'Stop', (r, p, n, ctx) => (p.stop as NonNullable<DeploymentProvider['stop']>)(r, ctx, n.id), 'The node shuts down cleanly; the replica set keeps running if a majority remains.');
  nodeCommand('mongoCompass.deploy.killNode', 'chaos', 'Kill', (r, p, n, ctx) => (p.chaos as NonNullable<DeploymentProvider['chaos']>)(r, ctx, n.id, 'kill'), 'Simulates a crash (SIGKILL / forced pod deletion) to test failover.');
  nodeCommand('mongoCompass.deploy.pauseNode', 'chaos', 'Freeze', (r, p, n, ctx) => (p.chaos as NonNullable<DeploymentProvider['chaos']>)(r, ctx, n.id, 'pause'), 'Freezes the process: it stops answering heartbeats like a hung server or a network partition.');
  nodeCommand('mongoCompass.deploy.unpauseNode', 'chaos', 'Unfreeze', (r, p, n, ctx) => (p.chaos as NonNullable<DeploymentProvider['chaos']>)(r, ctx, n.id, 'unpause'));

  command('mongoCompass.deploy.logs', 'openLogs', async (record, provider, arg) => {
    const node = await resolveNode(record, arg, 'Logs of');
    if (node) {
      await (provider.openLogs as NonNullable<DeploymentProvider['openLogs']>)(record, node.id);
    }
  });

  command('mongoCompass.deploy.shell', undefined, async (record, provider, arg) => {
    const node = await resolveNode(record, arg, 'Open mongosh on', (n) => n.role !== 'arbiter');
    if (!node) {
      return;
    }
    // Prefer the local mongosh (credentials passed through the environment); fall back to the one in the container/pod.
    if (record.connectionId && node.address && record.spec.provider !== 'atlas') {
      const mongosh = await which('mongosh');
      const connection = s.connectionManager.get(record.connectionId);
      if (mongosh && connection) {
        const address = record.spec.provider === 'kubernetes' ? (await registry.kubernetes.resolveHost(record, node.address)) ?? node.address : node.address;
        openMongosh(`mongosh: ${node.name}`, mongosh, connectionStringForHosts(connection.options.connectionString, [address], true));
        return;
      }
    }
    if (!provider.openShell) {
      throw new Error('Install mongosh to open a shell on this node.');
    }
    await provider.openShell(record, node.id);
  });

  command('mongoCompass.deploy.describe', 'describeNode', async (record, provider, arg) => {
    const node = await resolveNode(record, arg, 'Describe');
    if (!node) {
      return;
    }
    const text = await (provider.describeNode as NonNullable<DeploymentProvider['describeNode']>)(record, node.id);
    const doc = await vscode.workspace.openTextDocument({ content: text, language: text.trim().startsWith('{') || text.trim().startsWith('[') ? 'json' : 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  // ───────────────────────────── rolling operations ─────────────────────────────

  command('mongoCompass.deploy.rollingRestart', 'restartNode', async (record, provider) => {
    if (!(await confirmDanger(`Rolling restart of ${record.spec.name}?`, 'Secondaries restart one at a time; each primary steps down before its restart. The balancer is paused meanwhile.', protection(record)))) {
      return;
    }
    const connectionId = await connectionFor(record);
    await registry.withProgress(`Rolling restart of ${record.spec.name}`, (ctx) =>
      rollingOperation(record, provider, s.cluster, connectionId, ctx, (node) => (provider.restartNode as NonNullable<DeploymentProvider['restartNode']>)(record, ctx, node.id))
    );
    return `Rolling restart of ${record.spec.name} finished.`;
  });

  command('mongoCompass.deploy.upgrade', undefined, async (record, provider) => {
    if (!provider.upgradeNode && !provider.upgradeAll) {
      throw new Error(`${provider.label} deployments can not be upgraded from here.`);
    }
    let target: string;
    if (record.spec.provider === 'local') {
      const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Folder with the new mongod / mongos binaries' });
      target = required(folder?.[0]?.fsPath);
    } else if (record.spec.provider === 'kubernetes' && record.spec.kubernetes?.flavor !== 'community') {
      target = await ask('Upgrade', 'New MongoDB version or full image (e.g. 8.0 or percona/percona-server-mongodb:8.0.19-7)', record.spec.version);
    } else {
      target = await ask('Upgrade', record.spec.kubernetes?.flavor === 'community' ? 'Exact MongoDB version (e.g. 8.0.12)' : 'New MongoDB version (e.g. 8.0)', record.spec.version);
    }
    if (!(await confirmDanger(
      `Upgrade ${record.spec.name} to ${path.basename(target)}?`,
      'Upgrade one major version at a time. Nodes are replaced one by one (secondaries first, then the primary after a step-down). featureCompatibilityVersion stays as it is — raise it from the cluster overview once you are sure you will not roll back.',
      protection(record)
    ))) {
      return;
    }
    if (provider.upgradeAll) {
      await registry.withProgress(`Upgrading ${record.spec.name}`, (ctx) => (provider.upgradeAll as NonNullable<DeploymentProvider['upgradeAll']>)(record, ctx, target));
      return `Upgrade of ${record.spec.name} to ${target} started; the platform rolls it out node by node.`;
    }
    const connectionId = await connectionFor(record);
    await registry.withProgress(`Upgrading ${record.spec.name}`, (ctx) =>
      rollingOperation(record, provider, s.cluster, connectionId, ctx, (node) => (provider.upgradeNode as NonNullable<DeploymentProvider['upgradeNode']>)(record, ctx, node.id, target))
    );
    if (record.spec.provider === 'docker') {
      const updated = registry.get(record.id);
      if (updated) {
        updated.spec.version = target;
        updated.spec.docker = { ...(updated.spec.docker as NonNullable<DeploymentSpec['docker']>), image: `${(updated.spec.docker?.image ?? 'mongo').split(':')[0]}:${target}` };
        updated.nodes = updated.nodes?.map((n) => ({ ...n, version: undefined }));
        await registry.save(updated);
      }
    }
    const fcv = await vscode.window.showInformationMessage(`${record.spec.name} upgraded. Raise featureCompatibilityVersion when you are ready.`, 'Set FCV…');
    if (fcv) {
      await vscode.commands.executeCommand('mongoCompass.cluster.setFcv', connectionId);
    }
  });

  command('mongoCompass.deploy.failover', undefined, async (record, provider) => {
    if (!(await confirmDanger(`Fail over the primary of ${record.spec.name}?`, 'Clients see a short election.', protection(record) ?? (record.spec.atlas ? record.spec.name : undefined)))) {
      return;
    }
    if (provider.failover) {
      await registry.withProgress(`Failover of ${record.spec.name}`, (ctx) => (provider.failover as NonNullable<DeploymentProvider['failover']>)(record, ctx));
      return 'Failover requested.';
    }
    const connectionId = await connectionFor(record);
    await s.cluster.stepDown(connectionId, { stepDownSecs: 60, catchUpSecs: 10 }).catch((err: Error) => {
      if (!/connection|closed|interrupted/i.test(err.message)) {
        throw err;
      }
    });
    const primary = await s.cluster.waitForPrimary(connectionId, undefined, 60_000).catch(() => undefined);
    return primary ? `${primary} is the new primary.` : 'Stepped down; waiting for an election.';
  });

  // ───────────────────────────── misc ─────────────────────────────

  command('mongoCompass.deploy.export', 'exportDefinition', async (record, provider) => {
    const password = record.spec.auth ? await registry.password(record) : undefined;
    const exported = await (provider.exportDefinition as NonNullable<DeploymentProvider['exportDefinition']>)(record, password);
    const doc = await vscode.workspace.openTextDocument({ content: exported.content, language: exported.language });
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  command('mongoCompass.deploy.copyPassword', undefined, async (record) => {
    const password = await registry.password(record);
    if (!password) {
      throw new Error('No password is stored for this deployment.');
    }
    await vscode.env.clipboard.writeText(password);
    return `Password of ${record.spec.username} copied.`;
  });

  command('mongoCompass.deploy.copyConnectionString', undefined, async (record) => {
    const connectionId = await registry.ensureConnection(record);
    const uri = s.connectionManager.get(connectionId)?.options.connectionString ?? '';
    await vscode.env.clipboard.writeText(uri);
    return 'Connection string copied (contains the password).';
  });

  command('mongoCompass.deploy.backup', undefined, async (record) => {
    const mongodump = await findMongoTool('mongodump');
    if (!mongodump) {
      return;
    }
    const connectionId = await connectionFor(record);
    const uri = s.connectionManager.get(connectionId)?.options.connectionString ?? '';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = await vscode.window.showSaveDialog({
      title: `Back up ${record.spec.name}`,
      defaultUri: vscode.Uri.file(path.join(os.homedir(), `${slugify(record.spec.name)}-${stamp}.archive.gz`)),
      filters: { 'Compressed mongodump archive': ['gz'] }
    });
    if (!target) {
      return;
    }
    const oplog = record.spec.topology === 'replicaSet' ? ['--oplog'] : [];
    await runMongoTool(`backup: ${record.spec.name}`, mongodump, uri, [`--archive=${target.fsPath}`, '--gzip', ...oplog]);
  });

  command('mongoCompass.deploy.installOperator', undefined, async (record) => {
    if (!record.spec.kubernetes || record.spec.kubernetes.flavor === 'statefulset') {
      throw new Error('Only Kubernetes deployments with an operator need this.');
    }
    const kubectl = new Kubectl(record.spec.kubernetes.context, record.spec.kubernetes.namespace);
    await registry.withProgress('Installing operator', (ctx) => registry.kubernetes.installOperator(kubectl, record.spec.kubernetes?.flavor as KubernetesFlavor, ctx));
    return 'Operator installed.';
  });
}

// ───────────────────────────── wizard ─────────────────────────────

async function pickKubeTarget(title: string): Promise<{ kubectl: Kubectl }> {
  const contexts = await Kubectl.contexts();
  if (!contexts.length) {
    throw new Error('No kubectl contexts are configured.');
  }
  const ctxName = await pick(
    contexts.map((c) => ({
      label: c.name,
      description: [c.current ? 'current' : '', Kubectl.isProtected(c.name) ? '$(lock) protected' : ''].filter(Boolean).join(' · '),
      value: c
    })),
    `${title} — Kubernetes context`
  );
  const probe = new Kubectl(ctxName.name, ctxName.namespace ?? 'default');
  const namespaces = await probe.namespaces().catch(() => [] as string[]);
  const NEW = '$(add) New namespace…';
  const choice = await pick(
    [
      ...(namespaces.length ? [] : [{ label: ctxName.namespace ?? 'default', value: ctxName.namespace ?? 'default' }]),
      ...namespaces.map((n) => ({ label: n, value: n, description: n === ctxName.namespace ? 'context default' : '' })),
      { label: NEW, value: NEW }
    ],
    `${title} — namespace in ${ctxName.name}`
  );
  const namespace = choice === NEW ? await ask(title, 'Namespace name', 'mongodb', (v) => (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(v) ? null : 'A DNS label')) : choice;
  return { kubectl: new Kubectl(ctxName.name, namespace) };
}

async function createWizard(s: DeploymentCommandServices, providerArg?: ProviderId): Promise<{ spec: DeploymentSpec; password?: string } | undefined> {
  const { registry } = s;
  const title = 'New MongoDB deployment';

  const availability = await Promise.all(registry.providerList.map(async (p) => ({ p, error: await p.checkAvailable() })));
  const provider =
    providerArg ? registry.provider(providerArg) : await pick(
      availability.map(({ p, error }) => ({
        label: `${error ? '$(circle-slash) ' : ''}${p.label}`,
        description: {
          docker: 'containers on this machine, any topology',
          local: 'mongod processes on this machine',
          kubernetes: 'Percona / MongoDB operator or a StatefulSet',
          atlas: 'managed cloud clusters'
        }[p.id],
        detail: error,
        value: p
      })),
      title,
      'Where should MongoDB run?'
    );
  const unavailable = availability.find((a) => a.p === provider)?.error;
  if (unavailable) {
    if (provider.id === 'atlas') {
      await vscode.commands.executeCommand('mongoCompass.deploy.atlasSignIn');
      if (await provider.checkAvailable()) {
        return undefined;
      }
    } else {
      throw new Error(unavailable);
    }
  }

  const existingNames = new Set(registry.all.map((r) => r.spec.name.toLowerCase()));
  const name = await ask(title, 'Deployment name (used for containers / resources)', `mongo-${provider.id === 'atlas' ? 'cluster' : 'dev'}`, (v) => {
    if (!/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/.test(v)) {
      return 'Letters, digits and dashes; starts with a letter; up to 40 characters';
    }
    return existingNames.has(v.toLowerCase()) ? 'A deployment with this name exists' : null;
  });

  const spec: DeploymentSpec = {
    name,
    provider: provider.id,
    topology: 'replicaSet',
    version: '8.0',
    members: 3,
    arbiter: false,
    shards: 2,
    configServers: 1,
    routers: 1,
    auth: true,
    username: 'admin'
  };

  // Provider-specific placement first: it limits the topologies on offer.
  let flavor: KubernetesFlavor | undefined;
  if (provider.id === 'kubernetes') {
    const { kubectl } = await pickKubeTarget(title);
    flavor = await pick<KubernetesFlavor>(
      [
        { label: 'Percona Operator for MongoDB', description: 'replica sets and sharded clusters; installed if missing', value: 'percona' },
        { label: 'MongoDB Community (MongoDB Controllers for Kubernetes)', description: 'replica sets; installed with helm if missing', value: 'community' },
        { label: 'Plain StatefulSet', description: 'official mongo image, managed by this extension; no operator', value: 'statefulset' }
      ],
      title,
      'How to run MongoDB on Kubernetes'
    );
    const status = await registry.kubernetes.operatorStatus(kubectl, flavor);
    if (flavor !== 'statefulset' && (!status.crd || !status.operator)) {
      const ok = await confirmDanger(
        `Install the ${flavor === 'percona' ? 'Percona' : 'MongoDB'} operator in ${kubectl.context}/${kubectl.namespace}?`,
        `${status.crd ? 'The CRD exists but no operator runs in this namespace.' : 'Its CRDs (cluster-wide) and a namespaced operator deployment are installed.'}`,
        Kubectl.isProtected(kubectl.context) ? kubectl.context : undefined
      );
      if (!ok) {
        return undefined;
      }
    }
    spec.kubernetes = {
      context: kubectl.context,
      namespace: kubectl.namespace,
      flavor,
      resourceName: slugify(name),
      storageSize: '1Gi'
    };
  }

  let atlasTier: AtlasSpec['tier'] | undefined;
  if (provider.id === 'atlas') {
    const projects = await registry.atlas.projects();
    const project = await pick(projects.map((p) => ({ label: p.name, description: p.id, value: p })), title, 'Atlas project');
    atlasTier = await pick<AtlasSpec['tier']>(
      [
        { label: 'Free (M0)', description: 'one per project, shared, 512 MB', value: 'free' },
        { label: 'Flex', description: 'pay as you go, shared', value: 'flex' },
        { label: 'Dedicated (M10+)', description: 'replica set or sharded, scalable, pausable', value: 'dedicated' }
      ],
      title,
      'Cluster tier'
    );
    const cloudProvider = await pick<AtlasSpec['cloudProvider']>(
      [
        { label: 'AWS', value: 'AWS' },
        { label: 'Google Cloud', value: 'GCP' },
        { label: 'Azure', value: 'AZURE' }
      ],
      title,
      'Cloud provider'
    );
    const region = await ask(title, 'Region (Atlas region name)', cloudProvider === 'AWS' ? 'EU_CENTRAL_1' : cloudProvider === 'GCP' ? 'WESTERN_EUROPE' : 'EUROPE_WEST', (v) => (/^[A-Z0-9_]+$/.test(v) ? null : 'e.g. EU_CENTRAL_1, US_EAST_1'));
    spec.atlas = { projectId: project.id, projectName: project.name, clusterName: name, tier: atlasTier, cloudProvider, region };
    if (atlasTier === 'dedicated') {
      spec.atlas.instanceSize = await pick(['M10', 'M20', 'M30', 'M40', 'M50', 'M60'].map((x) => ({ label: x, value: x })), title, 'Instance size (sharding needs M30+)');
    }
  }

  // Topology
  let topologies = provider.topologies;
  if (flavor === 'community' || atlasTier === 'free' || atlasTier === 'flex') {
    topologies = ['replicaSet'];
  } else if (flavor === 'statefulset') {
    topologies = ['standalone', 'replicaSet'];
  } else if (flavor === 'percona') {
    topologies = ['replicaSet', 'sharded'];
  }
  if (topologies.length > 1) {
    spec.topology = await pick(
      topologies.map((t) => ({
        label: { standalone: 'Standalone', replicaSet: 'Replica set', sharded: 'Sharded cluster' }[t],
        description: {
          standalone: 'single mongod; no failover, no transactions',
          replicaSet: 'primary + secondaries with automatic failover',
          sharded: 'routers + config servers + several replica set shards'
        }[t],
        value: t
      })),
      title,
      'Topology'
    );
  } else {
    spec.topology = topologies[0];
  }

  // Version
  if (provider.id === 'docker') {
    const version = await pick([...DOCKER_VERSIONS.map((v) => ({ label: v, value: v })), { label: 'Other…', value: '' }], title, 'MongoDB version (mongo image tag)');
    spec.version = version || (await ask(title, 'Image tag of the official mongo image', '8.0'));
  } else if (provider.id === 'kubernetes') {
    if (flavor === 'community') {
      spec.version = await ask(title, 'Exact MongoDB version for MongoDBCommunity', '8.0.12', (v) => (/^\d+\.\d+\.\d+$/.test(v) ? null : 'major.minor.patch'));
    } else {
      spec.version = await pick(DOCKER_VERSIONS.map((v) => ({ label: v, value: v })), title, flavor === 'percona' ? 'Percona Server for MongoDB version' : 'mongo image tag');
    }
  } else if (provider.id === 'atlas') {
    spec.version = atlasTier === 'dedicated' ? await pick(['8.0', '7.0'].map((v) => ({ label: v, value: v })), title, 'MongoDB major version') : 'latest';
  } else {
    spec.version = 'local binaries';
  }

  // Sizes
  if (spec.topology !== 'standalone' && !(provider.id === 'atlas' && atlasTier !== 'dedicated')) {
    const memberOptions = provider.id === 'atlas' ? [3, 5, 7] : [1, 2, 3, 5];
    spec.members = await pick(
      memberOptions.map((n) => ({ label: String(n), description: n === 1 ? 'single-member replica set (dev only: no failover)' : n === 2 ? 'add an arbiter to get failover' : n === 3 ? 'recommended' : '', value: n })),
      title,
      `Data-bearing members per replica set`
    );
    if (provider.id !== 'atlas' && flavor !== 'statefulset' && spec.members % 2 === 0) {
      spec.arbiter = await pick([{ label: 'Add an arbiter', value: true }, { label: 'No arbiter', value: false }], title, 'An even number of members gains nothing without a tie-breaker');
    }
  }
  if (spec.topology === 'sharded') {
    spec.shards = Number(await ask(title, 'Number of shards', '2', isCount(1, 8)));
    if (provider.id !== 'atlas') {
      spec.configServers = await pick([1, 3].map((n) => ({ label: String(n), description: n === 3 ? 'production layout' : 'smallest', value: n })), title, 'Config server replica set members');
      spec.routers = await pick([1, 2, 3].map((n) => ({ label: String(n), value: n })), title, 'Routers (mongos)');
    }
  }

  // Authentication
  const mandatoryAuth = provider.id === 'atlas' || flavor === 'percona' || flavor === 'community';
  if (!mandatoryAuth) {
    spec.auth = await pick(
      [
        { label: 'Enable authentication', description: 'admin user + keyfile between members (recommended)', value: true },
        { label: 'No authentication', description: 'only for throwaway local experiments', value: false }
      ],
      title,
      'Security'
    );
  }
  let password: string | undefined;
  if (spec.auth) {
    spec.username = await ask(title, 'Admin user name', provider.id === 'atlas' ? 'compass-admin' : 'admin', (v) => (/^[A-Za-z0-9_.-]+$/.test(v) ? null : 'Letters, digits, _ . -'));
    const generated = generatePassword();
    const how = await pick(
      [
        { label: 'Generate a strong password', description: 'stored in the OS keychain; copy it any time from the deployment menu', value: 'generate' },
        { label: 'Enter a password', value: 'enter' }
      ],
      title,
      'Admin password'
    );
    password = how === 'generate' ? generated : await ask(title, 'Admin password (at least 8 characters)', '', (v) => (v.length >= 8 ? null : 'At least 8 characters'), true);
  }

  // Placement details
  if (provider.id === 'docker') {
    const reserved = registry.docker.reservedPorts();
    const range = Math.max(DOCKER_PORT_RANGE, portsNeeded(spec) + 6);
    const base = await findFreePortRange(27100, range, reserved);
    const memory = await vscode.window.showInputBox({ title, prompt: 'Memory limit per node (docker --memory), empty for none', placeHolder: '1g', ignoreFocusOut: true });
    if (memory === undefined) {
      throw new Cancelled();
    }
    spec.docker = { image: `mongo:${spec.version}`, basePort: base, portRange: range, memory: memory.trim() || undefined };
  } else if (provider.id === 'local') {
    spec.local = { basePort: 28000 };
  } else if (provider.id === 'kubernetes' && spec.kubernetes) {
    spec.kubernetes.storageSize = await ask(title, 'Volume size per member', '1Gi', (v) => (/^\d+(Mi|Gi|Ti)$/.test(v) ? null : 'e.g. 1Gi'));
    const storageClass = await vscode.window.showInputBox({ title, prompt: 'Storage class (empty for the cluster default)', ignoreFocusOut: true });
    if (storageClass === undefined) {
      throw new Cancelled();
    }
    spec.kubernetes.storageClass = storageClass.trim() || undefined;
  }

  if (provider.id === 'atlas' && spec.atlas) {
    const access = await vscode.window.showInputBox({
      title,
      prompt: 'IP access list entry to add (your IP/32 or a CIDR); empty to skip — you can not connect until your IP is allowed',
      placeHolder: '203.0.113.7/32',
      ignoreFocusOut: true,
      validateInput: (v) => (!v.trim() || /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(v.trim()) ? null : 'IPv4 address or CIDR')
    });
    if (access === undefined) {
      throw new Cancelled();
    }
    if (access.trim()) {
      const cidr = access.includes('/') ? access.trim() : `${access.trim()}/32`;
      await registry.atlas.addAccessListEntry(spec.atlas.projectId, cidr, `MongoDB Compass for VS Code (${os.hostname()})`);
    }
  }

  // Summary
  const where = spec.docker
    ? `Docker, ports ${spec.docker.basePort}–${spec.docker.basePort + spec.docker.portRange - 1} on 127.0.0.1`
    : spec.kubernetes
      ? `Kubernetes ${spec.kubernetes.context}/${spec.kubernetes.namespace} (${spec.kubernetes.flavor})`
      : spec.atlas
        ? `Atlas ${spec.atlas.projectName} · ${spec.atlas.tier}${spec.atlas.instanceSize ? ` ${spec.atlas.instanceSize}` : ''} · ${spec.atlas.cloudProvider} ${spec.atlas.region}`
        : 'local processes';
  const shape =
    spec.topology === 'standalone'
      ? 'standalone mongod'
      : spec.topology === 'replicaSet'
        ? `replica set of ${spec.members}${spec.arbiter ? ' + arbiter' : ''}`
        : `${spec.shards} shards × ${spec.members}${spec.arbiter ? ' + arbiter' : ''}, ${spec.configServers} config server(s), ${spec.routers} router(s)`;
  const ok = await confirmDanger(
    `Create "${spec.name}"?`,
    `${shape}\nMongoDB ${spec.version}\n${where}\n${spec.auth ? `auth: user ${spec.username}` : 'no authentication'}${spec.atlas && spec.atlas.tier === 'dedicated' ? '\n\nDedicated Atlas clusters are billed by the hour.' : ''}`,
    spec.kubernetes && Kubectl.isProtected(spec.kubernetes.context) ? spec.kubernetes.context : undefined
  );
  return ok ? { spec, password } : undefined;
}
