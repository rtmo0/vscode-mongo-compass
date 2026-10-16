import * as vscode from 'vscode';
import { generateKeyfile, mongoUri, openCommandTerminal, retry, run, sleep, which } from '../process';
import { toYamlDocuments } from '../yaml';
import type {
  DeploymentNode,
  DeploymentProvider,
  DeploymentRecord,
  DeploymentStatus,
  ExportedDefinition,
  KubernetesSpec,
  MemberKind,
  NodeStatus,
  ProviderContext,
  TopologyKind
} from '../types';
import { Kubectl, type KubeObject } from './kubectl';
import {
  PERCONA_CR_VERSION_DEFAULT,
  communityManifests,
  perconaBundleUrl,
  perconaManifests,
  perconaReplset,
  perconaShardNames,
  rootSecretName,
  statefulSetHost,
  statefulSetManifests
} from './manifests';
import type { PortForwardManager } from './portForward';

const PERCONA_CRD = 'perconaservermongodbs.psmdb.percona.com';
const COMMUNITY_CRD = 'mongodbcommunity.mongodbcommunity.mongodb.com';
const STOPPED_REPLICAS = 'mongo-compass/replicas';

interface PodInfo {
  name: string;
  container: string;
  role: DeploymentNode['role'];
  replicaSet?: string;
  host: string;
  status: NodeStatus;
  detail: string;
}

function k8s(record: DeploymentRecord): KubernetesSpec {
  if (!record.spec.kubernetes) {
    throw new Error('Kubernetes settings are missing.');
  }
  return record.spec.kubernetes;
}

function kubectlFor(record: DeploymentRecord): Kubectl {
  const spec = k8s(record);
  return new Kubectl(spec.context, spec.namespace);
}

function selectorFor(record: DeploymentRecord): string {
  const spec = k8s(record);
  switch (spec.flavor) {
    case 'percona':
      return `app.kubernetes.io/instance=${spec.resourceName}`;
    case 'community':
      return `app=${spec.resourceName}-svc`;
    default:
      return spec.selector ?? `app.kubernetes.io/instance=${spec.resourceName},app.kubernetes.io/name=mongodb`;
  }
}

function podStatus(pod: KubeObject): { status: NodeStatus; detail: string } {
  const status = (pod.status ?? {}) as {
    phase?: string;
    containerStatuses?: Array<{ ready?: boolean; restartCount?: number; state?: { waiting?: { reason?: string }; terminated?: { reason?: string } } }>;
    podIP?: string;
  };
  const containers = status.containerStatuses ?? [];
  const restarts = containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
  const waiting = containers.map((c) => c.state?.waiting?.reason).find(Boolean);
  const nodeName = (pod.spec?.nodeName as string | undefined) ?? '';
  const detail = [status.phase, waiting, restarts ? `${restarts} restarts` : '', nodeName, status.podIP].filter(Boolean).join(' · ');
  if (pod.metadata.deletionTimestamp) {
    return { status: 'terminating', detail };
  }
  if (waiting && /CrashLoop|Err|BackOff/i.test(waiting)) {
    return { status: 'error', detail };
  }
  if (status.phase === 'Running') {
    return { status: containers.length && containers.every((c) => c.ready) ? 'running' : 'starting', detail };
  }
  if (status.phase === 'Pending') {
    return { status: 'pending', detail };
  }
  if (status.phase === 'Failed') {
    return { status: 'error', detail };
  }
  return { status: 'unknown', detail };
}

/**
 * MongoDB on Kubernetes through `kubectl`, in three flavours:
 *
 * - **Percona Operator for MongoDB** (`PerconaServerMongoDB`): replica sets
 *   and sharded clusters, scaling, pause/resume, upgrades.
 * - **MongoDB Community** (`MongoDBCommunity`, served by MongoDB Controllers
 *   for Kubernetes): replica sets.
 * - **Plain StatefulSet** of the official `mongo` image, managed by the
 *   extension itself (it initiates the replica set and adds/removes members).
 *
 * With an operator, membership changes go through the custom resource —
 * the operator would revert a manual `replSetReconfig`.
 */
export class KubernetesProvider implements DeploymentProvider {
  readonly id = 'kubernetes' as const;
  readonly label = 'Kubernetes';
  readonly topologies: TopologyKind[] = ['standalone', 'replicaSet', 'sharded'];

  constructor(private readonly forwards: PortForwardManager) {}

  checkAvailable(): Promise<string | undefined> {
    return Kubectl.available();
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('mongoCompass.kubernetes');
  }

  // ───────────────────────────── operators ─────────────────────────────

  /** Is the operator for `flavor` installed (CRD present and an operator in the namespace)? */
  async operatorStatus(kubectl: Kubectl, flavor: KubernetesSpec['flavor']): Promise<{ crd: boolean; operator: boolean }> {
    if (flavor === 'statefulset') {
      return { crd: true, operator: true };
    }
    const crd = await kubectl.hasCrd(flavor === 'percona' ? PERCONA_CRD : COMMUNITY_CRD);
    const deployments = await kubectl.list('deployments').catch(() => [] as KubeObject[]);
    const operator = deployments.some((d) =>
      flavor === 'percona'
        ? /percona-server-mongodb-operator/.test(d.metadata.name)
        : /mongodb-kubernetes-operator|mongodb-community-operator|mongodb-kubernetes/.test(d.metadata.name)
    );
    return { crd, operator };
  }

