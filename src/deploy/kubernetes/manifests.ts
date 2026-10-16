import type { DeploymentRecord, KubernetesSpec } from '../types';
import type { KubeObject } from './kubectl';

export const MANAGED_BY = { 'app.kubernetes.io/managed-by': 'mongo-compass' };
export const PERCONA_CR_VERSION_DEFAULT = '1.22.0';
/** Required by the CRD even with backups disabled (matches deploy/cr.yaml of operator 1.22.0). */
const PERCONA_BACKUP_IMAGE = 'percona/percona-backup-mongodb:2.12.0';

function k8s(record: DeploymentRecord): KubernetesSpec {
  if (!record.spec.kubernetes) {
    throw new Error('Kubernetes settings are missing.');
  }
  return record.spec.kubernetes;
}

function volumeClaim(spec: KubernetesSpec): Record<string, unknown> {
  return {
    ...(spec.storageClass ? { storageClassName: spec.storageClass } : {}),
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: spec.storageSize } }
  };
}

function secret(name: string, namespace: string, data: Record<string, string>): KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name, namespace, labels: MANAGED_BY },
    type: 'Opaque',
    stringData: data
  };
}

/** Name of the secret holding the admin password the extension created. */
export function rootSecretName(record: DeploymentRecord): string {
  return `${k8s(record).resourceName}-mongo-compass-root`;
}

// ───────────────────────────── Percona Operator ─────────────────────────────

export function perconaShardNames(record: DeploymentRecord): string[] {
  const count = record.spec.topology === 'sharded' ? record.spec.shards : 1;
  return Array.from({ length: count }, (_, i) => `rs${i}`);
}

export function perconaReplset(record: DeploymentRecord, name: string): Record<string, unknown> {
  const spec = k8s(record);
  return {
    name,
    size: record.spec.members,
    ...(record.spec.arbiter ? { arbiter: { enabled: true, size: 1 } } : {}),
    volumeSpec: { persistentVolumeClaim: volumeClaim(spec) }
  };
}

/** `PerconaServerMongoDB` CR plus the secret for the extension's admin user. */
export function perconaManifests(record: DeploymentRecord, password: string, crVersion: string): KubeObject[] {
  const spec = k8s(record);
  const sharded = record.spec.topology === 'sharded';
  const small = record.spec.members < 3 || (sharded && record.spec.configServers < 3);
  const cr: KubeObject = {
    apiVersion: 'psmdb.percona.com/v1',
    kind: 'PerconaServerMongoDB',
    metadata: { name: spec.resourceName, namespace: spec.namespace, labels: MANAGED_BY },
    spec: {
      crVersion,
      image: spec.image ?? `percona/percona-server-mongodb:${record.spec.version}`,
      updateStrategy: 'SmartUpdate',
      upgradeOptions: { apply: 'disabled' },
      // Port-forwarded connections from VS Code are plain TCP; enable TLS in the CR for production use.
      tls: { mode: 'disabled' },
      unsafeFlags: {
        tls: true,
        ...(small ? { replsetSize: true } : {}),
        ...(sharded && record.spec.routers < 2 ? { mongosSize: true } : {})
      },
      secrets: { users: `${spec.resourceName}-secrets` },
      users: [
        {
          name: record.spec.username,
          db: 'admin',
          passwordSecretRef: { name: rootSecretName(record), key: 'password' },
          roles: [{ name: 'root', db: 'admin' }]
        }
      ],
      replsets: perconaShardNames(record).map((name) => perconaReplset(record, name)),
      sharding: sharded
        ? {
            enabled: true,
            configsvrReplSet: { size: record.spec.configServers, volumeSpec: { persistentVolumeClaim: volumeClaim(spec) } },
            mongos: { size: record.spec.routers }
          }
        : { enabled: false },
      backup: { enabled: false, image: PERCONA_BACKUP_IMAGE }
    }
  };
  return [secret(rootSecretName(record), spec.namespace, { password }), cr];
}

export function perconaBundleUrl(version: string): string {
  return `https://raw.githubusercontent.com/percona/percona-server-mongodb-operator/v${version}/deploy/bundle.yaml`;
}

// ───────────────────────────── MongoDB Community (MCK) ─────────────────────────────

