import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as net from 'net';
import { execFile, spawn } from 'child_process';
import { logger } from '../core/logger';

export interface RunOptions {
  /** Written to the process' stdin (used to pass secrets without putting them in argv). */
  input?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  token?: vscode.CancellationToken;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Run a CLI without a shell. Rejects with its stderr when it exits non-zero. */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ? { ...process.env, ...options.env } : process.env,
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cancel?.dispose();
      if (err) {
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`${command} ${args[0] ?? ''} timed out after ${Math.round((options.timeoutMs ?? 0) / 1000)}s`));
    }, options.timeoutMs ?? 120_000);
    const cancel = options.token?.onCancellationRequested(() => {
      child.kill('SIGTERM');
      finish(new Error('Cancelled'));
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (code === 0) {
        finish();
      } else {
        const message = (stderr.trim() || stdout.trim() || `exit code ${code}`).split('\n').slice(-8).join('\n');
        finish(new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${message}`));
      }
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

/** Full path of an executable on PATH, or undefined. */
export async function which(command: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [command], (err, stdout) => {
      resolve(err ? undefined : stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean));
    });
  });
}

/** Open an editor terminal running `command` directly (no shell). */
export function openCommandTerminal(name: string, command: string, args: string[], env?: Record<string, string>): vscode.Terminal {
  const terminal = vscode.window.createTerminal({
    name,
    shellPath: command,
    shellArgs: args,
    env,
    location: vscode.TerminalLocation.Editor
  });
  terminal.show();
  return terminal;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retry `fn` until it resolves or `timeoutMs` elapses. */
export async function retry<T>(fn: () => Promise<T>, timeoutMs: number, intervalMs = 2000, token?: vscode.CancellationToken): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;
  while (Date.now() < deadline) {
    if (token?.isCancellationRequested) {
      throw new Error('Cancelled');
    }
    try {
      return await fn();
    } catch (err) {
      lastError = err as Error;
    }
    await sleep(intervalMs);
  }
  throw lastError ?? new Error('Timed out');
}

/** A random password with only URI-safe characters, so it never needs escaping. */
export function generatePassword(length = 24): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/** Contents of a replica set keyfile (base64, within the 6–1024 character limit). */
export function generateKeyfile(): string {
  return crypto.randomBytes(756).toString('base64');
}

/** Lower-case DNS-label-safe name (Docker containers, Kubernetes resources). */
export function slugify(value: string, maxLength = 40): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'mongo';
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** First `count` consecutive free ports at or above `start`. */
export async function findFreePortRange(start: number, count: number, exclude: Set<number> = new Set()): Promise<number> {
  for (let base = start; base < 65000; base += count) {
    let free = true;
    for (let port = base; port < base + count; port += 1) {
      if (exclude.has(port) || !(await isPortFree(port))) {
        free = false;
        break;
      }
    }
    if (free) {
      return base;
    }
  }
  throw new Error(`No free range of ${count} ports above ${start}`);
}

const RESULT_MARKER = '__MONGO_COMPASS_RESULT__';

/**
 * Wrap a mongosh script so its result can be read back: the script's last
 * expression must assign `result`.
 */
export function mongoshScript(body: string): string {
  return `let result = null;\n${body}\nprint(${JSON.stringify(RESULT_MARKER)} + EJSON.stringify(result, { relaxed: true }));\n`;
}

export function parseMongoshResult<T = unknown>(stdout: string): T {
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith(RESULT_MARKER));
  if (!line) {
    throw new Error(`mongosh produced no result: ${stdout.trim().slice(-500)}`);
  }
  return JSON.parse(line.slice(RESULT_MARKER.length)) as T;
}

/**
 * Run a mongosh script inside a container or pod. The script travels over
 * stdin into a temporary file, so passwords in it never appear in the
 * argument list of a local process.
 *
 * `prefix` is the command that executes in the target with stdin attached,
 * e.g. `['docker', 'exec', '-i', name]` or `['kubectl', ..., 'exec', '-i', pod, '--']`.
 */
export async function runMongoshInside<T = unknown>(prefix: string[], body: string, options: RunOptions = {}): Promise<T> {
  const shell = 'f=/tmp/mc-$$.js; cat > "$f" && mongosh --nodb --quiet "$f"; rc=$?; rm -f "$f"; exit $rc';
  const [command, ...args] = prefix;
  const { stdout } = await run(command, [...args, 'sh', '-c', shell], { ...options, input: mongoshScript(body) });
  return parseMongoshResult<T>(stdout);
}

/** mongosh source for a connection string literal. */
export function mongoUri(host: string, user?: string, password?: string, options = 'directConnection=true'): string {
  const auth = user && password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}@` : '';
  const query = [options, auth ? 'authSource=admin' : ''].filter(Boolean).join('&');
  return `mongodb://${auth}${host}/admin${query ? `?${query}` : ''}`;
}

export function logError(message: string, err: unknown): void {
  logger.error(message, { error: (err as Error).message });
}