  /** Install the operator for `flavor` into the deployment's namespace. */
  async installOperator(kubectl: Kubectl, flavor: KubernetesSpec['flavor'], ctx: ProviderContext): Promise<void> {
    if (flavor === 'percona') {
      const version = this.config().get<string>('perconaOperatorVersion', PERCONA_CR_VERSION_DEFAULT);
      ctx.progress(`Installing Percona Operator ${version}…`);
      await kubectl.run(['apply', '--server-side', '--force-conflicts', '-f', perconaBundleUrl(version)], { timeoutMs: 300_000, token: ctx.token });
      await kubectl.run(['rollout', 'status', 'deployment/percona-server-mongodb-operator', '--timeout=300s'], { timeoutMs: 320_000, token: ctx.token });
      return;
    }
    if (flavor === 'community') {
      if (!(await which('helm'))) {
        throw new Error('Installing MongoDB Controllers for Kubernetes needs helm on PATH.');
      }
      const chart = this.config().get<string>('communityOperatorChart', 'mongodb/mongodb-kubernetes');
      ctx.progress(`Installing ${chart}…`);
      await run('helm', ['repo', 'add', 'mongodb', 'https://mongodb.github.io/helm-charts', '--force-update'], { timeoutMs: 120_000 });
      await run('helm', ['repo', 'update', 'mongodb'], { timeoutMs: 120_000 });
      await run(
        'helm',
        ['upgrade', '--install', 'mongodb-kubernetes', chart, '--kube-context', kubectl.context, '--namespace', kubectl.namespace, '--create-namespace', '--wait', '--timeout', '5m'],
        { timeoutMs: 360_000, token: ctx.token }
      );
    }
  }

  // ───────────────────────────── create ─────────────────────────────

  async create(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    const password = record.spec.auth ? await ctx.password(record) : undefined;

    ctx.progress(`Preparing namespace ${spec.namespace}…`);
    const namespaces = await kubectl.namespaces();
    if (!namespaces.includes(spec.namespace)) {
      await run('kubectl', ['--context', spec.context, 'create', 'namespace', spec.namespace], { timeoutMs: 60_000 });
    }

    if (spec.flavor !== 'statefulset') {
      const status = await this.operatorStatus(kubectl, spec.flavor);
      if (!status.crd || !status.operator) {
        await this.installOperator(kubectl, spec.flavor, ctx);
      }
    }

    switch (spec.flavor) {
      case 'percona': {
        if (!password) {
          throw new Error('The Percona Operator always enables authentication; a password is required.');
        }
        const version = this.config().get<string>('perconaOperatorVersion', PERCONA_CR_VERSION_DEFAULT);
        ctx.progress('Creating the PerconaServerMongoDB resource…');
        await kubectl.apply(perconaManifests(record, password, version), { token: ctx.token });
        await this.waitForCr(record, ctx, 'psmdb', (cr) => String(cr.status?.state ?? '') === 'ready', (cr) => String(cr.status?.state ?? 'pending'));
        break;
      }
      case 'community': {
        if (record.spec.topology !== 'replicaSet') {
          throw new Error('The MongoDB Community operator only deploys replica sets.');
        }
        if (!password) {
          throw new Error('MongoDBCommunity always enables SCRAM authentication; a password is required.');
        }
        ctx.progress('Creating the MongoDBCommunity resource…');
        await kubectl.apply(communityManifests(record, password), { token: ctx.token });
        await this.waitForCr(record, ctx, 'mongodbcommunity', (cr) => String(cr.status?.phase ?? '') === 'Running', (cr) => String(cr.status?.phase ?? 'pending'));
        break;
      }
      case 'statefulset': {
        if (record.spec.topology === 'sharded') {
          throw new Error('Plain StatefulSets support standalone servers and replica sets; use the Percona Operator for sharding.');
        }
        ctx.progress('Creating the StatefulSet…');
        await kubectl.apply(statefulSetManifests(record, password, record.spec.auth ? generateKeyfile() : undefined), { token: ctx.token });
        ctx.progress('Waiting for the pods…');
        await kubectl.run(['rollout', 'status', `statefulset/${spec.resourceName}`, '--timeout=900s'], { timeoutMs: 920_000, token: ctx.token });
        await this.bootstrapStatefulSet(record, password, ctx);
        break;
      }
    }
  }

  private async waitForCr(
    record: DeploymentRecord,
    ctx: ProviderContext,
    kind: string,
    done: (cr: KubeObject) => boolean,
    describe: (cr: KubeObject) => string
  ): Promise<void> {
    const kubectl = kubectlFor(record);
    const deadline = Date.now() + 20 * 60_000;
    while (Date.now() < deadline) {
      if (ctx.token.isCancellationRequested) {
        throw new Error('Cancelled — the operator keeps working in the cluster.');
      }
      const cr = await kubectl.get(kind, k8s(record).resourceName);
      if (cr && done(cr)) {
        return;
      }
      const pods = await kubectl.list('pods', selectorFor(record)).catch(() => [] as KubeObject[]);
      const ready = pods.filter((p) => podStatus(p).status === 'running').length;
      ctx.progress(`${cr ? describe(cr) : 'pending'} — ${ready}/${pods.length} pods ready${cr?.status?.message ? `: ${String(cr.status.message)}` : ''}`);
      await sleep(5000);
    }
    throw new Error('Timed out waiting for the operator. Check the resource events (Describe node).');
  }

