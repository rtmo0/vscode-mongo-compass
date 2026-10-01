# Changelog

All notable changes to this extension are documented in this file.

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