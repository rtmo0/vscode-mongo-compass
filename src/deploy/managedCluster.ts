import type { Document } from 'mongodb';
import { ClusterService, cloneBson } from '../core/cluster/clusterService';
import { validateReplicaSetConfig } from '../core/cluster/safety';
import { retry, sleep } from './process';
import type { DeploymentRecord, DeploymentSpec, MemberKind, NodeLayout, ProviderContext } from './types';

/**
 * Runs admin commands on one node of a deployment whose nodes all listen on
 * `localhost:<port>` (Docker containers sharing one network namespace, or
 * local processes). `auth: false` relies on the localhost exception, which
 * is how the first user is created.
 */
export interface NodeAdmin {
  command(record: DeploymentRecord, node: NodeLayout, command: Document, options: { auth: boolean; password?: string; db?: string; timeoutMs?: number }): Promise<Document>;
}

/** Starts and removes the processes or containers behind nodes. */
export interface NodeRuntime {
  startNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext): Promise<void>;
  removeNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext, keepData: boolean): Promise<void>;
  /**
   * Pick a port for a new node, or throw when none is left. `pending` holds
   * ports already picked in the same operation but not yet in `record.nodes`.
   */
  allocatePort(record: DeploymentRecord, pending: Set<number>): Promise<number>;
}

export const CONFIG_RS = 'cfg';

export function hostOf(node: NodeLayout): string {
  return `localhost:${node.port}`;
}

/** Node layout for a new deployment; ports are assigned in order from `basePort`. */
export function planNodes(spec: DeploymentSpec, basePort: number): NodeLayout[] {
  const nodes: NodeLayout[] = [];
  let port = basePort;
  const replicaSet = (name: string, role: NodeLayout['role'], members: number, arbiter: boolean): void => {
    for (let i = 0; i < members; i += 1) {
      nodes.push({ id: `${name}-${i}`, role, replicaSet: name, port: port++ });
    }
    if (arbiter) {
      nodes.push({ id: `${name}-arbiter`, role: 'arbiter', replicaSet: name, port: port++ });
    }
  };
  switch (spec.topology) {
    case 'standalone':
      nodes.push({ id: 'mongod-0', role: 'mongod', port: port++ });
      break;
    case 'replicaSet':
      replicaSet('rs0', 'mongod', spec.members, spec.arbiter);
      break;
    case 'sharded':
      replicaSet(CONFIG_RS, 'configsvr', spec.configServers, false);
      for (let s = 0; s < spec.shards; s += 1) {
        replicaSet(`shard${s}`, 'mongod', spec.members, spec.arbiter);
      }
      for (let r = 0; r < spec.routers; r += 1) {
        nodes.push({ id: `mongos-${r}`, role: 'mongos', port: port++ });
      }
      break;
  }
  return nodes;
}

/** Ports a layout needs for a fresh deployment. */
export function portsNeeded(spec: DeploymentSpec): number {
  return planNodes(spec, 0).length;
}

/** Hosts of a replica set's members, data-bearing first. */
function membersOf(record: DeploymentRecord, replicaSet: string): NodeLayout[] {
  return (record.nodes ?? []).filter((n) => n.replicaSet === replicaSet);
}

export function replicaSetNames(record: DeploymentRecord): string[] {
  return [...new Set((record.nodes ?? []).map((n) => n.replicaSet).filter((n): n is string => Boolean(n)))];
}

export function shardNames(record: DeploymentRecord): string[] {
  return replicaSetNames(record).filter((n) => n !== CONFIG_RS);
}

