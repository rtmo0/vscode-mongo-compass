import type { Document } from 'mongodb';
import { DriverNodeAdmin } from '../driverNodeAdmin';
import {
  CONFIG_RS,
  ManagedCluster,
  connectionStringForNodes,
  hostOf,
  planNodes,
  portsNeeded,
  replicaSetNames,
  type NodeAdmin,
  type NodeRuntime
} from '../managedCluster';
import { generateKeyfile, mongoUri, openCommandTerminal, run, runMongoshInside, slugify, which } from '../process';
import { bootstrapShellScript } from '../exportScripts';
import { toYaml } from '../yaml';
import type {
  DeploymentNode,
  DeploymentProvider,
  DeploymentRecord,
  DeploymentStatus,
  ExportedDefinition,
  MemberKind,
  NodeLayout,
  NodeStatus,
  ProviderContext,
  TopologyKind
} from '../types';

const LABEL = 'mongo-compass.deployment';
const NODE_LABEL = 'mongo-compass.node';
const NETWORK_NODE = 'network';
const KEYFILE_DIR = '/etc/mongo-compass';

interface ContainerRow {
  Names: string;
  State: string;
  Status: string;
  Labels: string;
  Image: string;
}

export function containerPrefix(record: DeploymentRecord): string {
  return `mc-${slugify(record.spec.name, 30)}`;
}

function containerName(record: DeploymentRecord, nodeId: string): string {
  return `${containerPrefix(record)}-${nodeId}`;
}

function volumeName(record: DeploymentRecord, nodeId: string): string {
  return `${containerPrefix(record)}-${nodeId}-data`;
}

function imageFor(record: DeploymentRecord, node?: NodeLayout): string {
  const base = record.spec.docker?.image ?? `mongo:${record.spec.version}`;
  if (node?.version) {
    return `${base.split(':')[0]}:${node.version}`;
  }
  return base;
}

/** The mongod / mongos command line of a node; shared with the compose export. */
export function nodeCommand(record: DeploymentRecord, node: NodeLayout): string[] {
  const keyFile = record.spec.auth ? ['--keyFile', `${KEYFILE_DIR}/keyfile`] : [];
  if (node.role === 'mongos') {
    const configHosts = (record.nodes ?? []).filter((n) => n.replicaSet === CONFIG_RS).map(hostOf);
    return ['mongos', '--port', String(node.port), '--bind_ip_all', '--configdb', `${CONFIG_RS}/${configHosts.join(',')}`, ...keyFile];
  }
  const args = ['mongod', '--port', String(node.port), '--bind_ip_all', '--dbpath', '/data/db'];
  if (node.replicaSet) {
    args.push('--replSet', node.replicaSet);
    if (node.role === 'configsvr') {
      args.push('--configsvr');
    } else if (record.spec.topology === 'sharded') {
      args.push('--shardsvr');
    }
  }
  if (node.role === 'arbiter' || node.role === 'mongod') {
    // Keep small test deployments light.
    args.push('--wiredTigerCacheSizeGB', '0.25');
  }
  return [...args, ...keyFile];
}

/**
 * Admin commands for Docker nodes. Ports are published on 127.0.0.1, so the
 * driver on this machine reaches every node; only commands that need the
 * localhost exception (before the admin user exists) run inside the
 * container with `docker exec … mongosh`.
 */
class DockerNodeAdmin implements NodeAdmin {
  private readonly driver = new DriverNodeAdmin();

  async command(record: DeploymentRecord, node: NodeLayout, command: Document, options: { auth: boolean; password?: string; db?: string; timeoutMs?: number }): Promise<Document> {
    if (!record.spec.auth || options.auth || command.ping || command.hello) {
      return this.driver.command(record, node, command, options);
    }
    const script = `const conn = connect(${JSON.stringify(mongoUri(hostOf(node)))});\nresult = conn.getSiblingDB(${JSON.stringify(options.db ?? 'admin')}).runCommand(EJSON.parse(${JSON.stringify(JSON.stringify(command))}));\nif (!result.ok) { throw new Error(result.errmsg || JSON.stringify(result)); }`;
    return runMongoshInside<Document>(['docker', 'exec', '-i', containerName(record, node.id)], script, { timeoutMs: options.timeoutMs ?? 60_000 });
  }
}

/**
 * Deployments made of Docker containers.
 *
 * Every member joins the network namespace of one small "network" container
 * (`--network container:…`), like containers in a Kubernetes pod. Each
 * mongod listens on its own port, so the replica set config can use
 * `localhost:<port>` — an address that works both between members and from
 * this machine, where the network container publishes the whole port range
 * on 127.0.0.1. Drivers can then discover and fail over between members.
 */
