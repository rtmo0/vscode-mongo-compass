# Changelog

All notable changes to this extension are documented in this file.

## 1.2.0 - 2026-10-16

### Added

- OIDC authentication (`authMechanism=MONGODB-OIDC`): sign in with your identity provider in the browser, as in Compass and mongosh. Tokens are kept per connection in the OS keychain and refreshed, member connections of the cluster views reuse them, and hosts other than Atlas or localhost must be marked as trusted. The Device Authorization flow can be enabled for remote windows. **MongoDB: Forget OIDC Sign-in** signs out.
- The connecting notification can be cancelled; that also stops an OIDC sign-in waiting for the browser.

### Changed

- Statistics, indexes and other data views load once instead of twice, and start querying while the panel is still opening.
- Database statistics read only the collection sizes (`$collStats` with a server-side projection), a few collections at a time and skipping views: on 300 collections the reply shrinks from about 32 MB to 53 KB.
- Performance metrics wait for each sample before asking for the next, pause while the tab is hidden, and skip the serverStatus sections they don't show (about half of the reply).
- Raw JSON of serverStatus and collection stats is rendered when expanded, not with the view.
- Cluster overview reads the replica set status, config, oplog, shards and config servers in parallel; the Cluster view and the dashboard share one read; the Cluster view reloads only when a health check sees a change instead of every 30 seconds; the dashboard's auto-refresh pauses while hidden; an unreachable member no longer costs a timeout on every refresh.
- Connecting reads `buildInfo` and `hello` in parallel.

## 1.1.0 - 2026-10-16

### Added

- **Cluster** view and **Cluster Overview** panel: replica set members with state, lag, priority / votes / hidden / delay and oplog window; routers, config servers, shards, balancer and sharded collections of sharded clusters.
- Elections and membership: step down, make a chosen secondary primary, freeze, maintenance mode, sync from, add / remove members (secondary, hidden, delayed, non-voting, arbiter), member settings, and a replica set config editor — all with safety checks (majority, one voting change at a time, priority rules).
- Sharding: shard / reshard / unshard / move collections, refine and analyze shard keys, add / drain / remove shards, movePrimary, balancer control and window, per-collection balancing, zones and zone ranges, moveRange, split, chunk and data distribution.
- Users and roles, featureCompatibilityVersion, default write concern, database profiler and oplog browser.
- Background cluster monitoring with notifications for elections, members going down / recovering and replication lag, and a health item in the status bar.
- **Deployments** view: create standalone servers, replica sets and sharded clusters on Docker, as local processes, on Kubernetes (Percona Operator, MongoDB Community, plain StatefulSet) or in MongoDB Atlas; attach existing Kubernetes deployments and import Atlas clusters.
- Deployment operations: start / stop, add / remove members, scale, add / remove shards and routers, restart nodes, rolling restart, rolling upgrade, failover, failure simulation (kill / freeze), logs, mongosh, describe, export (docker-compose, script, YAML, API body), mongodump backup, copy password / connection string, destroy.

### Fixed

- Sharded clusters were reported with the topology `isdbgrid`; they now show as `sharded`.
- Atlas deployments were not recognised as Atlas, because the host name check did not allow the port.

## 1.0.0 - 2026-10-14

### Changed

- First stable release: the extension is no longer marked as Preview.
- Query bar, pipeline and other shell-syntax inputs are now parsed and evaluated safely instead of being run as JavaScript. Literals, objects, arrays, arithmetic, BSON helpers (`ObjectId`, `ISODate`, `NumberLong`, …) and a few static methods such as `Date.now()` and `Math.max()` are supported; anything else is rejected with an error.
- JSON / JSON Lines export writes canonical Extended JSON by default, so Int64, Int32 and Double values keep their types and precision when re-imported.
- mongosh, mongodump and mongorestore no longer receive the connection string on their command line, where other local users could read the password. mongodump / mongorestore get it through a temporary `--config` file (requires MongoDB Database Tools 100.3.0 or newer), and their output and exit status are shown in the terminal.

### Fixed

- `Date.now()`, `Date.UTC()` and other `Date` statics work in queries.
- Editing a document no longer turns Double values such as `3.0` and small Int64 values into Int32.
- Int64 values above 2^53 are no longer rounded on export.
- JSON / JSON Lines export of a large collection no longer holds the whole file in memory, and a file that cannot be written reports its error instead of crashing the extension host.
- Commands run from a tree item after the connection was closed reconnect instead of failing with "Cannot read properties of undefined".
- Opening several panels at once no longer creates (and leaks) one client per panel, Disconnect during a pending connect now cancels it, and a failed connect closes its client.
- Saving or connecting several connections at the same time no longer loses changes, and connecting no longer reads every saved connection string from the keychain.
- mongosh and the database tools work when the default terminal shell is fish.

## 0.8.0 - 2026-10-08

### Added

- Visual aggregation pipeline builder (**Text | Builder** toggle) with a card per stage, move / duplicate / delete, and the output of each stage.
- `$lookup` builder form: collection picker, Equality / Pipeline / Both join modes, local and joined field pickers, `let` and sub-pipeline editors, one-click `$unwind`.
- `$graphLookup` builder form: `from`, `startWith`, `connectFromField`, `connectToField`, `as`, `maxDepth`, `depthField` and `restrictSearchWithMatch`.
- Autocomplete in the Documents Filter / Project / Sort inputs: sampled field names with types, operators as snippets, and type-aware value suggestions right after a field is picked.
- Context-aware autocomplete in the aggregation editor: stages, stage options, accumulators, expression operators, `"$field"` references, and the fields produced by previous stages.
- Syntax highlighting in the Documents query bar inputs.
- **Reset** button in Documents that restores the query bar defaults and runs Find.