export function connectionStringForNodes(record: DeploymentRecord, password: string | undefined): string {
  const { spec } = record;
  const nodes = record.nodes ?? [];
  const auth = spec.auth && password ? `${encodeURIComponent(spec.username)}:${encodeURIComponent(password)}@` : '';
  const authQuery = auth ? 'authSource=admin' : '';
  if (spec.topology === 'sharded') {
    const routers = nodes.filter((n) => n.role === 'mongos').map(hostOf);
    return `mongodb://${auth}${routers.join(',')}/${authQuery ? `?${authQuery}` : ''}`;
  }
  if (spec.topology === 'replicaSet') {
    const hosts = nodes.filter((n) => n.role === 'mongod' && !n.hidden).map(hostOf);
    return `mongodb://${auth}${hosts.join(',')}/?${['replicaSet=rs0', authQuery].filter(Boolean).join('&')}`;
  }
  return `mongodb://${auth}${hostOf(nodes[0])}/${authQuery ? `?${authQuery}` : ''}`;
}

/** Shared lifecycle logic for providers whose nodes are reachable on `localhost:<port>`. */
export class ManagedCluster {
  constructor(
    private readonly admin: NodeAdmin,
    private readonly runtime: NodeRuntime
  ) {}

  async waitReady(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext, timeoutMs = 90_000): Promise<void> {
    await retry(() => this.admin.command(record, node, { ping: 1 }, { auth: false, timeoutMs: 10_000 }), timeoutMs, 1500, ctx.token);
  }

  /** Start every node, initiate the replica sets, create the admin user and register the shards. */
  async bootstrap(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const { spec } = record;
    const nodes = record.nodes ?? [];
    const password = spec.auth ? await ctx.password(record) : undefined;

    const startOrder = [...nodes.filter((n) => n.role !== 'mongos'), ...nodes.filter((n) => n.role === 'mongos')];
    for (const node of startOrder.filter((n) => n.role !== 'mongos')) {
      ctx.progress(`Starting ${node.id}…`);
      await this.runtime.startNode(record, node, ctx);
    }
    for (const node of startOrder.filter((n) => n.role !== 'mongos')) {
      ctx.progress(`Waiting for ${node.id}…`);
      await this.waitReady(record, node, ctx);
    }

    for (const name of replicaSetNames(record)) {
      ctx.progress(`Initiating replica set ${name}…`);
      await this.initiate(record, name, ctx);
      if (spec.auth && password && spec.topology === 'sharded' && name !== CONFIG_RS) {
        // Shard-local admin user, so the shards can be inspected directly.
        await this.createAdminUser(record, await this.primaryOf(record, name), password);
      }
    }

    if (spec.topology === 'sharded') {
      for (const node of nodes.filter((n) => n.role === 'mongos')) {
        ctx.progress(`Starting router ${node.id}…`);
        await this.runtime.startNode(record, node, ctx);
        await this.waitReady(record, node, ctx, 120_000);
      }
      const router = nodes.find((n) => n.role === 'mongos') as NodeLayout;
      if (spec.auth && password) {
        ctx.progress('Creating the admin user…');
        await this.createAdminUser(record, router, password);
      }
      for (const shard of shardNames(record)) {
        ctx.progress(`Adding shard ${shard}…`);
        await this.admin.command(record, router, { addShard: this.shardConnectionString(record, shard), name: shard }, { auth: spec.auth, password });
      }
    } else if (spec.auth && password) {
      ctx.progress('Creating the admin user…');
      const target = spec.topology === 'replicaSet' ? await this.primaryOf(record, 'rs0') : nodes[0];
      await this.createAdminUser(record, target, password);
    }
  }

  private async initiate(record: DeploymentRecord, replicaSet: string, ctx: ProviderContext): Promise<void> {
    const members = membersOf(record, replicaSet);
    const data = members.filter((n) => n.role !== 'arbiter');
    const config: Document = {
      _id: replicaSet,
      members: [
        ...data.map((n, i) => ({ _id: i, host: hostOf(n), priority: i === 0 ? 2 : 1 })),
        ...members.filter((n) => n.role === 'arbiter').map((n, i) => ({ _id: data.length + i, host: hostOf(n), arbiterOnly: true }))
      ]
    };
    if (replicaSet === CONFIG_RS) {
      config.configsvr = true;
    }
    await this.admin.command(record, data[0], { replSetInitiate: config }, { auth: false });
    ctx.progress(`Waiting for a primary in ${replicaSet}…`);
    await retry(async () => {
      const hello = await this.admin.command(record, data[0], { hello: 1 }, { auth: false });
      if (!hello.isWritablePrimary) {
        throw new Error(`${replicaSet} has no primary yet`);
      }
    }, 120_000, 1500, ctx.token);
  }

