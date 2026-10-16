# MongoDB Compass for VS Code

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/rtmo0)

An independent MongoDB GUI for VS Code: connections, document browsing with a query bar, CRUD, an aggregation pipeline editor and visual stage builder with `$lookup` / `$graphLookup` forms, context-aware autocomplete, index management, schema analysis, explain plans, validation rules, import/export, server stats and query history.

It also deploys and operates MongoDB: create standalone servers, replica sets and sharded clusters on **Docker**, as **local processes**, on **Kubernetes** (Percona Operator, MongoDB Community operator or a plain StatefulSet) or in **MongoDB Atlas**; see the cluster topology; add and remove members, shards and routers; change the primary; shard collections; and run rolling restarts and upgrades — with safety checks before every topology change.

> This community extension is not affiliated with, endorsed by, or sponsored by MongoDB, Inc. MongoDB and MongoDB Compass are trademarks of MongoDB, Inc.

Built on the official [`mongodb`](https://www.npmjs.com/package/mongodb) Node driver and [`bson`](https://www.npmjs.com/package/bson).

## Features

### Connections (Compass `connection-form` / `connection-storage`)
- Add / edit / duplicate / remove saved connections
- Connect with a URI directly
- Credentials stored securely in the OS keychain via VS Code `SecretStorage`
- Advanced options: read preference, authentication method, server selection timeout, notes, color
- **OIDC** sign-in (`authMechanism=MONGODB-OIDC`), as in Compass and mongosh: the identity provider's page opens in your browser, and the tokens are kept in the OS keychain and refreshed, so later sessions don't ask again. Connections to hosts other than Atlas or localhost must be marked as trusted. With `ENVIRONMENT:azure|gcp|k8s` the driver gets a workload token on its own. **MongoDB: Forget OIDC Sign-in** signs out. Needs a VS Code whose extension host runs Node.js 20 or later
- Options in the connection string (`readPreference`, `directConnection`, `serverSelectionTimeoutMS`, …) are respected; the extension settings only fill in what the URI leaves out
- Topology detection (standalone / replica set / sharded / Atlas), server version
- Status bar indicator for the active connection

### Explorer (Compass sidebar / `compass-connections-navigation`)
- Connections → Databases → Collections / Views → Indexes / Search Indexes tree
- Create / drop databases and collections, create views (incl. time-series)
- Rename / duplicate / drop collections
- Database & collection stats
- Inline connect / disconnect / refresh

### Documents (Compass `compass-crud` + `compass-query-bar`)
- Query bar: **filter, project, sort, collation, skip, limit, maxTimeMS**
- Shell-style BSON parsing: `ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`, `new Int32(…)`, regex literals, etc.
- **Autocomplete** in Filter / Project / Sort (opens while typing or with <kbd>Ctrl</kbd>+<kbd>Space</kbd>):
  - field names sampled from the collection, with their BSON types
  - query operators (`$gt`, `$in`, `$elemMatch`, `$regex`, …) inserted as snippets
  - type-aware values right after a field is picked: strings → `"…"`, regex, `$in`; numbers → comparisons and ranges; dates → `ISODate("…")` and date ranges; ObjectIds → `ObjectId("…")`; arrays → element values, `$elemMatch`, `$size`, `$all`
  - projection values (`1` / `0`, `$slice` and `$elemMatch` for arrays) and sort directions
- **Syntax highlighting** in the query bar and every editor
- **Reset** restores the query bar to the configured defaults and runs Find
- List / Table / JSON view modes
- Pagination with matched/total counts and timing
- Insert / edit / clone / delete documents
- Explain plan for the current query
- Save query to "My Queries", export query to language, copy as mongosh snippet
- Query cancellation (keeps the previous results; a timeout is reported as exceeding Max Time MS)

### Aggregation Pipeline Builder (Compass `compass-aggregations`)
- Two editing modes, switchable at any time with **Text | Builder**; both edit the same pipeline
- **Text mode**: pipeline editor with syntax highlighting and context-aware autocomplete
  - stages, their options (`$lookup.from`, `$unwind.path`, …), accumulators in `$group`, 60+ expression operators
  - `"$field"` references and `$$ROOT` / `$$NOW` system variables
  - field names *as they arrive at the current stage*: after a `$group` or `$project` you get its output fields, not the collection's
  - nested pipelines in `$lookup`, `$unionWith` and `$facet` are understood; picking a stage after an existing operator starts a new stage
- **Builder mode**: one card per stage — change the operator, move, duplicate, delete, and show the **output of each stage** (first 5 documents)
  - **`$lookup` form**: pick the collection, choose Equality (`localField` / `foreignField`), Pipeline (`let` + sub-pipeline) or Both; field pickers for local and joined fields; one-click `$unwind` of the result
  - **`$graphLookup` form**: `from`, `startWith`, `connectFromField` / `connectToField` pickers, `as`, `maxDepth`, `depthField`, `restrictSearchWithMatch`
  - every other stage gets a body editor with the same autocomplete as Text mode
- Stage catalogue with templates ($match, $group, $lookup, $graphLookup, $facet, $setWindowFields, $search, $vectorSearch, $out, $merge, …)
- Run / count / explain the whole pipeline, with cancellation
- $out / $merge safety warning; previews and field discovery never execute them
- Save pipeline, create a view from the pipeline
- Export pipeline to language / mongosh

### Indexes (Compass `compass-indexes`)
- List regular + Atlas Search indexes with properties
- Create / drop indexes (keys + options)
- Create / drop search indexes

### Schema (Compass `compass-schema`)
- Sample-based schema analysis: field paths, presence %, type distribution
- Uniqueness, string length and numeric range statistics
- Nested document / array field analysis
- Indexing & mixed-type insights

### Validation (Compass `compass-schema-validation`)
- View / edit `$jsonSchema` (or any) validator
- Validation level & action

### Explain Plan (Compass `compass-explain-plan`)
- Flattened winning-plan tree with stage descriptions
- Execution stats
- Performance insights (COLLSCAN, SORT, EOFSORT, covered queries, examine/return ratio)

### Import / Export (Compass `compass-import-export`)
- Export and import complete databases as compressed **mongodump archives**
- Export and import individual collections through **mongodump / mongorestore**
- Export Documents results matching the current filter to **JSON / JSON Lines / CSV**
- Export the current aggregation pipeline results to **JSON / JSON Lines / CSV**

### Server tools (Compass `compass-serverstats`)
- Server status (connections, opcounters, memory, uptime)
- Current operations with **killOp**
- Run raw database commands
- Query history (find / aggregate / explain / command) with re-open
- My Queries: saved queries & pipelines

### Cluster administration (Cluster view + Cluster Overview panel)
- **Topology** of every connected deployment: replica set members with state, health, replication lag, priority / votes / hidden / delay / tags, sync source and oplog window; for sharded clusters the routers, config server replica set, every shard's members, the balancer and the sharded collections
- **Elections**: step down the primary, **make any secondary primary** (other secondaries are frozen and the primary steps down — the config is not touched; falls back to a temporary priority takeover when members are not reachable directly), freeze / unfreeze, maintenance mode, sync from
- **Membership** through `replSetReconfig`: add a secondary, hidden, delayed, non-voting member or arbiter; remove members; change priority, votes, hidden, delay and tags; edit the full config in the panel
- **Safety checks** before every reconfig: majority still reachable, one voting change at a time, hidden / delayed / arbiter members with priority 0, at most 7 voters, even-voter and PSA warnings. A change that fails a check is not applied (forced reconfig only from the config editor, explicitly)
- **Sharding**: shard a collection (hashed or ranged, creating the index if needed), reshard, refine the shard key, `analyzeShardKey`, unshard / move collections (8.0), add / drain / remove shards (with `movePrimary` of their databases), chunk and data distribution per shard, per-collection balancing, balancer start / stop / window, zones and zone key ranges, `moveRange`, split
- **Settings**: featureCompatibilityVersion, cluster-wide default write concern, database profiler (level / slowms, browse `system.profile`), oplog browser
- **Users & roles**: list users across databases, create / drop users, change passwords, grant / revoke roles
- **Per member**: `serverStatus`, recent log lines, mongosh straight to the member
- **Monitoring**: background checks report elections, members going down or coming back, and secondaries falling behind; a status bar item shows healthy / total members of the active cluster

### Deployments (Deployments view)
Create MongoDB from VS Code, see what runs where, and operate it. Every deployment gets a saved connection, so the explorer, the cluster view and all data tools work on it immediately.

| | Docker | Local processes | Kubernetes | MongoDB Atlas |
| --- | --- | --- | --- | --- |
| Standalone / replica set / sharded | ✔ / ✔ / ✔ | ✔ / ✔ / ✔ | StatefulSet: standalone, replica set · Percona Operator: replica set, sharded · MongoDB Community: replica set | M0, Flex, dedicated replica set / sharded |
| Add / remove members, scale | ✔ (any member type) | ✔ | ✔ (through the operator, or the extension for StatefulSets) | node count 3 / 5 / 7 |
| Add / remove shards and routers | ✔ (shard draining included) | ✔ | Percona | shards |
| Start / stop | ✔ | ✔ | Percona (pause), StatefulSet (scale to 0) | pause / resume (M10+) |
| Restart node, rolling restart | ✔ | ✔ | ✔ (pod deletion) | — |
| Upgrade | rolling, node by node | rolling, from a new binaries folder | through the resource | major version |
| Failure simulation | kill, freeze (pause) | kill, freeze (SIGSTOP) | kill pod | test failover |
| Logs, shell, describe | ✔ | ✔ | ✔ | logs download, process info |
| Export | docker-compose with an init service | bash script | resource YAML | API request body |

- **Docker**: members share one network namespace, each mongod on its own port published on `127.0.0.1`, so the replica set config uses `localhost:<port>` and drivers can discover members and fail over from this machine. Authentication uses a generated keyfile and admin password (OS keychain)
- **Kubernetes**: pick a kubectl context and namespace; the Percona Operator (1.22) or MongoDB Controllers for Kubernetes are installed on demand. Connections go through `kubectl port-forward` (restarted automatically); members are reachable for the cluster view through per-pod forwards. Existing Percona / MongoDBCommunity resources and mongo StatefulSets can be **attached**. Contexts matching `mongoCompass.kubernetes.protectedContexts` (default `*prod*`) require typing the context name before any change
- **Atlas**: sign in with a service account or an API key; create clusters (with a database user and an IP access list entry) or import existing ones
- **Rolling operations** follow MongoDB's order: config servers, then shards, then routers; secondaries one at a time (waiting until healthy and caught up), then the primary after a step-down; the balancer is paused meanwhile
- Back up a deployment with mongodump (`--oplog` on replica sets), copy its password or connection string, forget it without deleting anything, or destroy it (keeping data if you like)

### Export to Language (Compass `compass-export-to-language`)
- mongosh, JavaScript, TypeScript, Python, Java, C#, Go, PHP, Ruby, Rust, Compass

## Getting started

### Requirements

- VS Code 1.85 or newer.
- A reachable MongoDB deployment. Standalone servers, replica sets, sharded clusters and MongoDB Atlas are supported by the official Node.js driver.
- `mongosh`, `mongodump`, and `mongorestore` must be installed separately and available on `PATH` for the corresponding commands. `mongodump` / `mongorestore` require MongoDB Database Tools 100.3.0 or newer.
- Deployments need, depending on the target: Docker (Docker Desktop or Engine), `mongod` / `mongos` on `PATH` or in `mongoCompass.local.binDir`, `kubectl` with a kubeconfig (plus `helm` for the MongoDB Community operator), or an Atlas service account / API key.
- Cluster administration needs a user with `clusterManager` / `clusterAdmin` (sharding commands: `clusterManager` on a mongos).

```bash
npm install
npm run build      # or: npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host.

1. Click the **MongoDB** icon in the Activity Bar.
2. **Add Connection** (or *Connect with URI*), e.g. `mongodb://localhost:27017`.
3. Expand a connection → databases → collections.
4. Click a collection to open the **Documents** view, or use the context menu for Aggregation / Indexes / Schema / Validation / Explain / Export.

### Deploy a cluster

1. In the **Deployments** view click **New Deployment** (`+`).
2. Choose where it runs (Docker, local processes, Kubernetes or Atlas), the topology (standalone, replica set or sharded), the version and the number of members, shards and routers.
3. When it is ready, choose **Connect & show cluster**: the deployment appears under **Connections**, its topology under **Cluster**, and the **Cluster Overview** panel opens.
4. Manage it from the context menus: add or remove members and shards, make a member primary, restart nodes, simulate failures, run a rolling upgrade, export it as docker-compose / YAML, or destroy it.

Existing clusters work too: connect to them as usual to use the **Cluster** view, attach Kubernetes deployments with **Attach Kubernetes Deployment**, or import Atlas clusters with **Import Atlas Clusters**.

## Configuration

| Setting | Default | Description |
| --- | --- | --- |
| `mongoCompass.defaultLimit` | `20` | Page size for the documents view |
| `mongoCompass.maxTimeMS` | `60000` | Server-side query time limit |
| `mongoCompass.resultView` | `list` | Default documents view mode |
| `mongoCompass.schemaSampleSize` | `1000` | Documents sampled for schema analysis |
| `mongoCompass.confirmDangerousOperations` | `true` | Confirm drops/deletes |
| `mongoCompass.queryHistoryLimit` | `200` | Max history entries |
| `mongoCompass.hideSystemDatabases` | `false` | Hide admin/local/config |
| `mongoCompass.showSystemCollections` | `true` | Show `system.*` collections |
| `mongoCompass.readPreference` | `primary` | Default read preference |
| `mongoCompass.connectionTimeoutMS` | `30000` | Server selection timeout |
| `mongoCompass.oidc.deviceAuthFlow` | `false` | Allow OIDC sign-in with a code on another device (Remote SSH, WSL, containers, Codespaces) |
| `mongoCompass.oidc.redirectURI` | `""` | Redirect URI registered with the identity provider (default `http://localhost:27097/redirect`) |
| `mongoCompass.exportBatchSize` | `1000` | Export batch size |
| `mongoCompass.autoPreviewPipeline` | `true` | Auto re-run aggregation preview |
| `mongoCompass.cluster.monitorIntervalSeconds` | `30` | Health checks of connected clusters (0 = off) |
| `mongoCompass.cluster.lagWarningSeconds` | `30` | Replication lag that triggers a warning |
| `mongoCompass.cluster.notifications` | `true` | Notify about elections, members down / back, lag |
| `mongoCompass.deployments.refreshIntervalSeconds` | `15` | Deployments view refresh while visible (0 = off) |
| `mongoCompass.local.binDir` | `""` | Folder with `mongod` / `mongos` for local deployments |
| `mongoCompass.kubernetes.protectedContexts` | `["*prod*"]` | Contexts where changes require typing the context name |
| `mongoCompass.kubernetes.perconaOperatorVersion` | `1.22.0` | Percona Operator version installed / used as `crVersion` |
| `mongoCompass.kubernetes.communityOperatorChart` | `mongodb/mongodb-kubernetes` | Helm chart for MongoDBCommunity resources |

## Architecture

```
src/
  core/            # driver-agnostic services (mirrors Compass packages)
    connectionManager.ts   # compass-connections
    connectionStore.ts     # connection-storage (SecretStorage)
    dataService.ts         # mongodb-data-service
    bsonParser.ts          # mongodb-query-parser (shell syntax)
    shellFormat.ts         # BSON → mongosh source (lossless round-trip with bsonParser)
    fieldPaths.ts          # field paths + types sampled for autocomplete
    schemaAnalyzer.ts      # mongodb-schema
    explainHelper.ts       # explain-plan-helper
    exportToLanguage.ts    # bson-transpilers / export-to-language
    importExport.ts        # compass-import-export
    queryHistory.ts        # recent queries
    myQueries.ts           # my-queries-storage
    config.ts, logger.ts, types.ts
    cluster/
      clusterService.ts    # topology, elections, reconfig, sharding, balancer, zones, users, profiler
      safety.ts            # replica set config / majority checks before replSetReconfig
      nodeClients.ts       # direct connections to single members (+ host / credential resolvers)
      clusterMonitor.ts    # background health checks, election / lag notifications, status bar
  deploy/
    types.ts               # DeploymentProvider interface, specs, records
    registry.ts            # deployments, passwords (SecretStorage), saved connections
    managedCluster.ts      # bootstrap / membership / shards for localhost:<port> layouts
    rolling.ts             # rolling restart / upgrade orchestration
    docker/, local/        # Docker containers, local mongod processes
    kubernetes/            # kubectl, port-forwards, Percona / Community / StatefulSet manifests
    atlas/                 # Atlas Admin API v2 client (service account / API key) and provider
  explorer/        # TreeView (sidebar navigation): connections, cluster, deployments, tools
  webviews/        # webview panels
    baseWebview.ts         # shared panel infra (CSP, messaging)
    documentsPanel.ts      # compass-crud
    aggregationPanel.ts    # compass-aggregations
    dataPanel.ts           # indexes/schema/validation/explain/stats/history/…
    clusterPanel.ts        # cluster overview: topology, members, sharding, users, config editor
    documents/, aggregation/, dataview/   # webview front-ends
    aggregation/builder.ts # visual pipeline builder ($lookup / $graphLookup forms)
    shared/                # shared CSS + client helpers (highlighting, autocomplete)
  commands/        # connection form, cluster and deployment commands (incl. the deployment wizard)
  extension.ts     # activation + command registration
```

## Packaging

```bash
npm ci
npm run package    # produces mongo-compass-<version>.vsix
```

Install the resulting file with **Extensions: Install from VSIX...** before publishing it.

## Security and privacy

- Connection strings are stored in VS Code `SecretStorage`, backed by the operating system credential store.
- OIDC tokens are stored in `SecretStorage` per connection and deleted with the connection, when its connection string changes, or with **Forget OIDC Sign-in**. They are sent only to Atlas, localhost, or the hosts of a connection you marked as trusted.
- Query history and saved queries are stored locally in VS Code global storage.
- The extension does not include telemetry or send database contents to an external service.
- Database queries and commands are sent only to the MongoDB deployment selected by the user.
- Review the target database before using destructive operations such as drop, delete, restore, `$out` or `$merge`.
- Deployment admin passwords and Atlas credentials are stored in SecretStorage. Keyfiles and passwords reach containers and pods over stdin, never as command-line arguments; Docker ports are published on `127.0.0.1` only.
- Kubernetes changes in contexts matching `mongoCompass.kubernetes.protectedContexts` need the context name typed; deleting a deployment the extension did not create needs its name typed.

## Support

Report defects through the repository issue tracker. Include the extension version, VS Code version, MongoDB server version and relevant output from **MongoDB: Show Output Channel**. Do not include credentials or unredacted connection strings.

If the extension saves you time, you can support its development on [Buy Me a Coffee](https://buymeacoffee.com/rtmo0).

## Notes & limitations

- This is an independent implementation inspired by MongoDB Compass; it is not affiliated with MongoDB, Inc.
- Atlas Search indexes require an Atlas deployment.
- The webview editors are lightweight textareas with their own highlighting and autocomplete rather than a full code editor; colours follow the VS Code theme's debug / symbol colours because webviews cannot read the editor's token theme.
- Autocomplete field names come from a sample of 100 documents, so rarely used fields may be missing. Collection names are not suggested inside `$lookup.from` in Text mode (the Builder form lists them).
- Editing a pipeline in Builder mode reformats its text and drops comments.
- Data modeling diagrams, the embedded mongosh, and the GenAI assistant from Compass are out of scope.
- Kubernetes replica sets are reached through a port-forward to the primary with `directConnection=true`; after a failover, reconnect to follow the new primary. Sharded clusters go through the mongos service.
- With an operator (Percona, MongoDB Community) membership changes go through the custom resource — the operator would revert a manual `replSetReconfig`. Kubernetes removes the highest pod ordinal when scaling down.
- Local-process deployments keep running when VS Code closes; stop or destroy them from the Deployments view.
- Atlas M0 / Flex clusters can not be paused, scaled or failed over through the API.

## License

MIT