### Changed

- New syntax highlighter for JSON and mongosh syntax (single-quoted strings, field references, `$$` variables, regex literals, comments) with theme-aware colours in every editor and JSON view.
- Cancel in Documents and Aggregation keeps the previous results, reports the cancellation, and is enabled only while a query runs.
- Queries exceeding Max Time MS now report a clear timeout message instead of an empty result.
- Read preference and server selection timeout from the connection string take precedence over the extension settings.
- mongosh, mongodump and mongorestore terminals use PowerShell on Windows so their commands work there.
- A stage with more than one operator now names the operators and explains how to split it.

### Fixed

- Shell constructors such as `ObjectId("…")`, `Int32(…)`, `Long(…)`, `Binary(…)` and `Code(…)` failed with "Class constructor cannot be invoked without 'new'".
- Clearing the filter input kept applying the previous filter.
- `directConnection=true` in a connection string was ignored.
- Strings were not highlighted, and single quotes rendered as `&#39;` in editors.
- A cancelled aggregation could be reported as an error or recorded as successful, and responses from superseded runs could overwrite newer results.
- A webview reloaded during a query no longer shows a spinner forever.

## 0.7.0 - 2026-10-04

### Changed

- Collections are displayed directly under their database in the Explorer without an intermediate Collections node.
- Document and aggregation result views now share the same document-list rendering helpers.
- Simplified database and aggregation actions by removing redundant command and shell buttons.

## 0.6.0 - 2026-10-02

### Added

- Copy-document buttons in the Aggregation pipeline's List and Table result views (matching the existing JSON view).

## 0.5.0 - 2026-10-02

### Added

- Copy-to-clipboard actions for individual documents in Documents and Aggregation JSON views.
- Live affected-document counts while editing Bulk Update and Bulk Delete filters.

### Changed

- Documents and aggregation JSON views now render canonical MongoDB Extended JSON while preserving the existing expandable styling.
- BSON dates in list and table views are displayed as readable `ISODate('…+00:00')` values.
- Insert Document now explicitly accepts JSON and MongoDB Extended JSON and normalizes ObjectId values.

### Fixed

- Insert Document now passes canonical Extended JSON values such as `$oid`, `$date`, `$numberInt`, and `$binary` to MongoDB as their BSON types.
- Insert errors now expose the underlying MongoDB error details.
- Successful inserts no longer trigger competing refreshes that could report `This operation was aborted`.
- Modal editors retain their entered value when the modal opens.

## 0.4.0 - 2026-10-01

### Added

- Compass-style Schema Validation: generate rules from schema analysis, add rules manually via the rule builder, edit validation level/action, and remove individual rules.
- Zero-state for the Validation tab with "Generate rules" and "Add rule" actions.
- Documents `find` now returns the matched document count and estimated collection total.

### Changed

- Aggregation Explain now opens in a modal with Visual Tree / Raw Output tabs, matching the Documents panel.
- Validation rules are rendered as a readable list on the Validation tab with direct rule removal.

### Fixed

- Documents pagination (First / Prev / Next) buttons no longer stay permanently disabled.
- Explain Visual Tree / Raw Output tab switching now hides the inactive view correctly.
- Index bounds in Explain output are rendered as human-readable field → range pairs instead of escaped JSON.
- Schema analysis no longer expands binary fields (`_id`, `[]byte`, GUID/UUID) into per-byte pseudo-fields such as `_id.buffer.0`.
- Schema analysis now includes top-level fields and is significantly faster on large collections.
- Editing a connection no longer overwrites a custom server-selection timeout or notes.
- Removing the last validation rule clears the validator instead of leaving an empty `$jsonSchema`.
- Empty validation rules are ignored when saving.

## 0.3.0 - 2026-10-01

### Added

- Compass-style slow-operation monitoring with complete operation details.
- Operation termination from Performance Metrics.
- Stable rolling visibility for recently observed operations.

### Changed

- Performance Metrics now uses `$currentOp` and CPU-normalized collection load.
- Live metric updates preserve scrolling and avoid refreshing the whole screen.
- Aggregation Explain now uses execution statistics correctly.
- JSON field names are rendered in bold.

### Fixed

- Corrected the MongoDB `killOp` command format.
- Improved visibility and sorting of long-running shard and time-series bucket queries.

## 0.2.0 - 2026-10-01

### Added

- Database export and import workflows with clearer Explorer actions.
- Resizable aggregation editor and result panes with syntax highlighting.
- List and JSON aggregation result views with total-result counts and ten-document previews.
- Aggregation export format selection after invoking Export.

### Changed

- Compact document and aggregation JSON trees with consistent syntax colors.
- Improved Extended JSON date rendering and aggregation suggestions.
- Streamlined Explorer tools and performance access.

## 0.1.0 - 2026-09-30

### Added

- MongoDB connection management with secure credential storage.
- Database, collection, view and index management from the Explorer.
- Document browsing, editing, filtering, pagination and bulk insert.
- Aggregation pipeline builder with stage previews, count and explain.
- Visual explain plans and performance metrics.
- Schema analysis, validation rules, query history and saved queries.
- JSON, JSON Lines and CSV import/export.
- mongosh, database command and mongorestore workflows.

### Notes

- This is the first public preview release.