export class DockerProvider implements DeploymentProvider, NodeRuntime {
  readonly id = 'docker' as const;
  readonly label = 'Docker';
  readonly topologies: TopologyKind[] = ['standalone', 'replicaSet', 'sharded'];

  private readonly cluster = new ManagedCluster(new DockerNodeAdmin(), this);

  constructor(private readonly allRecords: () => DeploymentRecord[]) {}

  async checkAvailable(): Promise<string | undefined> {
    if (!(await which('docker'))) {
      return 'The docker CLI is not on PATH. Install Docker Desktop or Docker Engine.';
    }
    try {
      await run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 15_000 });
      return undefined;
    } catch (err) {
      return `Docker is not running: ${(err as Error).message}`;
    }
  }

  // ───────────────────────────── NodeRuntime ─────────────────────────────

  /** Ports reserved by every Docker deployment, so a new one picks a range of its own. */
  reservedPorts(): Set<number> {
    const ports = new Set<number>();
    for (const record of this.allRecords().filter((r) => r.spec.provider === 'docker' && r.spec.docker)) {
      const { basePort, portRange } = record.spec.docker as { basePort: number; portRange: number };
      for (let p = basePort; p < basePort + portRange; p += 1) {
        ports.add(p);
      }
    }
    return ports;
  }

  /** New nodes can only use the range the network container published at creation. */
  async allocatePort(record: DeploymentRecord, pending: Set<number>): Promise<number> {
    const { basePort, portRange } = record.spec.docker as { basePort: number; portRange: number };
    const own = new Set((record.nodes ?? []).map((n) => n.port));
    for (let port = basePort; port < basePort + portRange; port += 1) {
      if (!own.has(port) && !pending.has(port)) {
        return port;
      }
    }
    throw new Error(`All ${portRange} ports reserved for this deployment (${basePort}–${last(basePort, portRange)}) are in use. Remove a node first.`);
  }

  async startNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext): Promise<void> {
    const name = containerName(record, node.id);
    const args = [
      'run', '-d',
      '--name', name,
      '--network', `container:${containerName(record, NETWORK_NODE)}`,
      '--label', `${LABEL}=${record.id}`,
      '--label', `${NODE_LABEL}=${node.id}`,
      '--label', `mongo-compass.role=${node.role}`,
      '--label', `mongo-compass.port=${node.port}`
    ];
    if (node.replicaSet) {
      args.push('--label', `mongo-compass.replset=${node.replicaSet}`);
    }
    if (record.spec.docker?.memory) {
      args.push('--memory', record.spec.docker.memory);
    }
    if (node.role !== 'mongos') {
      const volume = volumeName(record, node.id);
      await run('docker', ['volume', 'create', '--label', `${LABEL}=${record.id}`, volume], { token: ctx.token });
      args.push('-v', `${volume}:/data/db`);
    }
    if (record.spec.auth) {
      args.push('-v', `${containerPrefix(record)}-keyfile:${KEYFILE_DIR}:ro`);
    }
    args.push(imageFor(record, node), ...nodeCommand(record, node));
    await run('docker', args, { token: ctx.token, timeoutMs: 600_000 });
  }

  async removeNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext, keepData: boolean): Promise<void> {
    await run('docker', ['rm', '-f', containerName(record, node.id)], { token: ctx.token }).catch(() => undefined);
    if (!keepData && node.role !== 'mongos') {
      await run('docker', ['volume', 'rm', '-f', volumeName(record, node.id)], { token: ctx.token }).catch(() => undefined);
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async create(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const docker = record.spec.docker;
    if (!docker) {
      throw new Error('Docker settings are missing.');
    }
    if (portsNeeded(record.spec) > docker.portRange) {
      throw new Error(`The topology needs ${portsNeeded(record.spec)} ports but only ${docker.portRange} are reserved.`);
    }
    const existing = await this.containers(record);
    if (existing.length) {
      throw new Error(`Containers named ${containerPrefix(record)}-* already exist. Pick another name or remove them.`);
    }
    record.nodes = planNodes(record.spec, docker.basePort);
    await ctx.save(record);

    const image = imageFor(record);
    ctx.progress(`Pulling ${image}…`);
    await run('docker', ['pull', image], { token: ctx.token, timeoutMs: 900_000 }).catch(async (err: Error) => {
      // Offline use with a local image is fine.
      const local = await run('docker', ['image', 'inspect', image]).catch(() => undefined);
      if (!local) {
        throw err;
      }
    });

    if (record.spec.auth) {
      ctx.progress('Creating the keyfile…');
      const volume = `${containerPrefix(record)}-keyfile`;
      await run('docker', ['volume', 'create', '--label', `${LABEL}=${record.id}`, volume], { token: ctx.token });
      await run(
        'docker',
        ['run', '--rm', '-i', '-v', `${volume}:/keys`, '--entrypoint', 'sh', image, '-c', 'cat > /keys/keyfile && chmod 400 /keys/keyfile && chown 999:999 /keys/keyfile'],
        { input: generateKeyfile(), token: ctx.token }
      );
    }

    ctx.progress('Creating the network container…');
    const last = docker.basePort + docker.portRange - 1;
    await run(
      'docker',
      [
        'run', '-d',
        '--name', containerName(record, NETWORK_NODE),
        // Members share this container's network and host name; mongos registers itself under it.
        '--hostname', containerPrefix(record),
        '--label', `${LABEL}=${record.id}`,
        '--label', `${NODE_LABEL}=${NETWORK_NODE}`,
        '-p', `127.0.0.1:${docker.basePort}-${last}:${docker.basePort}-${last}`,
        '--entrypoint', 'sleep',
        image, 'infinity'
      ],
      { token: ctx.token }
    );

    await this.cluster.bootstrap(record, ctx);
  }

  async status(record: DeploymentRecord): Promise<DeploymentStatus> {
    const rows = await this.containers(record);
    const byNode = new Map(rows.map((row) => [labels(row).get(NODE_LABEL) ?? '', row]));
    const nodes: DeploymentNode[] = (record.nodes ?? []).map((node) => {
      const row = byNode.get(node.id);
      return {
        id: node.id,
        name: containerName(record, node.id),
        role: node.role,
        replicaSet: node.replicaSet,
        address: hostOf(node),
        status: row ? containerStatus(row.State) : 'unknown',
        detail: row ? `${row.Status} · ${row.Image}` : 'container missing'
      };
    });
    const network = byNode.get(NETWORK_NODE);
    if (nodes.some((n) => n.status === 'running')) {
      try {
        const password = record.spec.auth ? await this.passwordHook?.(record) : undefined;
        const states = await this.cluster.memberStates(record, password);
        for (const node of nodes) {
          node.memberState = states.get(node.id);
        }
      } catch {
        // state is optional
      }
    }
    const running = nodes.filter((n) => n.status === 'running').length;
    let state: DeploymentStatus['state'];
    if (record.provisioning?.state === 'creating') {
      state = 'creating';
    } else if (record.provisioning?.state === 'failed') {
      state = 'error';
    } else if (!network || network.State !== 'running') {
      state = running ? 'degraded' : 'stopped';
    } else {
      state = running === nodes.length ? 'running' : running === 0 ? 'stopped' : 'degraded';
    }
    return {
      state,
      nodes,
      message: record.provisioning?.message ?? (network ? `ports ${record.spec.docker?.basePort}–${(record.spec.docker?.basePort ?? 0) + (record.spec.docker?.portRange ?? 0) - 1}` : 'network container missing')
    };
  }

  /** Members register under the network container's host name; every port of the range is on 127.0.0.1. */
  async resolveHost(record: DeploymentRecord, host: string): Promise<string | undefined> {
    const port = Number(host.split(':').pop());
    return (record.nodes ?? []).some((n) => n.port === port) ? `localhost:${port}` : undefined;
  }

  /** Set by the registry so `status` can read member states of protected deployments. */
  passwordHook?: (record: DeploymentRecord) => Promise<string | undefined>;

  async connectionString(record: DeploymentRecord, password: string | undefined): Promise<string> {
    return connectionStringForNodes(record, password);
  }

  async destroy(record: DeploymentRecord, ctx: ProviderContext, options: { keepData: boolean }): Promise<void> {
    ctx.progress('Removing containers…');
    const rows = await this.containers(record);
    if (rows.length) {
      await run('docker', ['rm', '-f', ...rows.map((r) => r.Names)], { token: ctx.token, timeoutMs: 300_000 });
    }
    if (!options.keepData) {
      ctx.progress('Removing volumes…');
      const { stdout } = await run('docker', ['volume', 'ls', '-q', '--filter', `label=${LABEL}=${record.id}`]);
      const volumes = stdout.split('\n').map((v) => v.trim()).filter(Boolean);
      if (volumes.length) {
        await run('docker', ['volume', 'rm', '-f', ...volumes], { token: ctx.token });
      }
    }
  }

  async start(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    if (nodeId) {
      await run('docker', ['start', containerName(record, nodeId)], { token: ctx.token });
      return;
    }
    ctx.progress('Starting the network container…');
    await run('docker', ['start', containerName(record, NETWORK_NODE)], { token: ctx.token });
    const order = [...(record.nodes ?? []).filter((n) => n.role !== 'mongos'), ...(record.nodes ?? []).filter((n) => n.role === 'mongos')];
    for (const node of order) {
      ctx.progress(`Starting ${node.id}…`);
      // `restart` rejoins the network namespace when the network container was restarted.
      await run('docker', ['restart', containerName(record, node.id)], { token: ctx.token });
    }
  }

  async stop(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    if (nodeId) {
      await run('docker', ['stop', containerName(record, nodeId)], { token: ctx.token, timeoutMs: 120_000 });
      return;
    }
    const order = [...(record.nodes ?? []).filter((n) => n.role === 'mongos'), ...(record.nodes ?? []).filter((n) => n.role !== 'mongos')];
    for (const node of order) {
      ctx.progress(`Stopping ${node.id}…`);
      await run('docker', ['stop', containerName(record, node.id)], { token: ctx.token, timeoutMs: 120_000 }).catch(() => undefined);
    }
    await run('docker', ['stop', '-t', '1', containerName(record, NETWORK_NODE)], { token: ctx.token }).catch(() => undefined);
  }

  async restartNode(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    await run('docker', ['restart', containerName(record, nodeId)], { token: ctx.token, timeoutMs: 120_000 });
  }

  async chaos(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, action: 'kill' | 'pause' | 'unpause'): Promise<void> {
    await run('docker', [action, containerName(record, nodeId)], { token: ctx.token });
  }

  addMember(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, kind: MemberKind): Promise<string> {
    return this.cluster.addMember(record, ctx, replicaSet, kind);
  }

  removeMember(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    return this.cluster.removeMember(record, ctx, nodeId);
  }

  addShard(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    return this.cluster.addShard(record, ctx);
  }

  removeShard(record: DeploymentRecord, ctx: ProviderContext, shard: string): Promise<void> {
    return this.cluster.removeShard(record, ctx, shard);
  }

  addRouter(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    return this.cluster.addRouter(record, ctx);
  }

  removeRouter(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    return this.cluster.removeRouter(record, ctx, nodeId);
  }

  /** Recreate one node's container on another image, keeping its data volume. */
  async upgradeNode(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, version: string): Promise<void> {
    const node = (record.nodes ?? []).find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown node ${nodeId}.`);
    }
    const image = `${imageFor(record).split(':')[0]}:${version}`;
    ctx.progress(`Pulling ${image}…`);
    await run('docker', ['pull', image], { token: ctx.token, timeoutMs: 900_000 }).catch(() => undefined);
    ctx.progress(`Recreating ${node.id} on ${image}…`);
    await run('docker', ['rm', '-f', containerName(record, node.id)], { token: ctx.token });
    node.version = version;
    await ctx.save(record);
    await this.startNode(record, node, ctx);
    await this.cluster.waitReady(record, node, ctx, 180_000);
  }

  async openLogs(record: DeploymentRecord, nodeId: string): Promise<void> {
    openCommandTerminal(`logs: ${containerName(record, nodeId)}`, 'docker', ['logs', '-f', '--tail', '300', containerName(record, nodeId)]);
  }

  async openShell(record: DeploymentRecord, nodeId: string): Promise<void> {
    const node = (record.nodes ?? []).find((n) => n.id === nodeId);
    const args = ['exec', '-it', containerName(record, nodeId), 'mongosh', '--port', String(node?.port ?? 27017)];
    if (record.spec.auth && node?.role !== 'arbiter') {
      // mongosh prompts for the password, which keeps it out of the process list.
      args.push('-u', record.spec.username, '--authenticationDatabase', 'admin');
    }
    openCommandTerminal(`mongosh: ${containerName(record, nodeId)}`, 'docker', args);
  }

  async describeNode(record: DeploymentRecord, nodeId: string): Promise<string> {
    const { stdout } = await run('docker', ['inspect', containerName(record, nodeId)]);
    return stdout;
  }

  /** A docker-compose file that recreates this deployment, with an init service that bootstraps it. */
  async exportDefinition(record: DeploymentRecord): Promise<ExportedDefinition> {
    const docker = record.spec.docker as { basePort: number; portRange: number };
    const last = docker.basePort + docker.portRange - 1;
    const services: Record<string, unknown> = {
      network: {
        image: imageFor(record),
        entrypoint: ['sleep', 'infinity'],
        ports: [`127.0.0.1:${docker.basePort}-${last}:${docker.basePort}-${last}`]
      }
    };
    const volumes: Record<string, unknown> = {};
    const depends: string[] = [];
    if (record.spec.auth) {
      services.keyfile = {
        image: imageFor(record),
        entrypoint: ['sh', '-c', 'printf %s "$$MONGO_KEYFILE" > /keys/keyfile && chmod 400 /keys/keyfile && chown 999:999 /keys/keyfile'],
        environment: { MONGO_KEYFILE: '${MONGO_KEYFILE:?set MONGO_KEYFILE in .env}' },
        volumes: ['keyfile:/keys']
      };
      volumes.keyfile = {};
    }
    for (const node of record.nodes ?? []) {
      const service: Record<string, unknown> = {
        image: imageFor(record, node),
        network_mode: 'service:network',
        command: nodeCommand(record, node),
        depends_on: record.spec.auth ? { network: { condition: 'service_started' }, keyfile: { condition: 'service_completed_successfully' } } : ['network']
      };
      const mounts: string[] = [];
      if (node.role !== 'mongos') {
        mounts.push(`${node.id}-data:/data/db`);
        volumes[`${node.id}-data`] = {};
      }
      if (record.spec.auth) {
        mounts.push(`keyfile:${KEYFILE_DIR}:ro`);
      }
      if (mounts.length) {
        service.volumes = mounts;
      }
      services[node.id] = service;
      depends.push(node.id);
    }
    services.init = {
      image: imageFor(record),
      network_mode: 'service:network',
      depends_on: depends,
      restart: 'no',
      environment: record.spec.auth ? { MONGO_ROOT_PASSWORD: '${MONGO_ROOT_PASSWORD:?set MONGO_ROOT_PASSWORD in .env}' } : undefined,
      entrypoint: ['bash', '-c', bootstrapShellScript(record, (node) => `mongosh --quiet --port ${node.port}`).replace(/\$/g, '$$$$')]
    };
    const header = [
      `# MongoDB deployment "${record.spec.name}" exported by MongoDB Compass for VS Code.`,
      `# Topology: ${record.spec.topology}, MongoDB ${record.spec.version}.`,
      ...(record.spec.auth
        ? ['# Create a .env file next to this one with:', '#   MONGO_ROOT_PASSWORD=<password>', '#   MONGO_KEYFILE=<output of: openssl rand -base64 756 | tr -d "\\n">']
        : []),
      '# Start with: docker compose up -d   (the "init" service initiates the replica sets once)',
      `# Connect with: ${connectionStringForNodes(record, record.spec.auth ? 'PASSWORD' : undefined).replace('PASSWORD', '<password>')}`,
      ''
    ].join('\n');
    return { language: 'yaml', content: header + toYaml({ name: containerPrefix(record), services, volumes }) };
  }

  private async containers(record: DeploymentRecord): Promise<ContainerRow[]> {
    const { stdout } = await run('docker', ['ps', '-a', '--filter', `label=${LABEL}=${record.id}`, '--format', '{{json .}}']);
    const byLabel = parseRows(stdout);
    // Before the first container exists, also catch name clashes with leftovers of another deployment.
    if (byLabel.length === 0 && !record.nodes?.length) {
      const named = await run('docker', ['ps', '-a', '--filter', `name=^${containerPrefix(record)}-`, '--format', '{{json .}}']);
      return parseRows(named.stdout);
    }
    return byLabel;
  }

  /** Names of the replica sets, for pickers. */
  replicaSets(record: DeploymentRecord): string[] {
    return replicaSetNames(record);
  }
}

function last(basePort: number, portRange: number): number {
  return basePort + portRange - 1;
}

function parseRows(stdout: string): ContainerRow[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContainerRow);
}

function labels(row: ContainerRow): Map<string, string> {
  return new Map(
    row.Labels.split(',')
      .map((pair) => pair.split('='))
      .filter((pair) => pair.length >= 2)
      .map(([key, ...rest]) => [key, rest.join('=')])
  );
}

function containerStatus(state: string): NodeStatus {
  switch (state) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'restarting':
    case 'created':
      return 'starting';
    case 'exited':
      return 'stopped';
    case 'dead':
      return 'error';
    default:
      return 'unknown';
  }
}
