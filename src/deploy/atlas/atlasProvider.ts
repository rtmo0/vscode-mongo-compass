import * as vscode from 'vscode';
import * as zlib from 'zlib';
import { ConnectionString } from 'mongodb-connection-string-url';
import type {
  AtlasSpec,
  DeploymentNode,
  DeploymentProvider,
  DeploymentRecord,
  DeploymentStatus,
  ExportedDefinition,
  MemberKind,
  ProviderContext,
  TopologyKind
} from '../types';
import { AtlasClient, VERSIONS, type AtlasCredentials } from './atlasClient';

export interface AtlasProject {
  id: string;
  name: string;
}

interface RegionConfig {
  providerName: string;
  backingProviderName?: string;
  regionName: string;
  priority?: number;
  electableSpecs?: { instanceSize?: string; nodeCount?: number; diskSizeGB?: number };
  [key: string]: unknown;
}

interface ReplicationSpec {
  id?: string;
  zoneId?: string;
  zoneName?: string;
  regionConfigs: RegionConfig[];
  [key: string]: unknown;
}

export interface AtlasCluster {
  name: string;
  clusterType?: string;
  stateName?: string;
  paused?: boolean;
  mongoDBVersion?: string;
  mongoDBMajorVersion?: string;
  connectionStrings?: { standardSrv?: string; standard?: string };
  replicationSpecs?: ReplicationSpec[];
  providerSettings?: { backingProviderName?: string; regionName?: string };
  [key: string]: unknown;
}

interface AtlasProcess {
  id: string;
  hostname: string;
  port: number;
  typeName: string;
  replicaSetName?: string;
  userAlias?: string;
  version?: string;
  lastPing?: string;
}

function atlas(record: DeploymentRecord): AtlasSpec {
  if (!record.spec.atlas) {
    throw new Error('Atlas settings are missing.');
  }
  return record.spec.atlas;
}