  private async bootstrapStatefulSet(record: DeploymentRecord, password: string | undefined, ctx: ProviderContext): Promise<void> {
    const kubectl = kubectlFor(record);
    const name = k8s(record).resourceName;
    const pod0 = `${name}-0`;
    if (record.spec.topology === 'replicaSet') {
      const members = Array.from({ length: record.spec.members }, (_, i) => ({ _id: i, host: statefulSetHost(record, i), priority: i === 0 ? 2 : 1 }));
      ctx.progress('Initiating replica set rs0…');
      await kubectl.mongosh(pod0, 'mongod', `const conn = connect(${JSON.stringify(mongoUri('localhost:27017'))});
let initiated = false;
try { conn.adminCommand({ replSetGetStatus: 1 }); initiated = true; } catch (e) { if (!/no replset config|NotYetInitialized/i.test(String(e.message || e.codeName))) { throw e; } }
result = initiated ? { already: true } : conn.adminCommand({ replSetInitiate: ${JSON.stringify({ _id: 'rs0', members })} });`);
      ctx.progress('Waiting for a primary…');
      await retry(async () => {
        const hello = await kubectl.mongosh<{ isWritablePrimary?: boolean }>(pod0, 'mongod', `result = connect(${JSON.stringify(mongoUri('localhost:27017'))}).hello();`);
        if (!hello.isWritablePrimary) {
          throw new Error('no primary yet');
        }
      }, 180_000, 3000, ctx.token);
    }
    if (record.spec.auth && password) {
      ctx.progress('Creating the admin user…');
      await kubectl.mongosh(pod0, 'mongod', `const conn = connect(${JSON.stringify(mongoUri('localhost:27017'))});
result = conn.getSiblingDB('admin').runCommand({ createUser: ${JSON.stringify(record.spec.username)}, pwd: ${JSON.stringify(password)}, roles: [{ role: 'root', db: 'admin' }] });`);
    }
  }

  // ───────────────────────────── status ─────────────────────────────