  private async createAdminUser(record: DeploymentRecord, node: NodeLayout, password: string): Promise<void> {
    await this.admin.command(record, 
      node,
      { createUser: record.spec.username, pwd: password, roles: [{ role: 'root', db: 'admin' }] },
      { auth: false }
    );
  }

  shardConnectionString(record: DeploymentRecord, shard: string): string {
    const hosts = membersOf(record, shard).filter((n) => n.role !== 'arbiter').map(hostOf);
    return `${shard}/${hosts.join(',')}`;
  }

  /** The current primary of a replica set, asked from any running member (`hello` needs no auth). */
  async primaryOf(record: DeploymentRecord, replicaSet: string): Promise<NodeLayout> {
    const members = membersOf(record, replicaSet).filter((n) => n.role !== 'arbiter');
    for (const node of members) {
      try {
        const hello = await this.admin.command(record, node, { hello: 1 }, { auth: false, timeoutMs: 10_000 });
        if (hello.isWritablePrimary) {
          return node;
        }
        const primary = members.find((n) => hostOf(n) === hello.primary);
        if (primary) {
          return primary;
        }
      } catch {
        // try the next member
      }
    }
    throw new Error(`Replica set ${replicaSet} has no reachable primary.`);
  }

  private async withPassword(record: DeploymentRecord, ctx: ProviderContext): Promise<string | undefined> {
    return record.spec.auth ? ctx.password(record) : undefined;
  }

  private async reconfig(record: DeploymentRecord, replicaSet: string, ctx: ProviderContext, mutate: (config: Document) => Document): Promise<void> {
    const password = await this.withPassword(record, ctx);
    const auth = record.spec.auth;
    const primary = await this.primaryOf(record, replicaSet);
    const { config } = await this.admin.command(record, primary, { replSetGetConfig: 1 }, { auth, password });
    const next = mutate(cloneBson(config as Document));
    next.version = Number((config as Document).version) + 1;
    const report = validateReplicaSetConfig(next);
    if (report.errors.length) {
      throw new Error(report.errors.join(' '));
    }
    await this.admin.command(record, primary, { replSetReconfig: next }, { auth, password, timeoutMs: 90_000 });
  }

  private nextPort(record: DeploymentRecord): Promise<number> {
    return this.runtime.allocatePort(record, new Set());
  }

  private nextId(record: DeploymentRecord, prefix: string): string {
    const ids = new Set((record.nodes ?? []).map((n) => n.id));
    for (let i = 0; ; i += 1) {
      if (!ids.has(`${prefix}-${i}`)) {
        return `${prefix}-${i}`;
      }
    }
  }

