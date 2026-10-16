import { BSON, type Document, type MongoClient } from 'mongodb';
import type { ConnectionManager } from '../connectionManager';
import type { ConnectedConnection } from '../types';
import { logger } from '../logger';
import type { NodeClientPool } from './nodeClients';
import { checkMajorityAfter, mergeReports, validateReplicaSetConfig, votingChanges } from './safety';
import type {
  BalancerInfo,
  ClusterOverview,
  DatabaseUser,
  MemberChanges,
  NewMemberOptions,
  OplogInfo,
  ReplicaMember,
  ReplicaSetInfo,
  RouterInfo,
  SafetyReport,
  ShardedCollectionInfo,
  ShardInfo,
  ShardingInfo,
  ZoneRange
} from './types';

/** A router that has not pinged the config servers for this long is shown as stale. */
const STALE_ROUTER_MS = 5 * 60 * 1000;

export interface ReconfigPlan {
  current: Document;
  next: Document;
  report: SafetyReport;
}

/**
 * Deep copy that keeps BSON types. `structuredClone` would turn an ObjectId
 * (e.g. `settings.replicaSetId`) into a plain object the server rejects.
 */
export function cloneBson<T extends Document>(doc: T): T {
  return BSON.deserialize(BSON.serialize(doc)) as T;
}

/** Compare dotted versions: negative when `a < b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return undefined;
}

function sameHost(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Split `rs/host1,host2` into the set name and its hosts. */
export function parseShardHost(value: string): { setName?: string; hosts: string[] } {
  const slash = value.indexOf('/');
  const setName = slash >= 0 ? value.slice(0, slash) : undefined;
  const hosts = (slash >= 0 ? value.slice(slash + 1) : value).split(',').map((h) => h.trim()).filter(Boolean);
  return { setName, hosts };
}

/**
 * Cluster administration on top of the official driver: topology discovery,
 * replica set membership and elections, sharding, the balancer, zones,
 * users, the profiler and feature compatibility.
 *
 * Commands that must reach the primary go through `primaryClient`, so they
 * also work when the saved connection points at a secondary directly.
 */
