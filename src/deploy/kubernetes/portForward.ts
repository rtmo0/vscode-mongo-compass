import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'child_process';
import { logger } from '../../core/logger';
import { findFreePortRange, isPortFree } from '../process';

interface Forward {
  localPort: number;
  child?: ChildProcess;
  ready: Promise<number>;
  keepAlive: boolean;
  disposed: boolean;
}

/**
 * `kubectl port-forward` processes, one per target. A forward marked
 * `keepAlive` (the one behind a saved connection) is restarted on the same
 * local port when kubectl exits, e.g. after the pod was rescheduled.
 */
export class PortForwardManager implements vscode.Disposable {
  private readonly forwards = new Map<string, Forward>();

  /** Forward `target` (`pod/x` or `svc/x`) and return the local port. */
  async forward(context: string, namespace: string, target: string, remotePort: number, options: { localPort?: number; keepAlive?: boolean } = {}): Promise<number> {
    const key = `${context}|${namespace}|${target}|${remotePort}`;
    const existing = this.forwards.get(key);
    if (existing && !existing.disposed) {
      if (options.keepAlive) {
        existing.keepAlive = true;
      }
      return existing.ready;
    }
    let localPort = options.localPort;
    if (!localPort || !(await isPortFree(localPort))) {
      localPort = await findFreePortRange(29100, 1);
    }
    const entry: Forward = { localPort, keepAlive: Boolean(options.keepAlive), disposed: false, ready: Promise.resolve(localPort) };
    entry.ready = this.spawn(key, entry, context, namespace, target, remotePort);
    this.forwards.set(key, entry);
    entry.ready.catch(() => {
      if (this.forwards.get(key) === entry) {
        this.forwards.delete(key);
      }
    });
    return entry.ready;
  }

  /** Stop every forward of a namespace (when a deployment is destroyed or forgotten). */
  stopNamespace(context: string, namespace: string): void {
    for (const [key, entry] of [...this.forwards]) {
      if (key.startsWith(`${context}|${namespace}|`)) {
        entry.disposed = true;
        entry.child?.kill();
        this.forwards.delete(key);
      }
    }
  }

  private spawn(key: string, entry: Forward, context: string, namespace: string, target: string, remotePort: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const child = spawn(
        'kubectl',
        ['--context', context, '-n', namespace, 'port-forward', '--address', '127.0.0.1', target, `${entry.localPort}:${remotePort}`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      entry.child = child;
      let settled = false;
      let stderr = '';
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill();
          reject(new Error(`kubectl port-forward ${target} did not start: ${stderr.trim() || 'timeout'}`));
        }
      }, 20_000);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        if (!settled && /Forwarding from/.test(chunk)) {
          settled = true;
          clearTimeout(timer);
          logger.info('Port-forward ready', { target, localPort: entry.localPort });
          resolve(entry.localPort);
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
        // A forward to a deleted pod keeps the process alive but useless.
        if (/lost connection to pod|error forwarding port/i.test(chunk)) {
          child.kill();
        }
      });
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      child.on('exit', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`kubectl port-forward ${target} exited: ${stderr.trim()}`));
          return;
        }
        if (entry.disposed || this.forwards.get(key) !== entry) {
          return;
        }
        if (entry.keepAlive) {
          logger.warn('Port-forward exited, restarting', { target });
          setTimeout(() => {
            if (!entry.disposed && this.forwards.get(key) === entry) {
              entry.ready = this.spawn(key, entry, context, namespace, target, remotePort);
              entry.ready.catch((err: Error) => logger.error('Port-forward restart failed', { target, error: err.message }));
            }
          }, 2000);
        } else {
          this.forwards.delete(key);
        }
      });
    });
  }

  dispose(): void {
    for (const entry of this.forwards.values()) {
      entry.disposed = true;
      entry.child?.kill();
    }
    this.forwards.clear();
  }
}
