import { CONFIG_RS, hostOf, replicaSetNames, shardNames } from './managedCluster';
import type { DeploymentRecord, NodeLayout } from './types';

/**
 * A bash script that bootstraps a deployment whose nodes are already running:
 * initiates every replica set, creates the admin user (password from
 * `$MONGO_ROOT_PASSWORD`) and registers the shards. Every step tolerates
 * having run before, so the script can be re-run safely.
 *
 * `mongosh(node)` returns the command that opens mongosh on a node.
 */
export function bootstrapShellScript(record: DeploymentRecord, mongosh: (node: NodeLayout) => string): string {
  const { spec } = record;
  const nodes = record.nodes ?? [];
  const lines: string[] = ['set -u'];
  const authed = (node: NodeLayout): string =>
    `${mongosh(node)} -u ${spec.username} -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin`;
  const waitFor = (node: NodeLayout, check = 'db.adminCommand({ping: 1})'): string =>
    `until ${mongosh(node)} --eval '${check}' >/dev/null 2>&1; do sleep 1; done`;
  const createUser = (node: NodeLayout): string =>
    `${mongosh(node)} --eval 'db.getSiblingDB("admin").createUser({user: "${spec.username}", pwd: process.env.MONGO_ROOT_PASSWORD, roles: ["root"]})' || true`;

  for (const node of nodes.filter((n) => n.role !== 'mongos')) {
    lines.push(`echo "waiting for ${node.id}"`, waitFor(node));
  }
  for (const name of replicaSetNames(record)) {
    const members = nodes.filter((n) => n.replicaSet === name);
    const data = members.filter((n) => n.role !== 'arbiter');
    const config = {
      _id: name,
      ...(name === CONFIG_RS ? { configsvr: true } : {}),
      members: [
        ...data.map((n, i) => ({ _id: i, host: hostOf(n), priority: i === 0 ? 2 : 1 })),
        ...members.filter((n) => n.role === 'arbiter').map((n, i) => ({ _id: data.length + i, host: hostOf(n), arbiterOnly: true }))
      ]
    };
    lines.push(
      `echo "initiating ${name}"`,
      `${mongosh(data[0])} --eval 'rs.initiate(${JSON.stringify(config)})' || true`,
      waitFor(data[0], 'quit(db.hello().isWritablePrimary ? 0 : 1)')
    );
    if (spec.auth && spec.topology === 'sharded' && name !== CONFIG_RS) {
      lines.push(createUser(data[0]));
    }
  }
  const router = nodes.find((n) => n.role === 'mongos');
  if (spec.topology === 'sharded' && router) {
    for (const node of nodes.filter((n) => n.role === 'mongos')) {
      lines.push(`echo "waiting for ${node.id}"`, waitFor(node));
    }
    if (spec.auth) {
      lines.push(createUser(router));
    }
    for (const shard of shardNames(record)) {
      const hosts = nodes.filter((n) => n.replicaSet === shard && n.role !== 'arbiter').map(hostOf);
      lines.push(`${spec.auth ? authed(router) : mongosh(router)} --eval 'sh.addShard("${shard}/${hosts.join(',')}")' || true`);
    }
  } else if (spec.auth && nodes[0]) {
    lines.push(createUser(nodes.find((n) => n.role !== 'arbiter') ?? nodes[0]));
  }
  lines.push('echo "deployment ready"');
  return lines.join('\n') + '\n';
}
