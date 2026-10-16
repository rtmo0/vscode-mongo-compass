import { MongoClient, type Document } from 'mongodb';
import type { NodeAdmin } from './managedCluster';
import { hostOf } from './managedCluster';
import type { DeploymentRecord, NodeLayout } from './types';

/**
 * Runs node commands from this machine with the Node driver over
 * `localhost:<port>`. Without credentials it relies on the localhost
 * exception, which only applies when the server sees a loopback client.
 */
export class DriverNodeAdmin implements NodeAdmin {
  async command(record: DeploymentRecord, node: NodeLayout, command: Document, options: { auth: boolean; password?: string; db?: string; timeoutMs?: number }): Promise<Document> {
    const user = options.auth && options.password ? record.spec.username : undefined;
    const auth = user ? `${encodeURIComponent(user)}:${encodeURIComponent(options.password as string)}@` : '';
    const uri = `mongodb://${auth}${hostOf(node)}/?directConnection=true${auth ? '&authSource=admin' : ''}`;
    const timeout = options.timeoutMs ?? 30_000;
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: Math.min(timeout, 10_000),
      connectTimeoutMS: Math.min(timeout, 10_000),
      socketTimeoutMS: timeout,
      appName: 'MongoDB Compass for VS Code (deploy)'
    });
    try {
      await client.connect();
      return await client.db(options.db ?? 'admin').command(command);
    } finally {
      await client.close(true).catch(() => undefined);
    }
  }
}
