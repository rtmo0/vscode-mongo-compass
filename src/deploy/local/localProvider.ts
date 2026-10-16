import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { DriverNodeAdmin } from '../driverNodeAdmin';
import {
  CONFIG_RS,
  ManagedCluster,
  connectionStringForNodes,
  hostOf,
  planNodes,
  portsNeeded,
  type NodeRuntime
} from '../managedCluster';
import { bootstrapShellScript } from '../exportScripts';
import { findFreePortRange, generateKeyfile, isPortFree, openCommandTerminal, run, sleep, which } from '../process';
import type {
  DeploymentNode,
  DeploymentProvider,
  DeploymentRecord,
  DeploymentStatus,
  ExportedDefinition,
  MemberKind,
  NodeLayout,
  ProviderContext,
  TopologyKind
} from '../types';

const exe = (name: string): string => (process.platform === 'win32' ? `${name}.exe` : name);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Deployments made of `mongod` / `mongos` processes on this machine.
 * Data, logs, pid files and the keyfile live in the extension's global
 * storage. The processes are detached, so they keep running when VS Code
 * closes; Stop / Destroy shut them down cleanly (SIGTERM).
 */
export class LocalProvider implements DeploymentProvider, NodeRuntime {
  readonly id = 'local' as const;
  readonly label = 'Local processes';
  readonly topologies: TopologyKind[] = ['standalone', 'replicaSet', 'sharded'];

  private readonly cluster = new ManagedCluster(new DriverNodeAdmin(), this);
  /** Nodes frozen with SIGSTOP (not visible from the pid alone). */
  private readonly paused = new Set<string>();

  constructor(
    private readonly allRecords: () => DeploymentRecord[],
    private readonly storageRoot: () => string
  ) {}

  async checkAvailable(): Promise<string | undefined> {
    const binDir = this.defaultBinDir();
    const mongod = binDir ? path.join(binDir, exe('mongod')) : await which('mongod');
    if (!mongod || !fs.existsSync(mongod)) {
      return 'mongod was not found. Install MongoDB Community Server and add its bin folder to PATH, or set "mongoCompass.local.binDir".';
    }
    return undefined;
  }

  private defaultBinDir(): string | undefined {
    return vscode.workspace.getConfiguration('mongoCompass.local').get<string>('binDir') || undefined;
  }

  private dir(record: DeploymentRecord): string {
    return path.join(this.storageRoot(), 'deployments', record.id);
  }

  private async binary(record: DeploymentRecord, node: NodeLayout): Promise<string> {
    const name = exe(node.role === 'mongos' ? 'mongos' : 'mongod');
    const binDir = node.binDir ?? record.spec.local?.binDir ?? this.defaultBinDir();
    if (binDir) {
      const candidate = path.join(binDir, name);
      if (!fs.existsSync(candidate)) {
        throw new Error(`${candidate} does not exist.`);
      }
      return candidate;
    }
    const found = await which(name.replace(/\.exe$/, ''));
    if (!found) {
      throw new Error(`${name} is not on PATH.`);
    }
    return found;
  }

  private paths(record: DeploymentRecord, node: NodeLayout): { data: string; log: string; pid: string } {
    const base = this.dir(record);
    return {
      data: path.join(base, node.id),
      log: path.join(base, 'logs', `${node.id}.log`),
      pid: path.join(base, 'run', `${node.id}.pid`)
    };
  }

  private args(record: DeploymentRecord, node: NodeLayout): string[] {
    const p = this.paths(record, node);
    const common = ['--port', String(node.port), '--bind_ip', '127.0.0.1', '--logpath', p.log, '--logappend', '--pidfilepath', p.pid];
    const keyFile = record.spec.auth ? ['--keyFile', path.join(this.dir(record), 'keyfile')] : [];
    if (node.role === 'mongos') {
      const configHosts = (record.nodes ?? []).filter((n) => n.replicaSet === CONFIG_RS).map(hostOf);
      return [...common, '--configdb', `${CONFIG_RS}/${configHosts.join(',')}`, ...keyFile];
    }
    const args = [...common, '--dbpath', p.data, '--wiredTigerCacheSizeGB', '0.25'];
    if (node.replicaSet) {
      args.push('--replSet', node.replicaSet);
      if (node.role === 'configsvr') {
        args.push('--configsvr');
      } else if (record.spec.topology === 'sharded') {
        args.push('--shardsvr');
      }
    }
    return [...args, ...keyFile];
  }

