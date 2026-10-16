import type * as vscode from 'vscode';

export type ProviderId = 'docker' | 'local' | 'kubernetes' | 'atlas';
export type TopologyKind = 'standalone' | 'replicaSet' | 'sharded';
export type KubernetesFlavor = 'percona' | 'community' | 'statefulset';
export type AtlasTier = 'free' | 'flex' | 'dedicated';

export interface DockerSpec {
  image: string;
  /** First host port of the range reserved for this deployment. */
  basePort: number;
  /** Number of ports reserved (published) for the deployment's nodes. */
  portRange: number;
  /** `docker run --memory` value per node, e.g. `1g`. */
  memory?: string;
}

export interface LocalSpec {
  /** Folder with `mongod` / `mongos`; PATH when empty. */
  binDir?: string;
  basePort: number;
}

export interface KubernetesSpec {
  context: string;
  namespace: string;
  flavor: KubernetesFlavor;
  /** Resource name of the CR / StatefulSet. */
  resourceName: string;
  storageSize: string;
  storageClass?: string;
  /** Container image (Percona and StatefulSet flavours). */
  image?: string;
  /** Attached rather than created by the extension: never deleted without typing its name. */
  imported?: boolean;
  /** For attached StatefulSets: pod label selector, governing service and replica set name. */
  selector?: string;
  serviceName?: string;
  replicaSetName?: string;
}

export interface AtlasSpec {
  projectId: string;
  projectName?: string;
  clusterName: string;
  tier: AtlasTier;
  /** Instance size for dedicated clusters, e.g. `M10`. */
  instanceSize?: string;
  cloudProvider: 'AWS' | 'GCP' | 'AZURE';
  region: string;
  imported?: boolean;
}

/** What the user asked for. */
export interface DeploymentSpec {
  name: string;
  provider: ProviderId;
  topology: TopologyKind;
  /** MongoDB version (major.minor or exact, depending on the provider). */
  version: string;
  /** Data-bearing members per replica set. */
  members: number;
  /** Add an arbiter to each replica set. */
  arbiter: boolean;
  shards: number;
  configServers: number;
  routers: number;
  auth: boolean;
  username: string;
  docker?: DockerSpec;
  local?: LocalSpec;
  kubernetes?: KubernetesSpec;
  atlas?: AtlasSpec;
}

export type NodeRole = 'mongod' | 'arbiter' | 'configsvr' | 'mongos' | 'network';

/** A node the extension created, as persisted for Docker and local deployments. */
export interface NodeLayout {
  id: string;
  role: NodeRole;
  /** Replica set name (shard name for shard members). */
  replicaSet?: string;
  port: number;
  hidden?: boolean;
  /** Version this node runs when it differs from the spec (Docker rolling upgrades). */
  version?: string;
  /** Folder of the binaries this node runs from when it differs from the spec (local rolling upgrades). */
  binDir?: string;
}

export interface DeploymentRecord {
  id: string;
  spec: DeploymentSpec;
  createdAt: number;
  /** Saved connection created for this deployment. */
  connectionId?: string;
  /** Node layout for providers that manage nodes one by one (Docker, local). */
  nodes?: NodeLayout[];
  /** Set while the deployment is being created, or when creation failed. */
  provisioning?: { state: 'creating' | 'failed'; message?: string };
}

export type NodeStatus = 'running' | 'stopped' | 'paused' | 'starting' | 'error' | 'unknown' | 'pending' | 'terminating';

export interface DeploymentNode {
  id: string;
  name: string;
  role: NodeRole | 'pod' | 'host';
  replicaSet?: string;
  /** Address of the node as the cluster knows it (`host:port`). */
  address?: string;
  status: NodeStatus;
  detail?: string;
  /** Replica set state (PRIMARY / SECONDARY / …) when known. */
  memberState?: string;
}

export type DeploymentState = 'running' | 'degraded' | 'stopped' | 'paused' | 'creating' | 'updating' | 'deleting' | 'error' | 'unknown';

export interface DeploymentStatus {
  state: DeploymentState;
  nodes: DeploymentNode[];
  message?: string;
}

export type MemberKind = 'secondary' | 'arbiter' | 'hidden';

/** Services a provider can use while it works. */
export interface ProviderContext {
  progress(message: string): void;
  /** Password of the deployment's admin user. */
  password(record: DeploymentRecord): Promise<string | undefined>;
  /** Persist changes to the record (e.g. its node layout). */
  save(record: DeploymentRecord): Promise<void>;
  /** Per-deployment folder for data files, keyfiles and logs. */
  storageDir(record: DeploymentRecord): vscode.Uri;
  token: vscode.CancellationToken;
}

export interface ExportedDefinition {
  language: string;
  content: string;
}

/**
 * One way of running MongoDB. Optional members are the operations the
 * provider supports; the UI hides what a provider does not implement.
 */
export interface DeploymentProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly topologies: TopologyKind[];

  /** An error message when the provider cannot be used (missing CLI, not signed in, …). */
  checkAvailable(): Promise<string | undefined>;
  create(record: DeploymentRecord, ctx: ProviderContext): Promise<void>;
  status(record: DeploymentRecord): Promise<DeploymentStatus>;
  /** Connection string the extension should save for this deployment. */
  connectionString(record: DeploymentRecord, password: string | undefined): Promise<string>;
  destroy(record: DeploymentRecord, ctx: ProviderContext, options: { keepData: boolean }): Promise<void>;

  start?(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void>;
  stop?(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void>;
  restartNode?(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void>;
  /** Simulate a failure: kill a node, freeze it, or bring a frozen node back. */
  chaos?(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, action: 'kill' | 'pause' | 'unpause'): Promise<void>;

  addMember?(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, kind: MemberKind): Promise<string>;
  removeMember?(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void>;
  /** Change the number of data-bearing members of a replica set in one step (operators). */
  scaleReplicaSet?(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, members: number): Promise<void>;
  addShard?(record: DeploymentRecord, ctx: ProviderContext): Promise<string>;
  removeShard?(record: DeploymentRecord, ctx: ProviderContext, shard: string): Promise<void>;
  addRouter?(record: DeploymentRecord, ctx: ProviderContext): Promise<string>;
  removeRouter?(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void>;

  /** Change the MongoDB version: per node (rolling, driven by the caller) or all at once (operators, Atlas). */
  upgradeNode?(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, version: string): Promise<void>;
  upgradeAll?(record: DeploymentRecord, ctx: ProviderContext, version: string): Promise<void>;
  /** Fail over the primaries where the platform does it (Atlas "test failover"). */
  failover?(record: DeploymentRecord, ctx: ProviderContext): Promise<void>;

  openLogs?(record: DeploymentRecord, nodeId: string): Promise<void>;
  openShell?(record: DeploymentRecord, nodeId: string): Promise<void>;
  describeNode?(record: DeploymentRecord, nodeId: string): Promise<string>;
  exportDefinition?(record: DeploymentRecord, password: string | undefined): Promise<ExportedDefinition>;
  /** Called before the deployment's connection is opened (e.g. to start port-forwards). */
  prepareConnection?(record: DeploymentRecord): Promise<void>;
  /** Map a member host to a reachable address (see `NodeClientPool.registerResolver`). */
  resolveHost?(record: DeploymentRecord, host: string): Promise<string | undefined>;
  /** Credentials for direct access to a member that does not know the deployment's admin user. */
  credentialsFor?(record: DeploymentRecord, host: string): Promise<{ username: string; password: string } | undefined>;
}