  async addMember(record: DeploymentRecord, ctx: ProviderContext, replicaSet: string, kind: MemberKind): Promise<string> {
    if (!membersOf(record, replicaSet).length) {
      throw new Error(`Unknown replica set ${replicaSet}.`);
    }
    if (replicaSet === CONFIG_RS && kind === 'arbiter') {
      throw new Error('Config server replica sets can not have arbiters.');
    }
    const role: NodeLayout['role'] = kind === 'arbiter' ? 'arbiter' : replicaSet === CONFIG_RS ? 'configsvr' : 'mongod';
    const node: NodeLayout = {
      id: this.nextId(record, kind === 'arbiter' ? `${replicaSet}-arbiter` : replicaSet),
      role,
      replicaSet,
      port: await this.nextPort(record),
      hidden: kind === 'hidden' || undefined
    };
    record.nodes = [...(record.nodes ?? []), node];
    await ctx.save(record);
    ctx.progress(`Starting ${node.id} on port ${node.port}…`);
    await this.runtime.startNode(record, node, ctx);
    await this.waitReady(record, node, ctx);
    ctx.progress(`Adding ${hostOf(node)} to ${replicaSet}…`);
    try {
      await this.reconfig(
        record,
        replicaSet,
        ctx,
        ClusterService.addMemberTransform({ host: hostOf(node), arbiterOnly: kind === 'arbiter', hidden: kind === 'hidden' })
      );
    } catch (err) {
      ctx.progress(`Rolling back ${node.id}…`);
      await this.runtime.removeNode(record, node, ctx, false).catch(() => undefined);
      record.nodes = (record.nodes ?? []).filter((n) => n.id !== node.id);
      await ctx.save(record);
      throw err;
    }
    return node.id;
  }