export class ClusterService {
  private readonly overviews = new Map<string, Promise<ClusterOverview>>();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly nodes: NodeClientPool
  ) {}

  // ───────────────────────────── topology ─────────────────────────────

  /**
   * Topology, members, sharding and warnings of a deployment. Calls made while
   * one is running (the Cluster view and the dashboard opening together) share it.
   */
  overview(connectionId: string): Promise<ClusterOverview> {
    let pending = this.overviews.get(connectionId);
    if (!pending) {
      pending = this.readOverview(connectionId).finally(() => this.overviews.delete(connectionId));
      this.overviews.set(connectionId, pending);
    }
    return pending;
  }

  private async readOverview(connectionId: string): Promise<ClusterOverview> {
    const connection = await this.connection(connectionId);
    const admin = connection.client.db('admin');
    const [hello, fcv, rwConcern, buildInfo] = await Promise.all([
      admin.command({ hello: 1 }),
      admin.command({ getParameter: 1, featureCompatibilityVersion: 1 }).catch(() => undefined),
      admin.command({ getDefaultRWConcern: 1 }).catch(() => undefined),
      admin.command({ buildInfo: 1 }).catch(() => undefined)
    ]);
    const warnings: string[] = [];

    const overview: ClusterOverview = {
      kind: hello.msg === 'isdbgrid' ? 'sharded' : hello.setName ? 'replicaSet' : 'standalone',
      connectionId,
      connectionName: connection.options.name,
      serverVersion: connection.topology?.serverVersion ?? 'unknown',
      isAtlas: connection.topology?.isAtlas ?? false,
      fetchedAt: Date.now(),
      host: typeof hello.me === 'string' ? hello.me : undefined,
      warnings
    };

    // Read the version now: it changes during rolling upgrades while the connection stays open.
    if (buildInfo?.version) {
      overview.serverVersion = String(buildInfo.version);
    }
    overview.featureCompatibilityVersion = (fcv?.featureCompatibilityVersion as Document | undefined)?.version as string | undefined;
    overview.defaultWriteConcern = rwConcern?.defaultWriteConcern as Document | undefined;
    if (
      overview.featureCompatibilityVersion &&
      overview.serverVersion !== 'unknown' &&
      !overview.serverVersion.startsWith(overview.featureCompatibilityVersion)
    ) {
      warnings.push(
        `featureCompatibilityVersion is ${overview.featureCompatibilityVersion} while the server runs ${overview.serverVersion}. Raise it once the upgrade is final.`
      );
    }

    if (overview.kind === 'replicaSet') {
      overview.replicaSet = await this.readReplicaSet(connection.client, Boolean(hello.configsvr));
      warnings.push(...replicaSetWarnings(overview.replicaSet));
    } else if (overview.kind === 'sharded') {
      overview.sharding = await this.readSharding(connectionId, connection.client, overview.serverVersion);
      for (const shard of overview.sharding.shards) {
        if (shard.replicaSet && !shard.replicaSet.error) {
          warnings.push(...replicaSetWarnings(shard.replicaSet).map((w) => `${shard.id}: ${w}`));
        }
        if (shard.draining) {
          warnings.push(`Shard ${shard.id} is draining.`);
        }
      }
      if (overview.sharding.configServers && !overview.sharding.configServers.error) {
        warnings.push(...replicaSetWarnings(overview.sharding.configServers).map((w) => `config: ${w}`));
      }
      for (const router of overview.sharding.routers.filter((r) => r.stale)) {
        warnings.push(`Router ${router.host} has not reported since ${router.ping ?? 'a long time'}.`);
      }
      if (!overview.sharding.balancer.running && !overview.sharding.balancer.error) {
        warnings.push('The balancer is stopped.');
      }
    }
    return overview;
  }

  async readReplicaSet(client: MongoClient, configsvr = false): Promise<ReplicaSetInfo> {
    const admin = client.db('admin');
    const [status, configResult, oplog] = await Promise.all([
      admin.command({ replSetGetStatus: 1 }),
      admin.command({ replSetGetConfig: 1 }),
      this.readOplog(client).catch(() => undefined)
    ]);
    const config = configResult.config as Document;
    const configMembers = new Map(((config.members ?? []) as Document[]).map((m) => [Number(m._id), m]));
    const statusMembers = (status.members ?? []) as Document[];
    const primary = statusMembers.find((m) => m.stateStr === 'PRIMARY');
    const primaryOptime = primary?.optimeDate instanceof Date ? primary.optimeDate.getTime() : undefined;

    const members: ReplicaMember[] = statusMembers.map((m) => {
      const cfg = configMembers.get(Number(m._id)) ?? {};
      const optime = m.optimeDate instanceof Date ? m.optimeDate.getTime() : undefined;
      const isDataBearing = m.stateStr === 'SECONDARY' || m.stateStr === 'PRIMARY' || m.stateStr === 'RECOVERING';
      return {
        id: Number(m._id),
        host: String(m.name),
        state: String(m.stateStr),
        health: Number(m.health ?? 0),
        self: Boolean(m.self),
        uptime: typeof m.uptime === 'number' ? m.uptime : undefined,
        optimeDate: iso(m.optimeDate),
        lagSeconds:
          isDataBearing && primaryOptime !== undefined && optime !== undefined
            ? Math.max(0, Math.round((primaryOptime - optime) / 1000))
            : null,
        pingMs: typeof m.pingMs === 'number' ? m.pingMs : undefined,
        syncSourceHost: m.syncSourceHost ? String(m.syncSourceHost) : undefined,
        electionDate: iso(m.electionDate),
        lastHeartbeatMessage: m.lastHeartbeatMessage ? String(m.lastHeartbeatMessage) : undefined,
        priority: Number(cfg.priority ?? 1),
        votes: Number(cfg.votes ?? 1),
        hidden: Boolean(cfg.hidden),
        arbiterOnly: Boolean(cfg.arbiterOnly),
        secondaryDelaySecs: Number(cfg.secondaryDelaySecs ?? cfg.slaveDelay ?? 0),
        buildIndexes: cfg.buildIndexes !== false,
        tags: (cfg.tags ?? {}) as Record<string, string>
      };
    });

    const settings = (config.settings ?? {}) as Document;
    return {
      name: String(status.set ?? config._id),
      term: typeof status.term === 'number' ? status.term : Number(status.term ?? NaN) || undefined,
      configVersion: Number(config.version),
      configTerm: config.term !== undefined ? Number(config.term) : undefined,
      primary: primary ? String(primary.name) : undefined,
      members,
      heartbeatIntervalMillis: settings.heartbeatIntervalMillis as number | undefined,
      electionTimeoutMillis: settings.electionTimeoutMillis as number | undefined,
      writeConcernMajorityJournalDefault: config.writeConcernMajorityJournalDefault as boolean | undefined,
      configsvr: configsvr || Boolean(config.configsvr),
      oplog
    };
  }

  private async readOplog(client: MongoClient): Promise<OplogInfo> {
    const oplog = client.db('local').collection('oplog.rs');
    const [[stats], [first], [last]] = await Promise.all([
      // Only the sizes: the full storage stats carry the storage engine details.
      oplog.aggregate([{ $collStats: { storageStats: {} } }, { $project: { 'storageStats.maxSize': 1, 'storageStats.size': 1 } }]).toArray(),
      oplog.find({}, { projection: { ts: 1, wall: 1 } }).sort({ $natural: 1 }).limit(1).toArray(),
      oplog.find({}, { projection: { ts: 1, wall: 1 } }).sort({ $natural: -1 }).limit(1).toArray()
    ]);
    const storage = (stats?.storageStats ?? {}) as Document;
    const toDate = (entry: Document | undefined): Date | undefined => {
      if (!entry) {
        return undefined;
      }
      if (entry.wall instanceof Date) {
        return entry.wall;
      }
      const ts = entry.ts as { getHighBits?: () => number } | undefined;
      return ts?.getHighBits ? new Date(ts.getHighBits() * 1000) : undefined;
    };
    const firstDate = toDate(first);
    const lastDate = toDate(last);
    return {
      maxSizeMB: Math.round(Number(storage.maxSize ?? 0) / 1024 / 1024),
      usedMB: Math.round(Number(storage.size ?? 0) / 1024 / 1024),
      windowHours: firstDate && lastDate ? Math.round(((lastDate.getTime() - firstDate.getTime()) / 3_600_000) * 10) / 10 : null,
      first: firstDate?.toISOString(),
      last: lastDate?.toISOString()
    };
  }

  private async readSharding(connectionId: string, client: MongoClient, serverVersion: string): Promise<ShardingInfo> {
    const admin = client.db('admin');
    const config = client.db('config');

    const [shardsResult, routersDocs, balancer, databases, collections, chunkCounts, zoneDocs, shardMap, distribution] =
      await Promise.all([
        admin.command({ listShards: 1 }),
        config.collection('mongos').find({}).sort({ ping: -1 }).toArray().catch(() => [] as Document[]),
        this.readBalancer(client),
        config.collection('databases').find({}).sort({ _id: 1 }).toArray().catch(() => [] as Document[]),
        config
          .collection('collections')
          .find({ dropped: { $ne: true }, key: { $exists: true }, unsplittable: { $ne: true } })
          .sort({ _id: 1 })
          .toArray()
          .catch(() => [] as Document[]),
        config
          .collection('chunks')
          .aggregate([{ $group: { _id: { uuid: '$uuid', ns: '$ns', shard: '$shard' }, n: { $sum: 1 } } }])
          .toArray()
          .catch(() => [] as Document[]),
        config.collection('tags').find({}).sort({ ns: 1, min: 1 }).toArray().catch(() => [] as Document[]),
        admin.command({ getShardMap: 1 }).catch(() => undefined),
        compareVersions(serverVersion, '6.0.3') >= 0
          ? admin.aggregate([{ $shardedDataDistribution: {} }]).toArray().catch(() => [] as Document[])
          : Promise.resolve([] as Document[])
      ]);

    const shards: ShardInfo[] = ((shardsResult.shards ?? []) as Document[]).map((s) => {
      const parsed = parseShardHost(String(s.host));
      return {
        id: String(s._id),
        host: String(s.host),
        replicaSetName: parsed.setName,
        hosts: parsed.hosts,
        state: s.state as number | undefined,
        draining: Boolean(s.draining),
        zones: ((s.tags ?? []) as string[]).map(String)
      };
    });

    // Each shard and the config servers are replica sets the mongos cannot
    // report on, so ask one of their members directly — all of them at once.
    const readConfigServers = async (): Promise<ShardingInfo['configServers']> => {
      const configHost = (shardMap?.map as Document | undefined)?.config;
      if (typeof configHost !== 'string') {
        return undefined;
      }
      const parsed = parseShardHost(configHost);
      try {
        const { client: member } = await this.nodes.anyMember(connectionId, parsed.hosts);
        return { ...(await this.readReplicaSet(member, true)), hosts: parsed.hosts };
      } catch (err) {
        return {
          name: parsed.setName ?? 'config',
          members: [],
          configsvr: true,
          hosts: parsed.hosts,
          error: (err as Error).message
        };
      }
    };
    const [configServers] = await Promise.all([
      readConfigServers(),
      ...shards.map(async (shard) => {
        try {
          const { client: member } = await this.nodes.anyMember(connectionId, shard.hosts);
          shard.replicaSet = await this.readReplicaSet(member);
        } catch (err) {
          shard.replicaSet = {
            name: shard.replicaSetName ?? shard.id,
            members: [],
            configsvr: false,
            error: (err as Error).message
          };
        }
      })
    ]);

    const routers: RouterInfo[] = routersDocs.map((r) => {
      const ping = r.ping instanceof Date ? r.ping : undefined;
      return {
        host: String(r._id),
        ping: ping?.toISOString(),
        upSeconds: typeof r.up === 'number' ? r.up : undefined,
        version: r.mongoVersion ? String(r.mongoVersion) : undefined,
        stale: ping ? Date.now() - ping.getTime() > STALE_ROUTER_MS : true
      };
    });

    const nsByUuid = new Map<string, string>();
    for (const c of collections) {
      if (c.uuid) {
        nsByUuid.set(String((c.uuid as { toHexString?: () => string }).toHexString?.() ?? c.uuid), String(c._id));
      }
    }
    const chunksByNs = new Map<string, Record<string, number>>();
    for (const row of chunkCounts) {
      const id = row._id as Document;
      const uuid = id.uuid ? String((id.uuid as { toHexString?: () => string }).toHexString?.() ?? id.uuid) : undefined;
      const ns = (uuid && nsByUuid.get(uuid)) ?? (id.ns ? String(id.ns) : undefined);
      if (!ns) {
        continue;
      }
      const counts = chunksByNs.get(ns) ?? {};
      counts[String(id.shard)] = Number(row.n);
      chunksByNs.set(ns, counts);
    }
    const distributionByNs = new Map<string, Document>(distribution.map((d) => [String(d.ns), d]));

    const shardedCollections: ShardedCollectionInfo[] = collections.map((c) => {
      const ns = String(c._id);
      const chunks = chunksByNs.get(ns) ?? {};
      const dist = distributionByNs.get(ns);
      return {
        namespace: ns,
        key: (c.key ?? {}) as Document,
        unique: Boolean(c.unique),
        balancingEnabled: !c.noBalance,
        chunksByShard: chunks,
        totalChunks: Object.values(chunks).reduce((sum, n) => sum + n, 0),
        dataByShard: dist
          ? ((dist.shards ?? []) as Document[]).map((s) => ({
              shard: String(s.shardName),
              documents: Number(s.numOwnedDocuments ?? 0),
              sizeBytes: Number(s.ownedSizeBytes ?? 0),
              orphanedDocuments: Number(s.numOrphanedDocs ?? 0)
            }))
          : undefined
      };
    });

    const zones: ZoneRange[] = zoneDocs.map((z) => ({
      namespace: String(z.ns),
      zone: String(z.tag),
      min: (z.min ?? {}) as Document,
      max: (z.max ?? {}) as Document
    }));

    return {
      shards,
      routers,
      configServers,
      balancer,
      databases: databases
        .filter((d) => d._id !== 'config' && d._id !== 'admin')
        .map((d) => ({ name: String(d._id), primary: String(d.primary ?? '') })),
      collections: shardedCollections,
      zones
    };
  }

  private async readBalancer(client: MongoClient): Promise<BalancerInfo> {
    try {
      const [status, settings] = await Promise.all([
        client.db('admin').command({ balancerStatus: 1 }),
        client.db('config').collection('settings').findOne({ _id: 'balancer' as never })
      ]);
      const window = settings?.activeWindow as { start?: string; stop?: string } | undefined;
      return {
        mode: String(status.mode ?? 'unknown'),
        running: status.mode === 'full',
        inBalancerRound: Boolean(status.inBalancerRound),
        numBalancerRounds: status.numBalancerRounds as number | undefined,
        window: window?.start && window.stop ? { start: window.start, stop: window.stop } : undefined
      };
    } catch (err) {
      return { mode: 'unknown', running: false, inBalancerRound: false, error: (err as Error).message };
    }
  }

  /**
   * A cheap health snapshot for background monitoring: `replSetGetStatus` of
   * the replica set, or of every shard and the config servers of a cluster.
   */
  async health(connectionId: string): Promise<Array<{ name: string; primary?: string; members: Array<Pick<ReplicaMember, 'host' | 'state' | 'health' | 'lagSeconds' | 'secondaryDelaySecs'>>; error?: string }>> {
    const connection = await this.connection(connectionId);
    const admin = connection.client.db('admin');
    const hello = await admin.command({ hello: 1 });
    const fromStatus = (status: Document): { name: string; primary?: string; members: Array<Pick<ReplicaMember, 'host' | 'state' | 'health' | 'lagSeconds' | 'secondaryDelaySecs'>> } => {
      const members = (status.members ?? []) as Document[];
      const primary = members.find((m) => m.stateStr === 'PRIMARY');
      const primaryOptime = primary?.optimeDate instanceof Date ? primary.optimeDate.getTime() : undefined;
      return {
        name: String(status.set),
        primary: primary ? String(primary.name) : undefined,
        members: members.map((m) => ({
          host: String(m.name),
          state: String(m.stateStr),
          health: Number(m.health ?? 0),
          secondaryDelaySecs: 0,
          lagSeconds:
            m.stateStr === 'SECONDARY' && primaryOptime !== undefined && m.optimeDate instanceof Date
              ? Math.max(0, Math.round((primaryOptime - m.optimeDate.getTime()) / 1000))
              : null
        }))
      };
    };
    // Delayed members are expected to lag, so read their delay from the config.
    const withDelays = async (client: MongoClient): Promise<ReturnType<typeof fromStatus>> => {
      const [rawStatus, { config }] = await Promise.all([
        client.db('admin').command({ replSetGetStatus: 1 }),
        client.db('admin').command({ replSetGetConfig: 1 })
      ]);
      const status = fromStatus(rawStatus);
      const delays = new Map(((config.members ?? []) as Document[]).map((m) => [String(m.host), Number(m.secondaryDelaySecs ?? m.slaveDelay ?? 0)]));
      status.members.forEach((m) => (m.secondaryDelaySecs = delays.get(m.host) ?? 0));
      return status;
    };
    if (hello.setName) {
      return [await withDelays(connection.client)];
    }
    if (hello.msg !== 'isdbgrid') {
      return [];
    }
    const [shards, shardMap] = await Promise.all([
      admin.command({ listShards: 1 }),
      admin.command({ getShardMap: 1 }).catch(() => undefined)
    ]);
    const sets = ((shards.shards ?? []) as Document[]).map((s) => ({ name: String(s._id), ...parseShardHost(String(s.host)) }));
    const configHost = (shardMap?.map as Document | undefined)?.config;
    if (typeof configHost === 'string') {
      sets.push({ name: 'config', ...parseShardHost(configHost) });
    }
    return Promise.all(
      sets.map(async (set) => {
        try {
          const { client } = await this.nodes.anyMember(connectionId, set.hosts);
          return await withDelays(client);
        } catch (err) {
          return { name: set.setName ?? set.name, members: [], error: (err as Error).message };
        }
      })
    );
  }

  // ───────────────────────────── clients ─────────────────────────────

  private async connection(connectionId: string): Promise<ConnectedConnection> {
    return this.connectionManager.requireClient(connectionId);
  }

  /** A client for the replica set primary, whether the saved connection points at it or not. */
  async primaryClient(connectionId: string): Promise<MongoClient> {
    const connection = await this.connection(connectionId);
    const hello = await connection.client.db('admin').command({ hello: 1 });
    if (hello.isWritablePrimary || hello.msg === 'isdbgrid') {
      return connection.client;
    }
    if (!hello.primary) {
      throw new Error('The replica set has no primary right now.');
    }
    return this.nodes.direct(connectionId, String(hello.primary));
  }

  /** A client connected to a single member. Uses the main client when it already is that member. */
  async memberClient(connectionId: string, host: string): Promise<MongoClient> {
    const connection = await this.connection(connectionId);
    const hello = await connection.client.db('admin').command({ hello: 1 });
    const directOption = /[?&]directConnection=true/i.test(connection.options.connectionString);
    if (directOption && typeof hello.me === 'string' && sameHost(hello.me, host)) {
      return connection.client;
    }
    return this.nodes.direct(connectionId, host);
  }

  /** The replica set a host belongs to: the main one, a shard or the config servers. */
  private async replicaSetClientFor(connectionId: string, host: string): Promise<MongoClient> {
    const connection = await this.connection(connectionId);
    const hello = await connection.client.db('admin').command({ hello: 1 });
    if (hello.msg !== 'isdbgrid') {
      return this.primaryClient(connectionId);
    }
    // Sharded: find the shard (or config server replica set) the host is in and talk to its primary.
    const member = await this.nodes.direct(connectionId, host);
    const memberHello = await member.db('admin').command({ hello: 1 });
    if (memberHello.isWritablePrimary) {
      return member;
    }
    if (!memberHello.primary) {
      throw new Error(`The replica set of ${host} has no primary right now.`);
    }
    return this.nodes.direct(connectionId, String(memberHello.primary));
  }

  // ───────────────────────────── replica set ─────────────────────────────

  async replicaSetFor(connectionId: string, host?: string): Promise<{ client: MongoClient; info: ReplicaSetInfo }> {
    const client = host ? await this.replicaSetClientFor(connectionId, host) : await this.primaryClient(connectionId);
    return { client, info: await this.readReplicaSet(client) };
  }

  /**
   * Work out the config `mutate` produces and check it, without applying it.
   * `host` selects the replica set (needed for shards and config servers).
   */
  async planReconfig(
    connectionId: string,
    mutate: (config: Document) => Document,
    host?: string
  ): Promise<ReconfigPlan> {
    const { client, info } = await this.replicaSetFor(connectionId, host);
    const { config } = await client.db('admin').command({ replSetGetConfig: 1 });
    const current = config as Document;
    const next = mutate(cloneBson(current));
    next.version = Number(current.version) + 1;
    const report = mergeReports(validateReplicaSetConfig(next), checkMajorityAfter(next, info.members));
    if (votingChanges(current, next) > 1) {
      report.errors.push('Add, remove or change the vote of one voting member at a time (safe reconfig).');
    }
    return { current, next, report };
  }

  async applyReconfig(connectionId: string, next: Document, options: { force?: boolean; host?: string } = {}): Promise<void> {
    const client = options.host
      ? await this.replicaSetClientFor(connectionId, options.host)
      : await this.primaryClient(connectionId);
    logger.info('replSetReconfig', { connectionId, version: next.version, force: Boolean(options.force) });
    await client.db('admin').command({ replSetReconfig: next, force: Boolean(options.force), maxTimeMS: 60_000 });
  }

  /** Config transform that adds a member, picking the next free `_id`. */
  static addMemberTransform(member: NewMemberOptions): (config: Document) => Document {
    return (config) => {
      const members = (config.members ?? []) as Document[];
      if (members.some((m) => sameHost(String(m.host), member.host))) {
        throw new Error(`${member.host} is already a member.`);
      }
      const id = members.reduce((max, m) => Math.max(max, Number(m._id)), -1) + 1;
      const entry: Document = { _id: id, host: member.host };
      if (member.arbiterOnly) {
        entry.arbiterOnly = true;
        entry.priority = 0;
      } else {
        const zeroPriority = member.hidden || (member.secondaryDelaySecs ?? 0) > 0 || member.votes === 0;
        entry.priority = zeroPriority ? 0 : member.priority ?? 1;
        entry.votes = member.votes ?? 1;
        if (member.hidden) {
          entry.hidden = true;
        }
        if (member.secondaryDelaySecs) {
          entry.secondaryDelaySecs = member.secondaryDelaySecs;
        }
        if (member.buildIndexes === false) {
          entry.buildIndexes = false;
        }
      }
      if (member.tags && Object.keys(member.tags).length) {
        entry.tags = member.tags;
      }
      members.push(entry);
      config.members = members;
      return config;
    };
  }

  static removeMemberTransform(host: string): (config: Document) => Document {
    return (config) => {
      const members = (config.members ?? []) as Document[];
      const next = members.filter((m) => !sameHost(String(m.host), host));
      if (next.length === members.length) {
        throw new Error(`${host} is not a member.`);
      }
      config.members = next;
      return config;
    };
  }

  static updateMemberTransform(host: string, changes: MemberChanges): (config: Document) => Document {
    return (config) => {
      const member = ((config.members ?? []) as Document[]).find((m) => sameHost(String(m.host), host));
      if (!member) {
        throw new Error(`${host} is not a member.`);
      }
      if (changes.priority !== undefined) {
        member.priority = changes.priority;
      }
      if (changes.votes !== undefined) {
        member.votes = changes.votes;
        if (changes.votes === 0) {
          member.priority = 0;
        }
      }
      if (changes.hidden !== undefined) {
        member.hidden = changes.hidden;
        if (changes.hidden) {
          member.priority = 0;
        }
      }
      if (changes.secondaryDelaySecs !== undefined) {
        member.secondaryDelaySecs = changes.secondaryDelaySecs;
        delete member.slaveDelay;
        if (changes.secondaryDelaySecs > 0) {
          member.priority = 0;
        }
      }
      if (changes.tags !== undefined) {
        member.tags = changes.tags;
      }
      return config;
    };
  }

  /** Initiate a replica set on a fresh member (used when bootstrapping deployments). */
  static async initiate(client: MongoClient, setName: string, hosts: string[], options: { configsvr?: boolean; arbiterHosts?: string[] } = {}): Promise<void> {
    const members: Document[] = hosts.map((host, i) => ({ _id: i, host, priority: i === 0 ? 2 : 1 }));
    for (const host of options.arbiterHosts ?? []) {
      members.push({ _id: members.length, host, arbiterOnly: true });
    }
    const config: Document = { _id: setName, members };
    if (options.configsvr) {
      config.configsvr = true;
    }
    await client.db('admin').command({ replSetInitiate: config });
  }

  async stepDown(connectionId: string, options: { host?: string; stepDownSecs?: number; catchUpSecs?: number } = {}): Promise<void> {
    const client = options.host
      ? await this.replicaSetClientFor(connectionId, options.host)
      : await this.primaryClient(connectionId);
    await client.db('admin').command({
      replSetStepDown: options.stepDownSecs ?? 60,
      secondaryCatchUpPeriodSecs: options.catchUpSecs ?? 10
    });
  }

  async freeze(connectionId: string, host: string, seconds: number): Promise<void> {
    const client = await this.memberClient(connectionId, host);
    await client.db('admin').command({ replSetFreeze: seconds });
  }

  async setMaintenance(connectionId: string, host: string, enabled: boolean): Promise<void> {
    const client = await this.memberClient(connectionId, host);
    await client.db('admin').command({ replSetMaintenance: enabled });
  }

  async syncFrom(connectionId: string, host: string, source: string): Promise<Document> {
    const client = await this.memberClient(connectionId, host);
    return client.db('admin').command({ replSetSyncFrom: source });
  }

  /**
   * Make `host` the primary.
   *
   * Prefers freezing every other electable member and stepping the primary
   * down, which leaves the config untouched. When the other members cannot be
   * reached directly it raises the target's priority instead (a priority
   * takeover), and puts the original priorities back once it has won when
   * that cannot move the primary away again.
   */
  async makePrimary(connectionId: string, host: string, report: (message: string) => void = () => undefined): Promise<string> {
    const { info } = await this.replicaSetFor(connectionId, host);
    const target = info.members.find((m) => sameHost(m.host, host));
    if (!target) {
      throw new Error(`${host} is not a member of ${info.name}.`);
    }
    if (target.state === 'PRIMARY') {
      return `${host} already is the primary.`;
    }
    if (target.state !== 'SECONDARY' || target.health !== 1) {
      throw new Error(`${host} is ${target.state}; only a healthy secondary can become primary.`);
    }
    if (target.arbiterOnly || target.hidden || target.votes === 0 || target.priority === 0 || target.secondaryDelaySecs > 0) {
      throw new Error(`${host} can not become primary (priority 0, hidden, delayed, non-voting or arbiter). Change its settings first.`);
    }
    const others = info.members.filter(
      (m) => !sameHost(m.host, host) && m.state === 'SECONDARY' && m.priority > 0 && !m.arbiterOnly
    );

    let frozen: string[] = [];
    try {
      report('Freezing the other secondaries…');
      for (const member of others) {
        await this.freeze(connectionId, member.host, 120);
        frozen.push(member.host);
      }
    } catch (err) {
      logger.warn('Freeze-based election not possible, using priority takeover', { error: (err as Error).message });
      await this.unfreezeAll(connectionId, frozen);
      frozen = [];
      return this.makePrimaryByPriority(connectionId, host, info, report);
    }

    try {
      report(`Stepping down ${info.primary ?? 'the primary'}…`);
      await this.stepDown(connectionId, { host, stepDownSecs: 60, catchUpSecs: 30 }).catch((err: Error) => {
        // The primary closes connections while stepping down.
        if (!/connection|closed|not primary|interrupted/i.test(err.message)) {
          throw err;
        }
      });
      report(`Waiting for ${host} to win the election…`);
      await this.waitForPrimary(connectionId, host, 90_000);
      return `${host} is now the primary of ${info.name}.`;
    } finally {
      await this.unfreezeAll(connectionId, frozen);
    }
  }

  private async unfreezeAll(connectionId: string, hosts: string[]): Promise<void> {
    await Promise.all(hosts.map((h) => this.freeze(connectionId, h, 0).catch(() => undefined)));
  }

  private async makePrimaryByPriority(
    connectionId: string,
    host: string,
    info: ReplicaSetInfo,
    report: (message: string) => void
  ): Promise<string> {
    const target = info.members.find((m) => sameHost(m.host, host)) as ReplicaMember;
    const highest = Math.max(...info.members.filter((m) => !sameHost(m.host, host)).map((m) => m.priority));
    const priorities = new Map(info.members.map((m) => [m.host.toLowerCase(), m.priority]));
    report(`Raising the priority of ${host} to ${highest + 1}…`);
    const plan = await this.planReconfig(
      connectionId,
      ClusterService.updateMemberTransform(host, { priority: Math.min(1000, highest + 1) }),
      host
    );
    if (plan.report.errors.length) {
      throw new Error(plan.report.errors.join(' '));
    }
    await this.applyReconfig(connectionId, plan.next, { host });
    report(`Waiting for ${host} to take over…`);
    await this.waitForPrimary(connectionId, host, 120_000);

    if (target.priority >= highest) {
      const restore = await this.planReconfig(
        connectionId,
        (config) => {
          for (const member of (config.members ?? []) as Document[]) {
            const original = priorities.get(String(member.host).toLowerCase());
            if (original !== undefined) {
              member.priority = original;
            }
          }
          return config;
        },
        host
      );
      await this.applyReconfig(connectionId, restore.next, { host });
      return `${host} is now the primary of ${info.name}; the original priorities were restored.`;
    }
    return `${host} is now the primary of ${info.name}. Its priority stays at ${highest + 1} so the previous primary does not take over again.`;
  }

  /** Poll until `host` (or, without a host, any member) is primary. */
  async waitForPrimary(connectionId: string, host: string | undefined, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        const { info } = await this.replicaSetFor(connectionId, host);
        if (info.primary && (!host || sameHost(info.primary, host))) {
          return info.primary;
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
      await sleep(2000);
    }
    throw new Error(`Timed out waiting for ${host ?? 'a primary'}${lastError ? ` (${lastError})` : ''}.`);
  }

  /** Poll until a member reports one of `states`, is healthy and (for secondaries) has caught up. */
  async waitForMember(connectionId: string, host: string, states: string[], timeoutMs: number, maxLagSeconds = 10): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = 'unknown';
    while (Date.now() < deadline) {
      try {
        const { info } = await this.replicaSetFor(connectionId, host);
        const member = info.members.find((m) => sameHost(m.host, host));
        last = member ? `${member.state}${member.lagSeconds ? `, ${member.lagSeconds}s behind` : ''}` : 'not in config';
        if (
          member &&
          member.health === 1 &&
          states.includes(member.state) &&
          (member.lagSeconds === null || member.lagSeconds <= maxLagSeconds)
        ) {
          return;
        }
      } catch (err) {
        last = (err as Error).message;
      }
      await sleep(2000);
    }
    throw new Error(`Timed out waiting for ${host} to become ${states.join('/')} (last: ${last}).`);
  }

  // ───────────────────────────── per node ─────────────────────────────

  async nodeServerStatus(connectionId: string, host: string): Promise<Document> {
    const client = await this.memberClient(connectionId, host);
    return client.db('admin').command({ serverStatus: 1 });
  }

  /** Recent log lines of a node (`getLog: "global"`), newest last. */
  async nodeLog(connectionId: string, host?: string): Promise<string[]> {
    const client = host ? await this.memberClient(connectionId, host) : (await this.connection(connectionId)).client;
    const result = await client.db('admin').command({ getLog: 'global' });
    return ((result.log ?? []) as unknown[]).map(String);
  }

  // ───────────────────────────── sharding ─────────────────────────────

  private async mongos(connectionId: string): Promise<MongoClient> {
    const connection = await this.connection(connectionId);
    const hello = await connection.client.db('admin').command({ hello: 1 });
    if (hello.msg !== 'isdbgrid') {
      throw new Error('This command needs a connection to a mongos router of a sharded cluster.');
    }
    return connection.client;
  }

  private async adminCommand(connectionId: string, command: Document): Promise<Document> {
    const client = await this.mongos(connectionId);
    logger.info('Cluster command', { connectionId, command: Object.keys(command)[0] });
    return client.db('admin').command(command);
  }

  enableSharding(connectionId: string, database: string, primaryShard?: string): Promise<Document> {
    return this.adminCommand(connectionId, primaryShard ? { enableSharding: database, primaryShard } : { enableSharding: database });
  }

  shardCollection(
    connectionId: string,
    namespace: string,
    key: Document,
    options: { unique?: boolean; numInitialChunks?: number; presplitHashedZones?: boolean } = {}
  ): Promise<Document> {
    const command: Document = { shardCollection: namespace, key };
    if (options.unique) {
      command.unique = true;
    }
    if (options.numInitialChunks) {
      command.numInitialChunks = options.numInitialChunks;
    }
    if (options.presplitHashedZones) {
      command.presplitHashedZones = true;
    }
    return this.adminCommand(connectionId, command);
  }

  reshardCollection(connectionId: string, namespace: string, key: Document, options: { forceRedistribution?: boolean; numInitialChunks?: number } = {}): Promise<Document> {
    const command: Document = { reshardCollection: namespace, key };
    if (options.forceRedistribution) {
      command.forceRedistribution = true;
    }
    if (options.numInitialChunks) {
      command.numInitialChunks = options.numInitialChunks;
    }
    return this.adminCommand(connectionId, command);
  }

  refineShardKey(connectionId: string, namespace: string, key: Document): Promise<Document> {
    return this.adminCommand(connectionId, { refineCollectionShardKey: namespace, key });
  }

  unshardCollection(connectionId: string, namespace: string, toShard?: string): Promise<Document> {
    return this.adminCommand(connectionId, toShard ? { unshardCollection: namespace, toShard } : { unshardCollection: namespace });
  }

  moveCollection(connectionId: string, namespace: string, toShard: string): Promise<Document> {
    return this.adminCommand(connectionId, { moveCollection: namespace, toShard });
  }

  /** `analyzeShardKey` (7.0+) — works on replica sets and sharded clusters alike. */
  async analyzeShardKey(connectionId: string, namespace: string, key: Document): Promise<Document> {
    const connection = await this.connection(connectionId);
    return connection.client.db('admin').command({
      analyzeShardKey: namespace,
      key,
      keyCharacteristics: true,
      readWriteDistribution: false
    });
  }

  addShard(connectionId: string, connectionString: string, name?: string): Promise<Document> {
    return this.adminCommand(connectionId, name ? { addShard: connectionString, name } : { addShard: connectionString });
  }

  /** Start or continue draining a shard. Run it again to follow progress. */
  removeShard(connectionId: string, shard: string): Promise<Document> {
    return this.adminCommand(connectionId, { removeShard: shard });
  }

  movePrimary(connectionId: string, database: string, toShard: string): Promise<Document> {
    return this.adminCommand(connectionId, { movePrimary: database, to: toShard });
  }

  setBalancerRunning(connectionId: string, running: boolean): Promise<Document> {
    return this.adminCommand(connectionId, running ? { balancerStart: 1 } : { balancerStop: 1 });
  }

  async setBalancerWindow(connectionId: string, window: { start: string; stop: string } | null): Promise<void> {
    const client = await this.mongos(connectionId);
    const settings = client.db('config').collection('settings');
    if (window) {
      await settings.updateOne({ _id: 'balancer' as never }, { $set: { activeWindow: window } }, { upsert: true });
    } else {
      await settings.updateOne({ _id: 'balancer' as never }, { $unset: { activeWindow: '' } });
    }
  }

  async setCollectionBalancing(connectionId: string, namespace: string, enabled: boolean): Promise<void> {
    const client = await this.mongos(connectionId);
    const result = await client
      .db('config')
      .collection('collections')
      .updateOne({ _id: namespace as never }, enabled ? { $unset: { noBalance: '' } } : { $set: { noBalance: true } });
    if (result.matchedCount === 0) {
      throw new Error(`${namespace} is not sharded.`);
    }
  }

  addShardToZone(connectionId: string, shard: string, zone: string): Promise<Document> {
    return this.adminCommand(connectionId, { addShardToZone: shard, zone });
  }

  removeShardFromZone(connectionId: string, shard: string, zone: string): Promise<Document> {
    return this.adminCommand(connectionId, { removeShardFromZone: shard, zone });
  }

  /** Assign a key range to a zone, or remove the range when `zone` is null. */
  updateZoneKeyRange(connectionId: string, namespace: string, min: Document, max: Document, zone: string | null): Promise<Document> {
    return this.adminCommand(connectionId, { updateZoneKeyRange: namespace, min, max, zone });
  }

  async moveRange(connectionId: string, namespace: string, min: Document, toShard: string): Promise<Document> {
    try {
      return await this.adminCommand(connectionId, { moveRange: namespace, min, toShard });
    } catch (err) {
      // moveRange is 6.0+; older servers only know moveChunk.
      if (/no such (command|cmd)|CommandNotFound/i.test((err as Error).message)) {
        return this.adminCommand(connectionId, { moveChunk: namespace, find: min, to: toShard });
      }
      throw err;
    }
  }

  splitAt(connectionId: string, namespace: string, middle: Document): Promise<Document> {
    return this.adminCommand(connectionId, { split: namespace, middle });
  }

  // ───────────────────────────── settings ─────────────────────────────

  async setFeatureCompatibilityVersion(connectionId: string, version: string): Promise<Document> {
    const client = await this.primaryClient(connectionId);
    const command: Document = { setFeatureCompatibilityVersion: version };
    const connection = await this.connection(connectionId);
    if (compareVersions(connection.topology?.serverVersion ?? '0', '7.0') >= 0) {
      command.confirm = true;
    }
    return client.db('admin').command(command);
  }

  async setDefaultWriteConcern(connectionId: string, writeConcern: Document): Promise<Document> {
    const client = await this.primaryClient(connectionId);
    return client.db('admin').command({ setDefaultRWConcern: 1, defaultWriteConcern: writeConcern });
  }

  // ───────────────────────────── users & roles ─────────────────────────────

  async listUsers(connectionId: string): Promise<DatabaseUser[]> {
    const connection = await this.connection(connectionId);
    const result = await connection.client.db('admin').command({ usersInfo: { forAllDBs: true } });
    return ((result.users ?? []) as Document[]).map((u) => ({
      user: String(u.user),
      db: String(u.db),
      roles: ((u.roles ?? []) as Document[]).map((r) => ({ role: String(r.role), db: String(r.db) })),
      mechanisms: u.mechanisms as string[] | undefined
    }));
  }

  async listRoles(connectionId: string, database: string): Promise<string[]> {
    const connection = await this.connection(connectionId);
    const result = await connection.client.db(database).command({ rolesInfo: 1, showBuiltinRoles: true });
    return ((result.roles ?? []) as Document[]).map((r) => String(r.role)).sort();
  }

  async createUser(connectionId: string, database: string, user: string, password: string, roles: Array<{ role: string; db: string }>): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ createUser: user, pwd: password, roles });
  }

  async dropUser(connectionId: string, database: string, user: string): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ dropUser: user });
  }

  async changePassword(connectionId: string, database: string, user: string, password: string): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ updateUser: user, pwd: password });
  }

  async grantRoles(connectionId: string, database: string, user: string, roles: Array<{ role: string; db: string }>): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ grantRolesToUser: user, roles });
  }

  async revokeRoles(connectionId: string, database: string, user: string, roles: Array<{ role: string; db: string }>): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ revokeRolesFromUser: user, roles });
  }

  // ───────────────────────────── profiler ─────────────────────────────

  async getProfilingLevel(connectionId: string, database: string): Promise<{ level: number; slowms: number }> {
    const connection = await this.connection(connectionId);
    const result = await connection.client.db(database).command({ profile: -1 });
    return { level: Number(result.was ?? 0), slowms: Number(result.slowms ?? 100) };
  }

  async setProfilingLevel(connectionId: string, database: string, level: number, slowms: number): Promise<void> {
    const connection = await this.connection(connectionId);
    await connection.client.db(database).command({ profile: level, slowms });
  }
}

