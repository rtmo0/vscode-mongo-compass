# MongoDB Compass for VS Code

An independent MongoDB GUI for VS Code: connections, document browsing with a query bar, CRUD, an aggregation pipeline builder with live preview, index management, schema analysis, explain plans, validation rules, import/export, server stats and query history.

> This community extension is not affiliated with, endorsed by, or sponsored by MongoDB, Inc. MongoDB and MongoDB Compass are trademarks of MongoDB, Inc.

Built on the official [`mongodb`](https://www.npmjs.com/package/mongodb) Node driver and [`bson`](https://www.npmjs.com/package/bson).

## Features

### Connections (Compass `connection-form` / `connection-storage`)
- Add / edit / duplicate / remove saved connections
- Connect with a URI directly
- Credentials stored securely in the OS keychain via VS Code `SecretStorage`
- Advanced options: read preference, server selection timeout, notes, color
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
- Shell-style BSON parsing: `ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`, etc.
- List / Table / JSON view modes
- Pagination with matched/total counts and timing
- Insert / edit / clone / delete documents
- Explain plan for the current query
- Save query to "My Queries", export query to language, copy as mongosh snippet
- Query cancellation

### Aggregation Pipeline Builder (Compass `compass-aggregations`)
- Stage-by-stage editor with enable/disable, reorder, duplicate, delete
- Live per-stage preview + auto-preview
- Stage catalogue with templates ($match, $group, $lookup, $search, $vectorSearch, $out, $merge, …)
- Run / count / explain the whole pipeline
- $out / $merge safety warning
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
- Export collection to **JSON / JSON Lines / CSV** (with filter, flattening)
- Import **JSON / JSONL / CSV** with insert/upsert, type inference, progress, cancellation

### Server tools (Compass `compass-serverstats`)
- Server status (connections, opcounters, memory, uptime)
- Current operations with **killOp**
- Run raw database commands
- Query history (find / aggregate / explain / command) with re-open
- My Queries: saved queries & pipelines

### Export to Language (Compass `compass-export-to-language`)
- mongosh, JavaScript, TypeScript, Python, Java, C#, Go, PHP, Ruby, Rust, Compass

## Getting started

### Requirements

- VS Code 1.85 or newer.
- A reachable MongoDB deployment. Standalone servers, replica sets, sharded clusters and MongoDB Atlas are supported by the official Node.js driver.
- `mongosh` and `mongorestore` must be installed separately and available on `PATH` for the corresponding commands.

```bash
npm install
npm run build      # or: npm run watch
```

Press **F5** in VS Code to launch the Extension Development Host.

1. Click the **MongoDB** icon in the Activity Bar.
2. **Add Connection** (or *Connect with URI*), e.g. `mongodb://localhost:27017`.
3. Expand a connection → databases → collections.
4. Click a collection to open the **Documents** view, or use the context menu for Aggregation / Indexes / Schema / Validation / Explain / Export.

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
| `mongoCompass.exportBatchSize` | `1000` | Export/import batch size |
| `mongoCompass.autoPreviewPipeline` | `true` | Auto re-run aggregation preview |

## Architecture

```
src/
  core/            # driver-agnostic services (mirrors Compass packages)
    connectionManager.ts   # compass-connections
    connectionStore.ts     # connection-storage (SecretStorage)
    dataService.ts         # mongodb-data-service
    bsonParser.ts          # mongodb-query-parser (shell syntax)
    schemaAnalyzer.ts      # mongodb-schema
    explainHelper.ts       # explain-plan-helper
    exportToLanguage.ts    # bson-transpilers / export-to-language
    importExport.ts        # compass-import-export
    queryHistory.ts        # recent queries
    myQueries.ts           # my-queries-storage
    config.ts, logger.ts, types.ts
  explorer/        # TreeView (sidebar navigation)
  webviews/        # webview panels
    baseWebview.ts         # shared panel infra (CSP, messaging)
    documentsPanel.ts      # compass-crud
    aggregationPanel.ts    # compass-aggregations
    dataPanel.ts           # indexes/schema/validation/explain/stats/history/…
    documents/, aggregation/, dataview/   # webview front-ends
    shared/                # shared CSS + client helpers
  commands/        # connection form
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
- Query history and saved queries are stored locally in VS Code global storage.
- The extension does not include telemetry or send database contents to an external service.
- Database queries and commands are sent only to the MongoDB deployment selected by the user.
- Review the target database before using destructive operations such as drop, delete, restore, `$out` or `$merge`.

## Support

Report defects through the repository issue tracker. Include the extension version, VS Code version, MongoDB server version and relevant output from **MongoDB: Show Output Channel**. Do not include credentials or unredacted connection strings.

## Notes & limitations

- This is an independent implementation inspired by MongoDB Compass; it is not affiliated with MongoDB, Inc.
- Atlas Search indexes require an Atlas deployment.
- The webview editors use plain textareas with EJSON/shell syntax (no CodeMirror autocompletion as in Compass).
- Data modeling diagrams, the embedded mongosh, and the GenAI assistant from Compass are out of scope.

## License

MIT
