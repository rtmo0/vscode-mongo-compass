import type { Document } from 'mongodb';

/** `stateStr` values reported by `replSetGetStatus`. */
export type MemberState =
  | 'PRIMARY'
  | 'SECONDARY'
  | 'ARBITER'
  | 'STARTUP'
  | 'STARTUP2'
  | 'RECOVERING'
  | 'ROLLBACK'
  | 'DOWN'
  | 'UNKNOWN'
  | 'REMOVED'
  | (string & {});

/** A replica set member: its live status merged with its entry in the replica set config. */
export interface ReplicaMember {
  id: number;
  host: string;
  state: MemberState;
  health: number;
  self: boolean;
  uptime?: number;
  optimeDate?: string;
  /** Seconds behind the primary; `null` when it cannot be computed. */
  lagSeconds: number | null;
  pingMs?: number;
  syncSourceHost?: string;
  electionDate?: string;
  lastHeartbeatMessage?: string;
  priority: number;
  votes: number;
  hidden: boolean;
  arbiterOnly: boolean;
  secondaryDelaySecs: number;
  buildIndexes: boolean;
  tags: Record<string, string>;
}

export interface OplogInfo {
  maxSizeMB: number;
  usedMB: number;
  /** Time between the first and last oplog entries. */
  windowHours: number | null;
  first?: string;
  last?: string;
}

export interface ReplicaSetInfo {
  name: string;
  term?: number;
  configVersion?: number;
  configTerm?: number;
  primary?: string;
  members: ReplicaMember[];
  heartbeatIntervalMillis?: number;
  electionTimeoutMillis?: number;
  writeConcernMajorityJournalDefault?: boolean;
  configsvr: boolean;
  oplog?: OplogInfo;
  /** Set when the replica set could not be read (e.g. a shard that is not reachable directly). */
  error?: string;
}

export interface ShardInfo {
  id: string;
  /** `rsName/host1:port,host2:port`. */
  host: string;
  replicaSetName?: string;
  hosts: string[];
  state?: number;
  draining: boolean;
  zones: string[];
  replicaSet?: ReplicaSetInfo;
}

export interface RouterInfo {
  host: string;
  ping?: string;
  upSeconds?: number;
  version?: string;
  /** True when the router has not pinged the config servers for a while. */
  stale: boolean;
}

export interface BalancerInfo {
  mode: string;
  running: boolean;
  inBalancerRound: boolean;
  numBalancerRounds?: number;
  window?: { start: string; stop: string };
  error?: string;
}

export interface ShardedCollectionInfo {
  namespace: string;
  key: Document;
  unique: boolean;
  balancingEnabled: boolean;
  chunksByShard: Record<string, number>;
  totalChunks: number;
  /** From `$shardedDataDistribution` (6.0.3+). */
  dataByShard?: Array<{ shard: string; documents: number; sizeBytes: number; orphanedDocuments: number }>;
}

export interface ZoneRange {
  namespace: string;
  zone: string;
  min: Document;
  max: Document;
}

export interface ShardedDatabaseInfo {
  name: string;
  primary: string;
}

export interface ShardingInfo {
  shards: ShardInfo[];
  routers: RouterInfo[];
  configServers?: ReplicaSetInfo & { hosts: string[] };
  balancer: BalancerInfo;
  databases: ShardedDatabaseInfo[];
  collections: ShardedCollectionInfo[];
  zones: ZoneRange[];
}

export type ClusterKind = 'standalone' | 'replicaSet' | 'sharded';

export interface ClusterOverview {
  kind: ClusterKind;
  connectionId: string;
  connectionName: string;
  serverVersion: string;
  featureCompatibilityVersion?: string;
  defaultWriteConcern?: Document;
  isAtlas: boolean;
  fetchedAt: number;
  /** The server the extension is talking to. */
  host?: string;
  replicaSet?: ReplicaSetInfo;
  sharding?: ShardingInfo;
  warnings: string[];
}

/** Options for a new replica set member. */
export interface NewMemberOptions {
  host: string;
  arbiterOnly?: boolean;
  priority?: number;
  votes?: number;
  hidden?: boolean;
  secondaryDelaySecs?: number;
  buildIndexes?: boolean;
  tags?: Record<string, string>;
}

/** Fields of an existing member that can be changed through a reconfig. */
export type MemberChanges = Partial<Pick<ReplicaMember, 'priority' | 'votes' | 'hidden' | 'secondaryDelaySecs' | 'tags'>>;

export interface SafetyReport {
  errors: string[];
  warnings: string[];
}

export interface DatabaseUser {
  user: string;
  db: string;
  roles: Array<{ role: string; db: string }>;
  mechanisms?: string[];
}