/** `MongoDBCommunity` CR plus its admin password secret. */
export function communityManifests(record: DeploymentRecord, password: string): KubeObject[] {
  const spec = k8s(record);
  const passwordSecret = rootSecretName(record);
  const cr: KubeObject = {
    apiVersion: 'mongodbcommunity.mongodb.com/v1',
    kind: 'MongoDBCommunity',
    metadata: { name: spec.resourceName, namespace: spec.namespace, labels: MANAGED_BY },
    spec: {
      members: record.spec.members,
      ...(record.spec.arbiter ? { arbiters: 1 } : {}),
      type: 'ReplicaSet',
      version: record.spec.version,
      security: { authentication: { modes: ['SCRAM'] } },
      users: [
        {
          name: record.spec.username,
          db: 'admin',
          passwordSecretRef: { name: passwordSecret, key: 'password' },
          roles: [
            { name: 'root', db: 'admin' },
            { name: 'clusterAdmin', db: 'admin' }
          ],
          scramCredentialsSecretName: `${spec.resourceName}-${record.spec.username}`.toLowerCase()
        }
      ],
      statefulSet: {
        spec: {
          volumeClaimTemplates: [{ metadata: { name: 'data-volume' }, spec: volumeClaim(spec) }]
        }
      }
    }
  };
  return [secret(passwordSecret, spec.namespace, { password }), cr];
}

// ───────────────────────────── plain StatefulSet ─────────────────────────────

export function statefulSetLabels(record: DeploymentRecord): Record<string, string> {
  return {
    'app.kubernetes.io/name': 'mongodb',
    'app.kubernetes.io/instance': k8s(record).resourceName,
    ...MANAGED_BY
  };
}

/** Pod DNS name of member `i` of the StatefulSet. */
export function statefulSetHost(record: DeploymentRecord, index: number): string {
  const spec = k8s(record);
  return `${spec.resourceName}-${index}.${spec.serviceName ?? spec.resourceName}.${spec.namespace}.svc.cluster.local:27017`;
}

/**
 * A headless Service and a StatefulSet running the official `mongo` image.
 * An init container copies the keyfile from the Secret with the strict
 * permissions mongod requires.
 */
export function statefulSetManifests(record: DeploymentRecord, password: string | undefined, keyfile: string | undefined): KubeObject[] {
  const spec = k8s(record);
  const labels = statefulSetLabels(record);
  const replicaSet = record.spec.topology === 'replicaSet';
  const auth = record.spec.auth && keyfile;
  const args = ['mongod', '--bind_ip_all', '--port', '27017', ...(replicaSet ? ['--replSet', 'rs0'] : []), ...(auth ? ['--keyFile', '/keys/keyfile'] : [])];
  const objects: KubeObject[] = [];
  if (auth) {
    objects.push(secret(`${spec.resourceName}-auth`, spec.namespace, { keyfile, password: password ?? '' }));
  }
  objects.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name: spec.resourceName, namespace: spec.namespace, labels },
    spec: {
      clusterIP: 'None',
      publishNotReadyAddresses: true,
      selector: labels,
      ports: [{ name: 'mongodb', port: 27017, targetPort: 27017 }]
    }
  });
  objects.push({
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: spec.resourceName, namespace: spec.namespace, labels },
    spec: {
      serviceName: spec.resourceName,
      replicas: replicaSet ? record.spec.members : 1,
      podManagementPolicy: 'Parallel',
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          terminationGracePeriodSeconds: 30,
          ...(auth
            ? {
                initContainers: [
                  {
                    name: 'keyfile',
                    image: spec.image ?? `mongo:${record.spec.version}`,
                    command: ['sh', '-c', 'cp /secret/keyfile /keys/keyfile && chmod 400 /keys/keyfile && chown 999:999 /keys/keyfile'],
                    securityContext: { runAsUser: 0 },
                    volumeMounts: [
                      { name: 'secret', mountPath: '/secret', readOnly: true },
                      { name: 'keys', mountPath: '/keys' }
                    ]
                  }
                ]
              }
            : {}),
          containers: [
            {
              name: 'mongod',
              image: spec.image ?? `mongo:${record.spec.version}`,
              args,
              ports: [{ name: 'mongodb', containerPort: 27017 }],
              readinessProbe: {
                exec: { command: ['mongosh', '--quiet', '--eval', 'db.adminCommand({ping: 1})'] },
                initialDelaySeconds: 5,
                periodSeconds: 10,
                timeoutSeconds: 5
              },
              volumeMounts: [
                { name: 'data', mountPath: '/data/db' },
                ...(auth ? [{ name: 'keys', mountPath: '/keys' }] : [])
              ]
            }
          ],
          volumes: auth
            ? [
                { name: 'secret', secret: { secretName: `${spec.resourceName}-auth`, items: [{ key: 'keyfile', path: 'keyfile' }] } },
                { name: 'keys', emptyDir: {} }
              ]
            : []
        }
      },
      volumeClaimTemplates: [{ metadata: { name: 'data' }, spec: volumeClaim(spec) }]
    }
  });
  return objects;
}