  private async pods(record: DeploymentRecord): Promise<PodInfo[]> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    const pods = await kubectl.list('pods', selectorFor(record));
    return pods
      .map((pod) => {
        const labels = pod.metadata.labels ?? {};
        const component = labels['app.kubernetes.io/component'];
        const name = pod.metadata.name;
        let role: DeploymentNode['role'] = 'mongod';
        let replicaSet: string | undefined;
        let host = '';
        let container = 'mongod';
        if (spec.flavor === 'percona') {
          replicaSet = labels['app.kubernetes.io/replset'];
          if (component === 'mongos') {
            role = 'mongos';
            container = 'mongos';
            host = `${name}.${spec.resourceName}-mongos.${spec.namespace}.svc.cluster.local:27017`;
          } else {
            role = component === 'cfg' ? 'configsvr' : component === 'arbiter' ? 'arbiter' : 'mongod';
            host = `${name}.${spec.resourceName}-${replicaSet}.${spec.namespace}.svc.cluster.local:27017`;
          }
        } else if (spec.flavor === 'community') {
          replicaSet = spec.resourceName;
          role = name.includes('-arb-') ? 'arbiter' : 'mongod';
          host = `${name}.${spec.resourceName}-svc.${spec.namespace}.svc.cluster.local:27017`;
        } else {
          replicaSet = record.spec.topology === 'replicaSet' ? spec.replicaSetName ?? 'rs0' : undefined;
          host = `${name}.${spec.serviceName ?? spec.resourceName}.${spec.namespace}.svc.cluster.local:27017`;
        }
        const { status, detail } = podStatus(pod);
        return { name, container, role, replicaSet, host, status, detail };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  async status(record: DeploymentRecord): Promise<DeploymentStatus> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    const pods = await this.pods(record);
    const nodes: DeploymentNode[] = pods.map((p) => ({
      id: p.name,
      name: p.name,
      role: p.role,
      replicaSet: p.replicaSet,
      address: p.host,
      status: p.status,
      detail: p.detail
    }));
    let state: DeploymentStatus['state'] = 'unknown';
    let message: string | undefined;
    if (spec.flavor === 'percona') {
      const cr = await kubectl.get('psmdb', spec.resourceName);
      const crState = String(cr?.status?.state ?? '');
      message = cr?.status?.message ? String(cr.status.message) : `CR state: ${crState || 'unknown'}`;
      state = !cr ? 'error' : cr.spec?.pause ? (nodes.length ? 'updating' : 'paused') : crState === 'ready' ? 'running' : crState === 'error' ? 'error' : crState === 'stopping' ? 'updating' : 'creating';
    } else if (spec.flavor === 'community') {
      const cr = await kubectl.get('mongodbcommunity', spec.resourceName);
      const phase = String(cr?.status?.phase ?? '');
      message = cr?.status?.message ? String(cr.status.message) : `phase: ${phase || 'unknown'}`;
      state = !cr ? 'error' : phase === 'Running' ? 'running' : phase === 'Failed' ? 'error' : 'updating';
    } else {
      const sts = await kubectl.get('statefulset', spec.resourceName);
      const desired = Number(sts?.spec?.replicas ?? 0);
      const ready = Number(sts?.status?.readyReplicas ?? 0);
      message = sts ? `${ready}/${desired} ready` : 'StatefulSet missing';
      state = !sts ? 'error' : desired === 0 ? 'stopped' : ready === desired ? 'running' : 'updating';
    }
    if (record.provisioning?.state === 'creating') {
      state = 'creating';
    }
    if (state === 'running' && nodes.some((n) => n.status !== 'running')) {
      state = 'degraded';
    }
    return { state, nodes, message: `${spec.context}/${spec.namespace} · ${message ?? ''}` };
  }

  // ───────────────────────────── connections ─────────────────────────────

  /** Pod (or service) the saved connection goes through. */
  private async connectionTarget(record: DeploymentRecord): Promise<string> {
    const spec = k8s(record);
    if (record.spec.topology === 'sharded') {
      return `svc/${spec.resourceName}-mongos`;
    }
    const pods = (await this.pods(record)).filter((p) => p.role !== 'arbiter' && p.role !== 'mongos');
    const running = pods.filter((p) => p.status === 'running');
    if (record.spec.topology === 'replicaSet' && running.length) {
      // Talk to the primary, so writes work through a single forwarded port.
      try {
        const hello = await kubectlFor(record).mongosh<{ primary?: string }>(running[0].name, running[0].container, `result = connect(${JSON.stringify(mongoUri('localhost:27017'))}).hello();`, { timeoutMs: 30_000 });
        const primary = pods.find((p) => hello.primary && p.host.toLowerCase() === hello.primary.toLowerCase());
        if (primary) {
          return `pod/${primary.name}`;
        }
      } catch {
        // fall back to the first pod
      }
    }
    const first = running[0] ?? pods[0];
    if (!first) {
      throw new Error('No MongoDB pod is running.');
    }
    return `pod/${first.name}`;
  }

  async prepareConnection(record: DeploymentRecord): Promise<void> {
    const spec = k8s(record);
    const target = await this.connectionTarget(record);
    this.lastPort.set(record.id, await this.forwards.forward(spec.context, spec.namespace, target, 27017, { keepAlive: true, localPort: this.lastPort.get(record.id) }));
  }

  private readonly lastPort = new Map<string, number>();

  async connectionString(record: DeploymentRecord, password: string | undefined): Promise<string> {
    await this.prepareConnection(record);
    const port = this.lastPort.get(record.id) as number;
    const auth = record.spec.auth && password ? `${encodeURIComponent(record.spec.username)}:${encodeURIComponent(password)}@` : '';
    const options = [record.spec.topology === 'sharded' ? '' : 'directConnection=true', auth ? 'authSource=admin' : ''].filter(Boolean).join('&');
    return `mongodb://${auth}127.0.0.1:${port}/${options ? `?${options}` : ''}`;
  }

  /** Map a pod DNS name of this deployment to a port-forward. */
  async resolveHost(record: DeploymentRecord, host: string): Promise<string | undefined> {
    const spec = k8s(record);
    const [hostname, port] = host.split(':');
    if (!hostname.endsWith(`.${spec.namespace}.svc.cluster.local`) && !hostname.endsWith(`.${spec.namespace}.svc`)) {
      return undefined;
    }
    const pod = hostname.split('.')[0];
    const local = await this.forwards.forward(spec.context, spec.namespace, `pod/${pod}`, Number(port || 27017));
    return `127.0.0.1:${local}`;
  }

  private readonly systemCredentials = new Map<string, { username: string; password: string }>();

  /**
   * Shards of a Percona sharded cluster only know the operator's system
   * users (cluster-wide users live on the config servers), so direct shard
   * access uses its cluster admin from the `<name>-secrets` secret.
   */
  async credentialsFor(record: DeploymentRecord, host: string): Promise<{ username: string; password: string } | undefined> {
    const spec = k8s(record);
    if (spec.flavor !== 'percona' || record.spec.topology !== 'sharded') {
      return undefined;
    }
    const pod = host.split('.')[0];
    if (!pod.startsWith(`${spec.resourceName}-`) || pod.startsWith(`${spec.resourceName}-cfg-`) || pod.startsWith(`${spec.resourceName}-mongos-`)) {
      return undefined;
    }
    const cached = this.systemCredentials.get(record.id);
    if (cached) {
      return cached;
    }
    const kubectl = kubectlFor(record);
    const cr = await kubectl.get('psmdb', spec.resourceName);
    const secretName = String((cr?.spec?.secrets as { users?: string } | undefined)?.users ?? `${spec.resourceName}-secrets`);
    const username = await kubectl.secretValue(secretName, 'MONGODB_CLUSTER_ADMIN_USER');
    const password = await kubectl.secretValue(secretName, 'MONGODB_CLUSTER_ADMIN_PASSWORD');
    if (!username || !password) {
      return undefined;
    }
    this.systemCredentials.set(record.id, { username, password });
    return { username, password };
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async destroy(record: DeploymentRecord, ctx: ProviderContext, options: { keepData: boolean }): Promise<void> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    this.forwards.stopNamespace(spec.context, spec.namespace);
    ctx.progress(`Deleting ${spec.resourceName}…`);
    switch (spec.flavor) {
      case 'percona':
        await kubectl.delete('psmdb', spec.resourceName, { wait: true, timeoutMs: 600_000 });
        break;
      case 'community':
        await kubectl.delete('mongodbcommunity', spec.resourceName, { wait: true, timeoutMs: 600_000 });
        break;
      case 'statefulset':
        await kubectl.delete('statefulset', spec.resourceName, { wait: true, timeoutMs: 300_000 });
        await kubectl.delete('service', spec.resourceName);
        await kubectl.delete('secret', `${spec.resourceName}-auth`);
        break;
    }
    await kubectl.delete('secret', rootSecretName(record));
    if (!options.keepData) {
      ctx.progress('Deleting persistent volume claims…');
      await kubectl.delete('pvc', selectorFor(record), { selector: true, timeoutMs: 300_000 });
      if (spec.flavor === 'percona') {
        await kubectl.delete('secret', `${spec.resourceName}-secrets`);
      }
    }
  }

  async start(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    if (nodeId) {
      throw new Error('Pods are started by their controller; use Restart instead.');
    }
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    if (spec.flavor === 'percona') {
      await kubectl.patch('psmdb', spec.resourceName, 'merge', { spec: { pause: false } }, { token: ctx.token });
    } else if (spec.flavor === 'statefulset') {
      const sts = await kubectl.get('statefulset', spec.resourceName);
      const replicas = Number(sts?.metadata.annotations?.[STOPPED_REPLICAS] ?? record.spec.members);
      await kubectl.run(['scale', `statefulset/${spec.resourceName}`, `--replicas=${replicas}`], { token: ctx.token });
    } else {
      throw new Error('MongoDBCommunity resources can not be paused; delete the deployment instead.');
    }
  }

  async stop(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    if (nodeId) {
      throw new Error('A single pod can not stay stopped; its controller recreates it. Use Remove member to scale down.');
    }
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    this.forwards.stopNamespace(spec.context, spec.namespace);
    if (spec.flavor === 'percona') {
      await kubectl.patch('psmdb', spec.resourceName, 'merge', { spec: { pause: true } }, { token: ctx.token });
    } else if (spec.flavor === 'statefulset') {
      const sts = await kubectl.get('statefulset', spec.resourceName);
      await kubectl.run(['annotate', '--overwrite', `statefulset/${spec.resourceName}`, `${STOPPED_REPLICAS}=${Number(sts?.spec?.replicas ?? record.spec.members)}`], { token: ctx.token });
      await kubectl.run(['scale', `statefulset/${spec.resourceName}`, '--replicas=0'], { token: ctx.token });
    } else {
      throw new Error('MongoDBCommunity resources can not be paused; delete the deployment instead.');
    }
  }

  async restartNode(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    await kubectlFor(record).run(['delete', 'pod', nodeId, '--wait=true'], { token: ctx.token, timeoutMs: 300_000 });
    ctx.progress(`Waiting for ${nodeId} to come back…`);
    await retry(async () => {
      const pod = (await this.pods(record)).find((p) => p.name === nodeId);
      if (pod?.status !== 'running') {
        throw new Error(`${nodeId} is ${pod?.status ?? 'missing'}`);
      }
    }, 600_000, 3000, ctx.token);
  }

  async chaos(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, action: 'kill' | 'pause' | 'unpause'): Promise<void> {
    if (action !== 'kill') {
      throw new Error('Pods can not be frozen; use Kill to simulate a crash.');
    }
    await kubectlFor(record).run(['delete', 'pod', nodeId, '--grace-period=0', '--force'], { token: ctx.token });
  }

  async scaleReplicaSet(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, members: number): Promise<void> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    if (members < 1) {
      throw new Error('A replica set needs at least one member.');
    }
    switch (spec.flavor) {
      case 'percona': {
        const cr = await kubectl.get('psmdb', spec.resourceName);
        const sets = ((cr?.spec?.replsets ?? []) as Array<{ name: string }>).map((r) => r.name);
        const patch: unknown[] = [];
        if (replicaSet === 'cfg') {
          patch.push({ op: 'replace', path: '/spec/sharding/configsvrReplSet/size', value: members });
        } else {
          const index = sets.indexOf(replicaSet);
          if (index < 0) {
            throw new Error(`Unknown replica set ${replicaSet}.`);
          }
          patch.push({ op: 'replace', path: `/spec/replsets/${index}/size`, value: members });
        }
        if (members < 3) {
          patch.push({ op: 'add', path: '/spec/unsafeFlags/replsetSize', value: true });
        }
        await kubectl.patch('psmdb', spec.resourceName, 'json', patch, { token: ctx.token });
        break;
      }
      case 'community':
        await kubectl.patch('mongodbcommunity', spec.resourceName, 'merge', { spec: { members } }, { token: ctx.token });
        break;
      case 'statefulset':
        await this.scaleStatefulSet(record, ctx, members);
        return;
    }
    ctx.progress('The operator is reconciling the new size…');
  }

