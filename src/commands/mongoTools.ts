import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type MongoTool = 'mongosh' | 'mongodump' | 'mongorestore';

/**
 * Full path of a MongoDB CLI tool found on PATH. When it is missing, tells the
 * user how to install it and returns `undefined`.
 */
export async function findMongoTool(tool: MongoTool): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [tool]);
    const found = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (found) {
      return found;
    }
  } catch {
    // not on PATH
  }
  const isShell = tool === 'mongosh';
  const action = await vscode.window.showErrorMessage(
    `${tool} is not installed or is not available on PATH. Install ${isShell ? 'the MongoDB Shell' : 'MongoDB Database Tools'} and restart VS Code.`,
    'Installation instructions'
  );
  if (action) {
    await vscode.env.openExternal(vscode.Uri.parse(isShell
      ? 'https://www.mongodb.com/docs/mongodb-shell/install/'
      : 'https://www.mongodb.com/docs/database-tools/installation/installation/'));
  }
  return undefined;
}

/**
 * Open mongosh in an editor terminal.
 *
 * mongosh is started directly (no shell, so no shell-specific syntax or
 * history) and reads the connection string from its environment, so the
 * credentials never appear in its arguments, which any local user can read
 * with `ps`.
 */
export function openMongosh(name: string, executable: string, uri: string, env: Record<string, string> = {}): void {
  const terminal = vscode.window.createTerminal({
    name,
    location: vscode.TerminalLocation.Editor,
    shellPath: executable,
    shellArgs: ['--nodb', '--shell', '--eval', 'db = connect(process.env.MONGO_COMPASS_URI); undefined'],
    env: { ...env, MONGO_COMPASS_URI: uri }
  });
  terminal.show();
}

/**
 * Run mongodump / mongorestore and stream its output into an editor terminal.
 *
 * The connection string goes through a private `--config` file (removed as
 * soon as the tool exits) rather than `--uri`, so the credentials never appear
 * in the process arguments. No shell is involved, so paths need no quoting.
 * Requires MongoDB Database Tools 100.3.0 or newer.
 */
export async function runMongoTool(name: string, executable: string, uri: string, args: string[]): Promise<void> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mongo-compass-'));
  const configFile = path.join(dir, 'config.yaml');
  // A JSON string literal is also a valid YAML double-quoted scalar.
  await fs.promises.writeFile(configFile, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
  const cleanup = (): void => fs.rm(dir, { recursive: true, force: true }, () => undefined);

  const output = new vscode.EventEmitter<string>();
  const write = (text: string): void => output.fire(text.replace(/\r?\n/g, '\r\n'));
  const tool = path.basename(executable).replace(/\.exe$/i, '');
  let child: ChildProcess | undefined;
  let interrupted = false;
  /** Tools can ignore SIGTERM/SIGINT while waiting for a server, so escalate to SIGKILL. */
  const forceKillLater = (): void => {
    const target = child;
    setTimeout(() => {
      if (target && target.exitCode === null && target.signalCode === null) {
        target.kill('SIGKILL');
      }
    }, 3000).unref();
  };

  const pty: vscode.Pseudoterminal = {
    onDidWrite: output.event,
    open: () => {
      write(`${tool} ${args.join(' ')}\n\n`);
      child = spawn(executable, [`--config=${configFile}`, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout?.setEncoding('utf8').on('data', write);
      child.stderr?.setEncoding('utf8').on('data', write);
      child.on('error', (err) => {
        cleanup();
        write(`\n${err.message}\n`);
      });
      child.on('close', (code, signal) => {
        cleanup();
        child = undefined;
        const outcome = code === 0 ? 'finished' : signal ? `stopped (${signal})` : `failed with exit code ${code}`;
        write(`\n${tool} ${outcome}.\n`);
      });
    },
    handleInput: (data) => {
      if (data === '\x03' && child) {
        // A second Ctrl+C kills a tool that did not react to the first.
        child.kill(interrupted ? 'SIGKILL' : 'SIGINT');
        interrupted = true;
      }
    },
    close: () => {
      child?.kill();
      forceKillLater();
      cleanup();
      output.dispose();
    }
  };

  vscode.window.createTerminal({ name, pty, location: vscode.TerminalLocation.Editor }).show();
}