  private pidOf(record: DeploymentRecord, node: NodeLayout): number | undefined {
    try {
      const pid = parseInt(fs.readFileSync(this.paths(record, node).pid, 'utf8').trim(), 10);
      return Number.isFinite(pid) && pid > 0 && isAlive(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────── NodeRuntime ─────────────────────────────

  async allocatePort(record: DeploymentRecord, pending: Set<number>): Promise<number> {
    const taken = new Set<number>(pending);
    for (const r of this.allRecords().filter((r) => r.spec.provider === 'local')) {
      for (const n of r.nodes ?? []) {
        taken.add(n.port);
      }
    }
    for (let port = record.spec.local?.basePort ?? 28000; port < 65000; port += 1) {
      if (!taken.has(port) && (await isPortFree(port))) {
        return port;
      }
    }
    throw new Error('No free port found.');
  }

  async startNode(record: DeploymentRecord, node: NodeLayout, _ctx: ProviderContext): Promise<void> {
    if (this.pidOf(record, node)) {
      return;
    }
    const p = this.paths(record, node);
    await fs.promises.mkdir(path.dirname(p.log), { recursive: true });
    await fs.promises.mkdir(path.dirname(p.pid), { recursive: true });
    if (node.role !== 'mongos') {
      await fs.promises.mkdir(p.data, { recursive: true });
    }
    const binary = await this.binary(record, node);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, this.args(record, node), { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
    // A bad option makes mongod exit at once; report its log instead of timing out later.
    await sleep(800);
    if (!this.pidOf(record, node)) {
      await sleep(1500);
    }
    if (!this.pidOf(record, node)) {
      throw new Error(`${node.id} did not start. Last log lines:\n${this.tail(p.log, 10)}`);
    }
  }

  async removeNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext, keepData: boolean): Promise<void> {
    await this.stopNode(record, node, ctx);
    if (!keepData) {
      await fs.promises.rm(this.paths(record, node).data, { recursive: true, force: true });
    }
  }

  private async stopNode(record: DeploymentRecord, node: NodeLayout, ctx: ProviderContext, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const pid = this.pidOf(record, node);
    if (!pid) {
      return;
    }
    if (this.paused.has(`${record.id}|${node.id}`)) {
      process.kill(pid, 'SIGCONT');
      this.paused.delete(`${record.id}|${node.id}`);
    }
    process.kill(pid, signal);
    for (let i = 0; i < 120 && isAlive(pid); i += 1) {
      if (ctx.token.isCancellationRequested) {
        return;
      }
      await sleep(500);
    }
    if (isAlive(pid)) {
      process.kill(pid, 'SIGKILL');
    }
  }

  private tail(file: string, lines: number): string {
    try {
      return fs.readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n');
    } catch {
      return '(no log)';
    }
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async create(record: DeploymentRecord, ctx: ProviderContext): Promise<void> {
    const exclude = new Set<number>();
    for (const r of this.allRecords().filter((r) => r.spec.provider === 'local' && r.id !== record.id)) {
      for (const n of r.nodes ?? []) {
        exclude.add(n.port);
      }
    }
    const base = await findFreePortRange(record.spec.local?.basePort ?? 28000, portsNeeded(record.spec), exclude);
    record.nodes = planNodes(record.spec, base);
    await ctx.save(record);
    await fs.promises.mkdir(this.dir(record), { recursive: true });
    if (record.spec.auth) {
      await fs.promises.writeFile(path.join(this.dir(record), 'keyfile'), generateKeyfile(), { mode: 0o600 });
    }
    await this.cluster.bootstrap(record, ctx);
  }

  async status(record: DeploymentRecord): Promise<DeploymentStatus> {
    const nodes: DeploymentNode[] = (record.nodes ?? []).map((node) => {
      const pid = this.pidOf(record, node);
      const paused = pid && this.paused.has(`${record.id}|${node.id}`);
      return {
        id: node.id,
        name: node.id,
        role: node.role,
        replicaSet: node.replicaSet,
        address: hostOf(node),
        status: paused ? 'paused' : pid ? 'running' : 'stopped',
        detail: pid ? `pid ${pid}${node.binDir ? ` · ${node.binDir}` : ''}` : undefined
      };
    });
    if (nodes.some((n) => n.status === 'running')) {
      const password = record.spec.auth ? await this.passwordHook?.(record) : undefined;
      const states = await this.cluster.memberStates(record, password).catch(() => new Map<string, string>());
      for (const node of nodes) {
        node.memberState = states.get(node.id);
      }
    }
    const running = nodes.filter((n) => n.status === 'running').length;
    return {
      state:
        record.provisioning?.state === 'creating'
          ? 'creating'
          : record.provisioning?.state === 'failed'
            ? 'error'
            : running === nodes.length && running > 0
              ? 'running'
              : running === 0
                ? 'stopped'
                : 'degraded',
      nodes,
      message: record.provisioning?.message ?? this.dir(record)
    };
  }

  passwordHook?: (record: DeploymentRecord) => Promise<string | undefined>;

  async connectionString(record: DeploymentRecord, password: string | undefined): Promise<string> {
    return connectionStringForNodes(record, password);
  }

  async destroy(record: DeploymentRecord, ctx: ProviderContext, options: { keepData: boolean }): Promise<void> {
    await this.stop(record, ctx);
    if (!options.keepData) {
      await fs.promises.rm(this.dir(record), { recursive: true, force: true });
    }
  }

  async start(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    const nodes = (record.nodes ?? []).filter((n) => !nodeId || n.id === nodeId);
    const order = [...nodes.filter((n) => n.role !== 'mongos'), ...nodes.filter((n) => n.role === 'mongos')];
    for (const node of order) {
      ctx.progress(`Starting ${node.id}…`);
      await this.startNode(record, node, ctx);
    }
  }

  async stop(record: DeploymentRecord, ctx: ProviderContext, nodeId?: string): Promise<void> {
    const nodes = (record.nodes ?? []).filter((n) => !nodeId || n.id === nodeId);
    const order = [...nodes.filter((n) => n.role === 'mongos'), ...nodes.filter((n) => n.role !== 'mongos')];
    for (const node of order) {
      ctx.progress(`Stopping ${node.id}…`);
      await this.stopNode(record, node, ctx);
    }
  }

  async restartNode(record: DeploymentRecord, ctx: ProviderContext, nodeId: string): Promise<void> {
    const node = this.node(record, nodeId);
    await this.stopNode(record, node, ctx);
    await this.startNode(record, node, ctx);
    await this.cluster.waitReady(record, node, ctx);
  }

  async chaos(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, action: 'kill' | 'pause' | 'unpause'): Promise<void> {
    const node = this.node(record, nodeId);
    const pid = this.pidOf(record, node);
    if (!pid) {
      throw new Error(`${nodeId} is not running.`);
    }
    if (action !== 'kill' && process.platform === 'win32') {
      throw new Error('Pausing processes is not supported on Windows.');
    }
    const key = `${record.id}|${node.id}`;
    if (action === 'kill') {
      await this.stopNode(record, node, ctx, 'SIGKILL');
    } else if (action === 'pause') {
      process.kill(pid, 'SIGSTOP');
      this.paused.add(key);
    } else {
      process.kill(pid, 'SIGCONT');
      this.paused.delete(key);
    }
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

  /** Restart one node from another folder of MongoDB binaries (`target` is that folder). */
  async upgradeNode(record: DeploymentRecord, ctx: ProviderContext, nodeId: string, target: string): Promise<void> {
    const node = this.node(record, nodeId);
    const binary = path.join(target, exe(node.role === 'mongos' ? 'mongos' : 'mongod'));
    if (!fs.existsSync(binary)) {
      throw new Error(`${binary} does not exist.`);
    }
    await this.stopNode(record, node, ctx);
    node.binDir = target;
    await ctx.save(record);
    await this.startNode(record, node, ctx);
    await this.cluster.waitReady(record, node, ctx, 180_000);
  }

  async openLogs(record: DeploymentRecord, nodeId: string): Promise<void> {
    const log = this.paths(record, this.node(record, nodeId)).log;
    if (process.platform === 'win32') {
      openCommandTerminal(`log: ${nodeId}`, 'powershell.exe', ['-NoProfile', '-Command', `Get-Content -Wait -Tail 300 -Path '${log.replace(/'/g, "''")}'`]);
    } else {
      openCommandTerminal(`log: ${nodeId}`, 'tail', ['-n', '300', '-F', log]);
    }
  }

  async describeNode(record: DeploymentRecord, nodeId: string): Promise<string> {
    const node = this.node(record, nodeId);
    const binary = await this.binary(record, node).catch((err: Error) => err.message);
    const version = await run(binary, ['--version']).then((r) => r.stdout.split('\n')[0]).catch(() => '');
    return [
      `${node.id} (${node.role})`,
      `pid: ${this.pidOf(record, node) ?? 'not running'}`,
      `binary: ${binary} ${version}`,
      `command: ${[binary, ...this.args(record, node)].join(' ')}`,
      '',
      'Last log lines:',
      this.tail(this.paths(record, node).log, 40)
    ].join('\n');
  }

  async exportDefinition(record: DeploymentRecord): Promise<ExportedDefinition> {
    const lines = [
      '#!/usr/bin/env bash',
      `# MongoDB deployment "${record.spec.name}" exported by MongoDB Compass for VS Code.`,
      '# Starts every node from $MONGO_BIN (or PATH) under $MONGO_DATA and bootstraps it.',
      record.spec.auth ? '# Requires MONGO_ROOT_PASSWORD in the environment.' : '',
      'set -eu',
      'MONGO_DATA="${MONGO_DATA:-$PWD/mongo-data}"',
      'BIN="${MONGO_BIN:+$MONGO_BIN/}"',
      'mkdir -p "$MONGO_DATA/logs"'
    ].filter(Boolean);
    if (record.spec.auth) {
      lines.push('[ -f "$MONGO_DATA/keyfile" ] || { openssl rand -base64 756 > "$MONGO_DATA/keyfile"; chmod 600 "$MONGO_DATA/keyfile"; }');
    }
    const keyFile = record.spec.auth ? ' --keyFile "$MONGO_DATA/keyfile"' : '';
    for (const node of [...(record.nodes ?? []).filter((n) => n.role !== 'mongos'), ...(record.nodes ?? []).filter((n) => n.role === 'mongos')]) {
      const log = `--logpath "$MONGO_DATA/logs/${node.id}.log" --fork`;
      if (node.role === 'mongos') {
        const configHosts = (record.nodes ?? []).filter((n) => n.replicaSet === CONFIG_RS).map(hostOf).join(',');
        lines.push(`"\${BIN}mongos" --port ${node.port} --bind_ip 127.0.0.1 --configdb ${CONFIG_RS}/${configHosts} ${log}${keyFile} &`);
        continue;
      }
      const rs = node.replicaSet
        ? ` --replSet ${node.replicaSet}${node.role === 'configsvr' ? ' --configsvr' : record.spec.topology === 'sharded' ? ' --shardsvr' : ''}`
        : '';
      lines.push(`mkdir -p "$MONGO_DATA/${node.id}"`, `"\${BIN}mongod" --port ${node.port} --bind_ip 127.0.0.1 --dbpath "$MONGO_DATA/${node.id}"${rs} ${log}${keyFile}`);
    }
    lines.push(bootstrapShellScript(record, (node) => `mongosh --quiet --port ${node.port}`));
    lines.push(`# Connect with: ${connectionStringForNodes(record, record.spec.auth ? 'PASSWORD' : undefined).replace('PASSWORD', '<password>')}`);
    return { language: 'shellscript', content: lines.join('\n') + '\n' };
  }

  private node(record: DeploymentRecord, nodeId: string): NodeLayout {
    const node = (record.nodes ?? []).find((n) => n.id === nodeId);
    if (!node) {
      throw new Error(`Unknown node ${nodeId}.`);
    }
    return node;
  }
}