  /** Scale the extension-managed StatefulSet one member at a time, keeping the replica set config in step. */
  private async scaleStatefulSet(record: DeploymentRecord, ctx: ProviderContext, target: number): Promise<void> {
    if (record.spec.topology !== 'replicaSet') {
      throw new Error('Only replica sets can be scaled.');
    }
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    const password = record.spec.auth ? await ctx.password(record) : undefined;
    const sts = await kubectl.get('statefulset', spec.resourceName);
    let current = Number(sts?.spec?.replicas ?? 0);
    const onPrimary = async (script: string): Promise<unknown> => {
      const pods = (await this.pods(record)).filter((p) => p.status === 'running');
      for (const pod of pods) {
        const uri = mongoUri('localhost:27017', record.spec.auth ? record.spec.username : undefined, password);
        const hello = await kubectl.mongosh<{ isWritablePrimary?: boolean }>(pod.name, 'mongod', `result = connect(${JSON.stringify(uri)}).hello();`).catch(() => undefined);
        if (hello?.isWritablePrimary) {
          // The rs.* helpers work on the global `db`.
          return kubectl.mongosh(pod.name, 'mongod', `db = connect(${JSON.stringify(uri)});\nconst conn = db;\n${script}`);
        }
      }
      throw new Error('No primary found.');
    };
    while (current < target) {
      ctx.progress(`Adding member ${current}…`);
      await kubectl.run(['scale', `statefulset/${spec.resourceName}`, `--replicas=${current + 1}`], { token: ctx.token });
      await kubectl.run(['rollout', 'status', `statefulset/${spec.resourceName}`, '--timeout=600s'], { timeoutMs: 620_000, token: ctx.token });
      await onPrimary(`result = rs.add(${JSON.stringify(statefulSetHost(record, current))});`);
      current += 1;
    }
    while (current > target) {
      const host = statefulSetHost(record, current - 1);
      ctx.progress(`Removing member ${current - 1}…`);
      await onPrimary(`const me = conn.hello();
if (me.me === ${JSON.stringify(host)}) { try { conn.adminCommand({ replSetStepDown: 60 }); } catch (e) {} }
result = { stepped: me.me === ${JSON.stringify(host)} };`);
      await sleep(3000);
      await onPrimary(`result = rs.remove(${JSON.stringify(host)});`);
      await kubectl.run(['scale', `statefulset/${spec.resourceName}`, `--replicas=${current - 1}`], { token: ctx.token });
      await kubectl.delete('pvc', `data-${spec.resourceName}-${current - 1}`, { token: ctx.token });
      current -= 1;
    }
    record.spec.members = target;
    await ctx.save(record);
  }