/** Atlas cluster names map to host names in lower case without separators beyond `-`. */
function hostPrefix(clusterName: string): string {
  return clusterName.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * MongoDB Atlas through the Administration API: free (M0), Flex and
 * dedicated clusters. Scaling changes node counts or shards in the cluster
 * description; Atlas then rolls the change out itself.
 */
export class AtlasProvider implements DeploymentProvider {
  readonly id = 'atlas' as const;
  readonly label = 'MongoDB Atlas';
  readonly topologies: TopologyKind[] = ['replicaSet', 'sharded'];

  constructor(private readonly credentials: () => Promise<AtlasCredentials | undefined>) {}

  async client(): Promise<AtlasClient> {
    const creds = await this.credentials();
    if (!creds) {
      throw new Error('Sign in to Atlas first (MongoDB: Atlas Sign In).');
    }
    return new AtlasClient(creds);
  }

  async checkAvailable(): Promise<string | undefined> {
    return (await this.credentials()) ? undefined : 'Not signed in to Atlas. Run "MongoDB: Atlas Sign In" with a service account or API key.';
  }

  async projects(): Promise<AtlasProject[]> {
    const client = await this.client();
    return (await client.list<{ id: string; name: string }>('/groups', VERSIONS.legacy)).map((g) => ({ id: g.id, name: g.name }));
  }

  async clusters(projectId: string): Promise<Array<AtlasCluster & { flex?: boolean }>> {
    const client = await this.client();
    const [dedicated, flex] = await Promise.all([
      client.list<AtlasCluster>(`/groups/${projectId}/clusters`, VERSIONS.clusters),
      client.list<AtlasCluster>(`/groups/${projectId}/flexClusters`, VERSIONS.flex).catch(() => [] as AtlasCluster[])
    ]);
    return [...dedicated, ...flex.map((c) => ({ ...c, flex: true }))];
  }

  private clusterPath(record: DeploymentRecord): string {
    const spec = atlas(record);
    const kind = spec.tier === 'flex' ? 'flexClusters' : 'clusters';
    return `/groups/${spec.projectId}/${kind}/${encodeURIComponent(spec.clusterName)}`;
  }

  private versions(record: DeploymentRecord): string[] {
    return atlas(record).tier === 'flex' ? VERSIONS.flex : VERSIONS.clusters;
  }

  async getCluster(record: DeploymentRecord): Promise<AtlasCluster> {
    return (await this.client()).get<AtlasCluster>(this.clusterPath(record), this.versions(record));
  }

  /** The request body that creates the cluster described by `record`. */
  clusterBody(record: DeploymentRecord): Record<string, unknown> {
    const spec = atlas(record);
    if (spec.tier === 'flex') {
      return {
        name: spec.clusterName,
        providerSettings: { backingProviderName: spec.cloudProvider, regionName: spec.region },
        terminationProtectionEnabled: false
      };
    }
    if (spec.tier === 'free') {
      return {
        name: spec.clusterName,
        clusterType: 'REPLICASET',
        replicationSpecs: [
          {
            zoneName: 'Zone 1',
            regionConfigs: [
              { providerName: 'TENANT', backingProviderName: spec.cloudProvider, regionName: spec.region, priority: 7, electableSpecs: { instanceSize: 'M0' } }
            ]
          }
        ]
      };
    }
    const shardCount = record.spec.topology === 'sharded' ? Math.max(1, record.spec.shards) : 1;
    const shard = (): ReplicationSpec => ({
      zoneName: 'Zone 1',
      regionConfigs: [
        {
          providerName: spec.cloudProvider,
          regionName: spec.region,
          priority: 7,
          electableSpecs: { instanceSize: spec.instanceSize ?? 'M10', nodeCount: record.spec.members }
        }
      ]
    });
    return {
      name: spec.clusterName,
      clusterType: record.spec.topology === 'sharded' ? 'SHARDED' : 'REPLICASET',
      mongoDBMajorVersion: record.spec.version,
      replicationSpecs: Array.from({ length: shardCount }, shard)
    };
  }

  async create(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const spec = atlas(record);
    const client = await this.client();
    const base = `/groups/${spec.projectId}`;
    ctx.progress(`Creating cluster ${spec.clusterName}…`);
    await client.post(spec.tier === 'flex' ? `${base}/flexClusters` : `${base}/clusters`, this.clusterBody(record), this.versions(record));

    const password = await ctx.password(record);
    if (password) {
      ctx.progress(`Creating database user ${record.spec.username}…`);
      await client
        .post(
          `${base}/databaseUsers`,
          {
            databaseName: 'admin',
            username: record.spec.username,
            password,
            roles: [{ roleName: 'atlasAdmin', databaseName: 'admin' }],
            scopes: [{ name: spec.clusterName, type: 'CLUSTER' }]
          },
          VERSIONS.legacy
        )
        .catch((err: Error) => {
          if (!/DUPLICATE|already exists/i.test(err.message)) {
            throw err;
          }
        });
    }
    await this.waitForState(record, ctx, ['IDLE']);
  }

  /** Add an IP access list entry (CIDR) to the project. */
  async addAccessListEntry(projectId: string, cidr: string, comment: string): Promise<void> {
    const client = await this.client();
    await client.post(`/groups/${projectId}/accessList`, [{ cidrBlock: cidr, comment }], VERSIONS.legacy);
  }

  private async waitForState(record: DeploymentRecord, ctx: ProviderContext, states: string[], timeoutMs = 45 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (ctx.token.isCancellationRequested) {
        throw new Error('Cancelled — Atlas keeps applying the change.');
      }
      const cluster = await this.getCluster(record);
      ctx.progress(`${atlas(record).clusterName}: ${cluster.stateName ?? 'unknown'}`);
      if (cluster.stateName && states.includes(cluster.stateName)) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
    throw new Error('Timed out; Atlas is still working on the cluster.');
  }

  async status(record: DeploymentRecord): Promise<DeploymentStatus> {
    const spec = atlas(record);
    const cluster = await this.getCluster(record);
    const nodes: DeploymentNode[] = [];
    if (spec.tier !== 'flex') {
      const client = await this.client();
      const processes = await client.list<AtlasProcess>(`/groups/${spec.projectId}/processes`, VERSIONS.legacy).catch(() => [] as AtlasProcess[]);
      const prefix = `${hostPrefix(spec.clusterName)}-`;
      for (const p of processes.filter((p) => p.hostname.toLowerCase().startsWith(prefix) || (p.userAlias ?? '').toLowerCase().startsWith(prefix))) {
        const host = `${p.hostname}:${p.port}`;
        const stale = p.lastPing ? Date.now() - Date.parse(p.lastPing) > 5 * 60_000 : false;
        nodes.push({
          id: host,
          name: p.userAlias ?? p.hostname,
          role: /MONGOS/.test(p.typeName) ? 'mongos' : /CONFIG/.test(p.typeName) ? 'configsvr' : /ARBITER/.test(p.typeName) ? 'arbiter' : 'mongod',
          replicaSet: p.replicaSetName,
          address: host,
          status: cluster.paused ? 'stopped' : stale ? 'unknown' : 'running',
          detail: [p.typeName, p.version].filter(Boolean).join(' · '),
          memberState: /PRIMARY/.test(p.typeName) ? 'PRIMARY' : /SECONDARY/.test(p.typeName) ? 'SECONDARY' : undefined
        });
      }
      nodes.sort((a, b) => a.name.localeCompare(b.name));
    }
    const stateName = cluster.stateName ?? '';
    const state: DeploymentStatus['state'] = cluster.paused
      ? 'paused'
      : stateName === 'IDLE'
        ? 'running'
        : stateName === 'CREATING'
          ? 'creating'
          : stateName === 'DELETING'
            ? 'deleting'
            : stateName === 'UPDATING' || stateName === 'REPAIRING'
              ? 'updating'
              : 'unknown';
    const size = spec.tier === 'flex' ? 'Flex' : cluster.replicationSpecs?.[0]?.regionConfigs?.[0]?.electableSpecs?.instanceSize ?? spec.instanceSize ?? '';
    return {
      state,
      nodes,
      message: `${spec.projectName ?? spec.projectId} · ${size} · MongoDB ${cluster.mongoDBVersion ?? cluster.mongoDBMajorVersion ?? '?'} · ${stateName}`
    };
  }

  async connectionString(record: DeploymentRecord, password: string | undefined): Promise<string> {
    const cluster = await this.getCluster(record);
    const srv = cluster.connectionStrings?.standardSrv ?? cluster.connectionStrings?.standard;
    if (!srv) {
      throw new Error('Atlas has not published a connection string yet; try again when the cluster is ready.');
    }
    const cs = new ConnectionString(srv);
    if (password) {
      cs.username = record.spec.username;
      cs.password = password;
    }
    if (!cs.searchParams.has('appName')) {
      cs.searchParams.set('appName', 'mongo-compass-vscode');
    }
    return cs.toString();
  }

  async destroy(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    ctx.progress(`Deleting ${atlas(record).clusterName}…`);
    await (await this.client()).delete(this.clusterPath(record), atlas(record).tier === 'flex' ? VERSIONS.flex : VERSIONS.legacy);
  }

  async start(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    this.requireDedicated(record, 'resume');
    await (await this.client()).patch(this.clusterPath(record), { paused: false }, VERSIONS.clusters);
    await this.waitForState(record, ctx, ['IDLE']);
  }

  async stop(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    this.requireDedicated(record, 'pause');
    await (await this.client()).patch(this.clusterPath(record), { paused: true }, VERSIONS.clusters);
    ctx.progress('Pause requested.');
  }

  /** Atlas "Test failover": every replica set elects a new primary. */
  async failover(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    this.requireDedicated(record, 'test failover');
    await (await this.client()).post(`${this.clusterPath(record)}/restartPrimaries`, {}, VERSIONS.restart);
    ctx.progress('Failover started; Atlas restarts the primaries one replica set at a time.');
  }

  /** Change the electable node count of every shard (3, 5 or 7). */
  async scaleReplicaSet(record: DeploymentRecord, ctx: ProviderContext, _replicaSet: string, members: number): Promise<void> {
    this.requireDedicated(record, 'scale');
    if (![3, 5, 7].includes(members)) {
      throw new Error('Atlas replica sets have 3, 5 or 7 electable nodes.');
    }
    await this.updateSpecs(record, ctx, (specs) => {
      for (const spec of specs) {
        for (const region of spec.regionConfigs) {
          if (region.electableSpecs) {
            region.electableSpecs.nodeCount = members;
          }
        }
      }
      return specs;
    });
    record.spec.members = members;
    await ctx.save(record);
  }

  async addMember(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, kind: MemberKind): Promise<string> {
    if (kind !== 'secondary') {
      throw new Error('Atlas manages hidden members and arbiters itself; only electable nodes can be added.');
    }
    const cluster = await this.getCluster(record);
    const current = cluster.replicationSpecs?.[0]?.regionConfigs?.[0]?.electableSpecs?.nodeCount ?? record.spec.members;
    await this.scaleReplicaSet(record, ctx, replicaSet, current + 2);
    return `${current + 2} nodes`;
  }

  async removeMember(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const cluster = await this.getCluster(record);
    const current = cluster.replicationSpecs?.[0]?.regionConfigs?.[0]?.electableSpecs?.nodeCount ?? record.spec.members;
    await this.scaleReplicaSet(record, ctx, '', current - 2);
  }

  async addShard(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    this.requireDedicated(record, 'add shards to');
    let count = 0;
    await this.updateSpecs(
      record,
      ctx,
      (specs) => {
        const copy = structuredClone(specs[specs.length - 1]);
        delete copy.id;
        delete copy.zoneId;
        specs.push(copy);
        count = specs.length;
        return specs;
      },
      { clusterType: 'SHARDED' }
    );
    return `${count} shards`;
  }

  async removeShard(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    this.requireDedicated(record, 'remove shards from');
    await this.updateSpecs(record, ctx, (specs) => {
      if (specs.length <= 1) {
        throw new Error('A sharded cluster needs at least one shard.');
      }
      return specs.slice(0, -1);
    });
  }

  async upgradeAll(record: DeploymentRecord, ctx: ProviderContext, version: string): Promise<void> {
    this.requireDedicated(record, 'upgrade');
    await (await this.client()).patch(this.clusterPath(record), { mongoDBMajorVersion: version }, VERSIONS.clusters);
    record.spec.version = version;
    await ctx.save(record);
    ctx.progress(`Upgrade to ${version} requested.`);
  }

  private async updateSpecs(
    record: DeploymentRecord,
    ctx: ProviderContext,
    change: (specs: ReplicationSpec[]) => ReplicationSpec[],
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const cluster = await this.getCluster(record);
    const specs = change(structuredClone(cluster.replicationSpecs ?? []));
    await (await this.client()).patch(this.clusterPath(record), { ...extra, replicationSpecs: specs }, VERSIONS.clusters);
    ctx.progress('Change submitted; Atlas applies it as a rolling update.');
  }

  private requireDedicated(record: DeploymentRecord, action: string): void {
    if (atlas(record).tier !== 'dedicated') {
      throw new Error(`Atlas can only ${action} dedicated (M10+) clusters.`);
    }
  }

  /** Download the host's mongod log and open it in an editor. */
  async openLogs(record: DeploymentRecord, nodeId: string): Promise<void> {
    const spec = atlas(record);
    const hostname = nodeId.split(':')[0];
    const gz = await (await this.client()).download(`/groups/${spec.projectId}/clusters/${hostname}/logs/mongodb.gz`, VERSIONS.logs);
    const text = zlib.gunzipSync(gz).toString('utf8');
    const lines = text.trimEnd().split('\n');
    const doc = await vscode.workspace.openTextDocument({ content: lines.slice(-5000).join('\n'), language: 'log' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  async describeNode(record: DeploymentRecord, nodeId: string): Promise<string> {
    const spec = atlas(record);
    const processes = await (await this.client()).list<AtlasProcess>(`/groups/${spec.projectId}/processes`, VERSIONS.legacy);
    return JSON.stringify(processes.find((p) => `${p.hostname}:${p.port}` === nodeId) ?? {}, null, 2);
  }

  async exportDefinition(record: DeploymentRecord): Promise<ExportedDefinition> {
    const cluster = await this.getCluster(record);
    const keep = ['name', 'clusterType', 'mongoDBMajorVersion', 'replicationSpecs', 'providerSettings', 'backupEnabled', 'diskSizeGB', 'tags', 'terminationProtectionEnabled'];
    const body = Object.fromEntries(Object.entries(cluster).filter(([key]) => keep.includes(key)));
    return {
      language: 'json',
      content: JSON.stringify(
        {
          comment: `POST https://cloud.mongodb.com/api/atlas/v2${this.clusterPath(record).replace(/\/[^/]+$/, '')} with Accept/Content-Type application/vnd.atlas.${this.versions(record)[0]}+json`,
          body
        },
        null,
        2
      )
    };
  }
}
