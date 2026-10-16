import * as vscode from 'vscode';
import { run, runMongoshInside, which, type RunOptions } from '../process';

export interface KubeObject {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: unknown[];
    deletionTimestamp?: string;
  };
  spec?: Record<string, unknown>;
  status?: Record<string, unknown>;
  data?: Record<string, string>;
  [key: string]: unknown;
}

/** `kubectl` bound to one context and namespace. */
export class Kubectl {
  constructor(
    readonly context: string,
    readonly namespace: string
  ) {}

  static async available(): Promise<string | undefined> {
    return (await which('kubectl')) ? undefined : 'kubectl is not on PATH. Install it and configure a kubeconfig.';
  }

  static async contexts(): Promise<{ name: string; current: boolean; namespace?: string }[]> {
    const { stdout } = await run('kubectl', ['config', 'view', '-o', 'json'], { timeoutMs: 15_000 });
    const config = JSON.parse(stdout) as { 'current-context'?: string; contexts?: Array<{ name: string; context?: { namespace?: string } }> };
    return (config.contexts ?? []).map((c) => ({
      name: c.name,
      current: c.name === config['current-context'],
      namespace: c.context?.namespace
    }));
  }

  /** Is this context listed in `mongoCompass.kubernetes.protectedContexts`? */
  static isProtected(context: string): boolean {
    const patterns = vscode.workspace.getConfiguration('mongoCompass.kubernetes').get<string[]>('protectedContexts', ['*prod*']);
    return patterns.some((pattern) => {
      const regex = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
      return regex.test(context);
    });
  }

  base(): string[] {
    return ['--context', this.context, '-n', this.namespace];
  }

  run(args: string[], options: RunOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return run('kubectl', [...this.base(), ...args], { timeoutMs: 120_000, ...options });
  }

  async json<T = KubeObject>(args: string[], options: RunOptions = {}): Promise<T> {
    const { stdout } = await this.run([...args, '-o', 'json'], options);
    return JSON.parse(stdout) as T;
  }

  async get(kind: string, name: string): Promise<KubeObject | undefined> {
    try {
      return await this.json(['get', kind, name]);
    } catch (err) {
      if (/NotFound|not found/i.test((err as Error).message)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(kind: string, selector?: string): Promise<KubeObject[]> {
    const result = await this.json<{ items: KubeObject[] }>(['get', kind, ...(selector ? ['-l', selector] : [])]);
    return result.items ?? [];
  }

  /** Server-side apply of objects passed as JSON over stdin. */
  async apply(objects: KubeObject[], options: RunOptions = {}): Promise<void> {
    await this.run(['apply', '--server-side', '--force-conflicts', '--field-manager', 'mongo-compass', '-f', '-'], {
      ...options,
      input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: objects })
    });
  }

  async patch(kind: string, name: string, type: 'merge' | 'json', patch: unknown, options: RunOptions = {}): Promise<void> {
    await this.run(['patch', kind, name, '--type', type, '-p', JSON.stringify(patch)], options);
  }

  async delete(kind: string, nameOrSelector: string, options: RunOptions & { selector?: boolean; wait?: boolean } = {}): Promise<void> {
    const target = options.selector ? ['-l', nameOrSelector] : [nameOrSelector];
    await this.run(['delete', kind, ...target, '--ignore-not-found', `--wait=${options.wait ? 'true' : 'false'}`], options);
  }

  async secretValue(name: string, key: string): Promise<string | undefined> {
    const secret = await this.get('secret', name);
    const value = secret?.data?.[key];
    return value ? Buffer.from(value, 'base64').toString('utf8') : undefined;
  }

  async namespaces(): Promise<string[]> {
    const result = await run('kubectl', ['--context', this.context, 'get', 'namespaces', '-o', 'json'], { timeoutMs: 30_000 });
    return ((JSON.parse(result.stdout) as { items: KubeObject[] }).items ?? []).map((n) => n.metadata.name).sort();
  }

  async hasCrd(name: string): Promise<boolean> {
    try {
      await run('kubectl', ['--context', this.context, 'get', 'crd', name], { timeoutMs: 30_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Run a mongosh script in a pod container; see `runMongoshInside`. */
  mongosh<T = unknown>(pod: string, container: string, script: string, options: RunOptions = {}): Promise<T> {
    return runMongoshInside<T>(['kubectl', ...this.base(), 'exec', '-i', pod, '-c', container, '--'], script, { timeoutMs: 120_000, ...options });
  }
}
