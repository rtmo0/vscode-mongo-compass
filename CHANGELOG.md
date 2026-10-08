# Changelog

All notable changes to this extension are documented in this file.

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