  async addMember(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, kind: MemberKind): Promise<string> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    if (kind === 'arbiter') {
      if (spec.flavor === 'percona') {
        const cr = await kubectl.get('psmdb', spec.resourceName);
        const index = ((cr?.spec?.replsets ?? []) as Array<{ name: string }>).findIndex((r) => r.name === replicaSet);
        if (index < 0) {
          throw new Error(`Unknown replica set ${replicaSet}.`);
        }
        await kubectl.patch('psmdb', spec.resourceName, 'json', [{ op: 'add', path: `/spec/replsets/${index}/arbiter`, value: { enabled: true, size: 1 } }], { token: ctx.token });
        return `${replicaSet} arbiter`;
      }
      if (spec.flavor === 'community') {
        const cr = await kubectl.get('mongodbcommunity', spec.resourceName);
        await kubectl.patch('mongodbcommunity', spec.resourceName, 'merge', { spec: { arbiters: Number(cr?.spec?.arbiters ?? 0) + 1 } }, { token: ctx.token });
        return 'arbiter';
      }
      throw new Error('Arbiters are only supported with an operator on Kubernetes.');
    }
    if (kind === 'hidden') {
      throw new Error('Add a regular member, then make it hidden from the cluster view (Member settings).');
    }
    const current = await this.replicaSetSize(record, replicaSet);
    await this.scaleReplicaSet(record, ctx, replicaSet, current + 1);
    return `${replicaSet} member ${current}`;
  }

  /** Scale down by one: Kubernetes always removes the highest ordinal. */
  async removeMember(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    const pod = (await this.pods(record)).find((p) => p.name === nodeId);
    if (!pod?.replicaSet) {
      throw new Error(`${nodeId} is not a replica set member.`);
    }
    const siblings = (await this.pods(record)).filter((p) => p.replicaSet === pod.replicaSet && p.role === pod.role);
    const highest = siblings[siblings.length - 1];
    if (highest && highest.name !== nodeId) {
      const answer = await vscode.window.showWarningMessage(
        `Kubernetes scales down by removing the highest ordinal, so ${highest.name} will be removed instead of ${nodeId}.`,
        { modal: true },
        `Remove ${highest.name}`
      );
      if (!answer) {
        throw new Error('Cancelled');
      }
    }
    if (pod.role === 'arbiter') {
      const spec = k8s(record);
      const kubectl = kubectlFor(record);
      if (spec.flavor === 'percona') {
        const cr = await kubectl.get('psmdb', spec.resourceName);
        const index = ((cr?.spec?.replsets ?? []) as Array<{ name: string }>).findIndex((r) => r.name === pod.replicaSet);
        await kubectl.patch('psmdb', spec.resourceName, 'json', [{ op: 'replace', path: `/spec/replsets/${index}/arbiter/enabled`, value: false }], { token: ctx.token });
      } else {
        await kubectl.patch('mongodbcommunity', spec.resourceName, 'merge', { spec: { arbiters: Math.max(0, siblings.length - 1) } }, { token: ctx.token });
      }
      return;
    }
    await this.scaleReplicaSet(record, ctx, pod.replicaSet, siblings.length - 1);
  }

  private async replicaSetSize(record: DeploymentRecord, replicaSet: string): Promise<number> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    if (spec.flavor === 'percona') {
      const cr = await kubectl.get('psmdb', spec.resourceName);
      if (replicaSet === 'cfg') {
        return Number(((cr?.spec?.sharding as { configsvrReplSet?: { size?: number } } | undefined)?.configsvrReplSet?.size) ?? 3);
      }
      return Number(((cr?.spec?.replsets ?? []) as Array<{ name: string; size: number }>).find((r) => r.name === replicaSet)?.size ?? 0);
    }
    if (spec.flavor === 'community') {
      const cr = await kubectl.get('mongodbcommunity', spec.resourceName);
      return Number(cr?.spec?.members ?? 0);
    }
    const sts = await kubectl.get('statefulset', spec.resourceName);
    return Number(sts?.spec?.replicas ?? 0);
  }

  async addShard(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    const spec = k8s(record);
    this.requirePerconaSharded(record);
    const kubectl = kubectlFor(record);
    const cr = await kubectl.get('psmdb', spec.resourceName);
    const names = ((cr?.spec?.replsets ?? []) as Array<{ name: string }>).map((r) => r.name);
    let index = 0;
    while (names.includes(`rs${index}`)) {
      index += 1;
    }
    const name = `rs${index}`;
    await kubectl.patch('psmdb', spec.resourceName, 'json', [{ op: 'add', path: '/spec/replsets/-', value: perconaReplset(record, name) }], { token: ctx.token });
    ctx.progress(`The operator creates ${name} and adds it as a shard…`);
    return name;
  }

  /** Drain the shard through a mongos, then drop its replset from the CR. */
  async removeShard(record: DeploymentRecord, ctx: ProviderContext, shard: string): Promise<void> {
    const spec = k8s(record);
    this.requirePerconaSharded(record);
    const kubectl = kubectlFor(record);
    const password = await ctx.password(record);
    const mongos = (await this.pods(record)).find((p) => p.role === 'mongos' && p.status === 'running');
    if (!mongos) {
      throw new Error('No running mongos pod.');
    }
    const uri = mongoUri('localhost:27017', record.spec.username, password, '');
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const result = await kubectl.mongosh<{ state?: string; dbsToMove?: string[]; remaining?: unknown }>(
        mongos.name,
        'mongos',
        `result = connect(${JSON.stringify(uri)}).adminCommand({ removeShard: ${JSON.stringify(shard)} });`
      );
      ctx.progress(`Draining ${shard}: ${result.state ?? ''} ${result.remaining ? JSON.stringify(result.remaining) : ''}`);
      if (result.state === 'completed') {
        break;
      }
      for (const db of result.dbsToMove ?? []) {
        const other = perconaShardNames(record).find((s) => s !== shard) ?? 'rs0';
        await kubectl.mongosh(mongos.name, 'mongos', `result = connect(${JSON.stringify(uri)}).adminCommand({ movePrimary: ${JSON.stringify(db)}, to: ${JSON.stringify(other)} });`, { timeoutMs: 600_000 });
      }
      if (Date.now() > deadline || ctx.token.isCancellationRequested) {
        throw new Error(`${shard} is still draining; run Remove Shard again to finish.`);
      }
      await sleep(10_000);
    }
    const cr = await kubectl.get('psmdb', spec.resourceName);
    const index = ((cr?.spec?.replsets ?? []) as Array<{ name: string }>).findIndex((r) => r.name === shard);
    if (index >= 0) {
      await kubectl.patch('psmdb', spec.resourceName, 'json', [{ op: 'remove', path: `/spec/replsets/${index}` }], { token: ctx.token });
    }
  }

  async addRouter(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    return this.scaleRouters(record, ctx, 1);
  }

  async removeRouter(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    await this.scaleRouters(record, ctx, -1);
  }

  private async scaleRouters(record: DeploymentRecord, ctx: ProviderContext, delta: number): Promise<string> {
    const spec = k8s(record);
    this.requirePerconaSharded(record);
    const kubectl = kubectlFor(record);
    const cr = await kubectl.get('psmdb', spec.resourceName);
    const size = Number(((cr?.spec?.sharding as { mongos?: { size?: number } } | undefined)?.mongos?.size) ?? 1) + delta;
    if (size < 1) {
      throw new Error('The cluster needs at least one mongos.');
    }
    const patch: unknown[] = [{ op: 'replace', path: '/spec/sharding/mongos/size', value: size }];
    if (size < 2) {
      patch.push({ op: 'add', path: '/spec/unsafeFlags/mongosSize', value: true });
    }
    await kubectl.patch('psmdb', spec.resourceName, 'json', patch, { token: ctx.token });
    return `${size} mongos`;
  }

  private requirePerconaSharded(record: DeploymentRecord): void {
    if (k8s(record).flavor !== 'percona' || record.spec.topology !== 'sharded') {
      throw new Error('Shards and routers can be changed on Percona sharded clusters only.');
    }
  }

  /** Change the version in the resource; the controller rolls it out pod by pod. */
  async upgradeAll(record: DeploymentRecord, ctx: ProviderContext, version: string): Promise<void> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    switch (spec.flavor) {
      case 'percona': {
        const image = version.includes('/') ? version : `percona/percona-server-mongodb:${version}`;
        await kubectl.patch('psmdb', spec.resourceName, 'merge', { spec: { image } }, { token: ctx.token });
        spec.image = image;
        break;
      }
      case 'community':
        await kubectl.patch('mongodbcommunity', spec.resourceName, 'merge', { spec: { version } }, { token: ctx.token });
        break;
      case 'statefulset': {
        const image = version.includes('/') || version.includes(':') ? version : `mongo:${version}`;
        await kubectl.run(['set', 'image', `statefulset/${spec.resourceName}`, `mongod=${image}`], { token: ctx.token });
        spec.image = image;
        break;
      }
    }
    record.spec.version = version;
    await ctx.save(record);
  }

  async openLogs(record: DeploymentRecord, nodeId: string): Promise<void> {
    const pod = (await this.pods(record)).find((p) => p.name === nodeId);
    const k = kubectlFor(record);
    openCommandTerminal(`logs: ${nodeId}`, 'kubectl', [...k.base(), 'logs', '-f', '--tail', '300', nodeId, '-c', pod?.container ?? 'mongod']);
  }

  async openShell(record: DeploymentRecord, nodeId: string): Promise<void> {
    const pod = (await this.pods(record)).find((p) => p.name === nodeId);
    const k = kubectlFor(record);
    const args = [...k.base(), 'exec', '-it', nodeId, '-c', pod?.container ?? 'mongod', '--', 'mongosh'];
    if (record.spec.auth && pod?.role !== 'arbiter') {
      args.push('-u', record.spec.username, '--authenticationDatabase', 'admin');
    }
    openCommandTerminal(`mongosh: ${nodeId}`, 'kubectl', args);
  }

  async describeNode(record: DeploymentRecord, nodeId: string): Promise<string> {
    const { stdout } = await kubectlFor(record).run(['describe', 'pod', nodeId]);
    return stdout;
  }

  async exportDefinition(record: DeploymentRecord): Promise<ExportedDefinition> {
    const spec = k8s(record);
    const kubectl = kubectlFor(record);
    const kinds = spec.flavor === 'percona' ? ['psmdb'] : spec.flavor === 'community' ? ['mongodbcommunity'] : ['statefulset', 'service'];
    const objects: unknown[] = [];
    for (const kind of kinds) {
      const object = await kubectl.get(kind, spec.resourceName);
      if (object) {
        delete object.status;
        const meta = object.metadata as Record<string, unknown>;
        for (const field of ['uid', 'resourceVersion', 'generation', 'creationTimestamp', 'managedFields', 'finalizers']) {
          delete meta[field];
        }
        if (meta.annotations) {
          delete (meta.annotations as Record<string, unknown>)['kubectl.kubernetes.io/last-applied-configuration'];
        }
        objects.push(object);
      }
    }
    const header = `# ${spec.flavor} deployment "${record.spec.name}" (${spec.context}/${spec.namespace}), exported by MongoDB Compass for VS Code.\n# Secrets are not included.\n`;
    return { language: 'yaml', content: header + toYamlDocuments(objects) };
  }

  /**
   * MongoDB deployments that already exist in a namespace and can be attached:
   * Percona and Community resources, and StatefulSets running a mongo image.
   */
  async discover(kubectl: Kubectl): Promise<Array<{ flavor: KubernetesSpec['flavor']; name: string; detail: string; object: KubeObject }>> {
    const found: Array<{ flavor: KubernetesSpec['flavor']; name: string; detail: string; object: KubeObject }> = [];
    for (const cr of await kubectl.list('psmdb').catch(() => [] as KubeObject[])) {
      const sharded = Boolean((cr.spec?.sharding as { enabled?: boolean } | undefined)?.enabled);
      found.push({ flavor: 'percona', name: cr.metadata.name, detail: `Percona ${sharded ? 'sharded cluster' : 'replica set'} · ${String(cr.status?.state ?? '')}`, object: cr });
    }
    for (const cr of await kubectl.list('mongodbcommunity').catch(() => [] as KubeObject[])) {
      found.push({ flavor: 'community', name: cr.metadata.name, detail: `MongoDBCommunity · ${String(cr.spec?.members ?? '?')} members · ${String(cr.status?.phase ?? '')}`, object: cr });
    }
    for (const sts of await kubectl.list('statefulsets').catch(() => [] as KubeObject[])) {
      if (sts.metadata.ownerReferences?.length) {
        continue;
      }
      const containers = ((sts.spec?.template as { spec?: { containers?: Array<{ image?: string; args?: string[]; command?: string[] }> } } | undefined)?.spec?.containers ?? []);
      const mongo = containers.find((c) => /(^|\/)mongo(db)?[:@-]|mongodb-community-server|bitnami\/mongodb/.test(c.image ?? ''));
      if (mongo) {
        found.push({ flavor: 'statefulset', name: sts.metadata.name, detail: `StatefulSet · ${String(sts.spec?.replicas ?? '?')} replicas · ${mongo.image}`, object: sts });
      }
    }
    return found;
  }
}