function replicaSetWarnings(rs: ReplicaSetInfo): string[] {
  const warnings: string[] = [];
  if (!rs.primary) {
    warnings.push(`${rs.name} has no primary.`);
  }
  for (const member of rs.members) {
    if (member.health !== 1) {
      warnings.push(`${member.host} is unreachable${member.lastHeartbeatMessage ? `: ${member.lastHeartbeatMessage}` : ''}.`);
    } else if (!['PRIMARY', 'SECONDARY', 'ARBITER'].includes(member.state)) {
      warnings.push(`${member.host} is ${member.state}.`);
    }
    if (member.lagSeconds !== null && member.secondaryDelaySecs === 0 && member.lagSeconds > 30) {
      warnings.push(`${member.host} is ${member.lagSeconds}s behind the primary.`);
    }
  }
  // A short window only matters once the oplog is full; a young deployment simply has little history.
  const oplogFull = rs.oplog && rs.oplog.maxSizeMB > 0 && rs.oplog.usedMB / rs.oplog.maxSizeMB > 0.9;
  if (oplogFull && rs.oplog?.windowHours !== null && rs.oplog?.windowHours !== undefined && rs.oplog.windowHours < 24) {
    warnings.push(`${rs.name}: the oplog only covers ${rs.oplog.windowHours}h; a member that is down longer needs a full resync.`);
  }
  return warnings;
}
