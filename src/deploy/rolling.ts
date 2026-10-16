import type { ClusterService } from '../core/cluster/clusterService';
import { retry } from './process';
import type { DeploymentNode, DeploymentProvider, DeploymentRecord, ProviderContext } from './types';

type NodeAction = (node: DeploymentNode) => Promise<void>;

/**
 * Apply `action` (restart or upgrade) to every node without losing
 * availability, in the order MongoDB recommends:
 *
 * 1. config servers, then each shard (or the only replica set):
 *    secondaries and arbiters one at a time, each waited on until it is
 *    healthy and caught up; then the primary is stepped down and handled last;
 * 2. routers one at a time.
 *
 * The balancer is stopped for the duration on sharded clusters.
 */
export async function rollingOperation(
  record: DeploymentRecord,
  provider: DeploymentProvider,
  cluster: ClusterService,
  connectionId: string,
  ctx: ProviderContext,
  action: NodeAction
): Promise<void> {
  const status = await provider.status(record);
  const nodes = status.nodes.filter((n) => n.role !== 'network');
  const sets = [...new Set(nodes.map((n) => n.replicaSet).filter((s): s is string => Boolean(s)))].sort((a, b) => {
    const rank = (name: string): number => (nodes.find((n) => n.replicaSet === name)?.role === 'configsvr' ? 0 : 1);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

  const sharded = record.spec.topology === 'sharded';
  if (sharded) {
    ctx.progress('Stopping the balancer…');
    await cluster.setBalancerRunning(connectionId, false);
  }
  try {
    for (const set of sets) {
      const members = nodes.filter((n) => n.replicaSet === set && n.address);
      const { info } = await cluster.replicaSetFor(connectionId, members[0].address);
      const primaryHost = info.primary?.toLowerCase();
      const ordered = [
        ...members.filter((n) => n.address?.toLowerCase() !== primaryHost),
        ...members.filter((n) => n.address?.toLowerCase() === primaryHost)
      ];
      for (const node of ordered) {
        if (ctx.token.isCancellationRequested) {
          throw new Error('Cancelled');
        }
        const address = node.address as string;
        if (address.toLowerCase() === primaryHost) {
          ctx.progress(`${set}: stepping down ${node.name}…`);
          await cluster.stepDown(connectionId, { host: address, stepDownSecs: 120, catchUpSecs: 30 }).catch((err: Error) => {
            if (!/connection|closed|interrupted|not primary/i.test(err.message)) {
              throw err;
            }
          });
          await retry(async () => {
            const { info: next } = await cluster.replicaSetFor(connectionId, members.find((m) => m !== node)?.address ?? address);
            if (!next.primary || next.primary.toLowerCase() === primaryHost) {
              throw new Error('waiting for a new primary');
            }
          }, 120_000, 2000, ctx.token);
        }
        ctx.progress(`${set}: ${node.name}…`);
        await action(node);
        const expected = node.role === 'arbiter' ? ['ARBITER'] : ['SECONDARY', 'PRIMARY'];
        ctx.progress(`${set}: waiting for ${node.name} to be ${expected[0]}…`);
        await cluster.waitForMember(connectionId, address, expected, 600_000);
      }
    }
    for (const router of nodes.filter((n) => n.role === 'mongos')) {
      ctx.progress(`router ${router.name}…`);
      await action(router);
    }
  } finally {
    if (sharded) {
      ctx.progress('Starting the balancer…');
      await cluster.setBalancerRunning(connectionId, true).catch(() => undefined);
    }
  }
}