  async removeMember(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    const node = (record.nodes ?? []).find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown node ${nodeId}.`);
    }
    if (node.role === 'mongos') {
      return this.removeRouter(record, ctx, nodeId);
    }
    if (!node.replicaSet) {
      throw new Error('A standalone server can not be removed; destroy the deployment instead.');
    }
    const password = await this.withPassword(record, ctx);
    const primary = await this.primaryOf(record, node.replicaSet);
    if (primary.id === node.id) {
      ctx.progress(`${node.id} is primary — stepping it down…`);
      await this.admin
        .command(record, node, { replSetStepDown: 60, secondaryCatchUpPeriodSecs: 15 }, { auth: record.spec.auth, password })
        .catch(() => undefined);
      await retry(async () => {
        const next = await this.primaryOf(record, node.replicaSet as string);
        if (next.id === node.id) {
          throw new Error('still primary');
        }
      }, 90_000, 2000, ctx.token);
    }
    ctx.progress(`Removing ${hostOf(node)} from ${node.replicaSet}…`);
    await this.reconfig(record, node.replicaSet, ctx, ClusterService.removeMemberTransform(hostOf(node)));
    ctx.progress(`Removing ${node.id}…`);
    await this.runtime.removeNode(record, node, ctx, false);
    record.nodes = (record.nodes ?? []).filter((n) => n.id !== nodeId);
    await ctx.save(record);
  }

  async addShard(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    const password = await this.withPassword(record, ctx);
    const existing = new Set(shardNames(record));
    let index = 0;
    while (existing.has(`shard${index}`)) {
      index += 1;
    }
    const name = `shard${index}`;
    const added: NodeLayout[] = [];
    const pending = new Set<number>();
    for (let i = 0; i < record.spec.members + (record.spec.arbiter ? 1 : 0); i += 1) {
      const arbiter = record.spec.arbiter && i === record.spec.members;
      const port = await this.runtime.allocatePort(record, pending);
      pending.add(port);
      added.push({ id: arbiter ? `${name}-arbiter` : `${name}-${i}`, role: arbiter ? 'arbiter' : 'mongod', replicaSet: name, port });
    }
    record.nodes = [...(record.nodes ?? []), ...added];
    await ctx.save(record);
    for (const node of added) {
      ctx.progress(`Starting ${node.id}…`);
      await this.runtime.startNode(record, node, ctx);
    }
    for (const node of added) {
      await this.waitReady(record, node, ctx);
    }
    ctx.progress(`Initiating ${name}…`);
    await this.initiate(record, name, ctx);
    if (record.spec.auth && password) {
      await this.createAdminUser(record, await this.primaryOf(record, name), password);
    }
    const router = this.router(record);
    ctx.progress(`Adding shard ${name} to the cluster…`);
    await this.admin.command(record, router, { addShard: this.shardConnectionString(record, name), name }, { auth: record.spec.auth, password });
    return name;
  }

  /**
   * Drain a shard (moving its chunks and the primary databases it owns) and
   * remove its nodes once the cluster reports `completed`.
   */
  async removeShard(record: DeploymentRecord, ctx: ProviderContext, shard: string): Promise<void> {
    const password = await this.withPassword(record, ctx);
    const auth = record.spec.auth;
    const remaining = shardNames(record).filter((s) => s !== shard);
    if (remaining.length === 0) {
      throw new Error('A sharded cluster needs at least one shard.');
    }
    const router = this.router(record);
    const deadline = Date.now() + 15 * 60_000;
    for (;;) {
      if (ctx.token.isCancellationRequested) {
        throw new Error('Cancelled — the shard keeps draining; run Remove Shard again to finish.');
      }
      const result = await this.admin.command(record, router, { removeShard: shard }, { auth, password });
      ctx.progress(`Draining ${shard}: ${String(result.state ?? result.msg ?? '')}${result.remaining ? ` (${JSON.stringify(result.remaining)})` : ''}`);
      if (result.state === 'completed') {
        break;
      }
      for (const db of (result.dbsToMove ?? []) as string[]) {
        ctx.progress(`Moving the primary of ${db} to ${remaining[0]}…`);
        await this.admin.command(record, router, { movePrimary: db, to: remaining[0] }, { auth, password, timeoutMs: 600_000 });
      }
      if (Date.now() > deadline) {
        throw new Error(`${shard} is still draining. It continues in the background; run Remove Shard again to finish.`);
      }
      await sleep(5000);
    }
    for (const node of membersOf(record, shard)) {
      ctx.progress(`Removing ${node.id}…`);
      await this.runtime.removeNode(record, node, ctx, false);
    }
    record.nodes = (record.nodes ?? []).filter((n) => n.replicaSet !== shard);
    await ctx.save(record);
  }

  async addRouter(record: DeploymentRecord, ctx: ProviderContext): Promise<string> {
    const node: NodeLayout = { id: this.nextId(record, 'mongos'), role: 'mongos', port: await this.nextPort(record) };
    record.nodes = [...(record.nodes ?? []), node];
    await ctx.save(record);
    ctx.progress(`Starting ${node.id} on port ${node.port}…`);
    await this.runtime.startNode(record, node, ctx);
    await this.waitReady(record, node, ctx, 120_000);
    return node.id;
  }

  async removeRouter(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    const routers = (record.nodes ?? []).filter((n) => n.role === 'mongos');
    if (routers.length <= 1) {
      throw new Error('The cluster needs at least one router.');
    }
    const node = routers.find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown router ${nodeId}.`);
    }
    await this.runtime.removeNode(record, node, ctx, false);
    record.nodes = (record.nodes ?? []).filter((n) => n.id !== nodeId);
    await ctx.save(record);
  }

  /** Replica set state of each node (`PRIMARY`, `SECONDARY`, …), by node id. */
  async memberStates(record: DeploymentRecord, password: string | undefined): Promise<Map<string, string>> {
    const states = new Map<string, string>();
    for (const name of replicaSetNames(record)) {
      const members = membersOf(record, name);
      for (const node of members.filter((n) => n.role !== 'arbiter')) {
        try {
          const status = await this.admin.command(record, node, { replSetGetStatus: 1 }, { auth: record.spec.auth, password, timeoutMs: 8000 });
          for (const m of (status.members ?? []) as Document[]) {
            const match = members.find((n) => hostOf(n) === m.name);
            if (match) {
              states.set(match.id, m.health === 1 ? String(m.stateStr) : 'DOWN');
            }
          }
          break;
        } catch {
          // ask the next member
        }
      }
    }
    return states;
  }

  private router(record: DeploymentRecord): NodeLayout {
    const router = (record.nodes ?? []).find((n) => n.role === 'mongos');
    if (!router) {
      throw new Error('This deployment has no router.');
    }
    return router;
  }
}
