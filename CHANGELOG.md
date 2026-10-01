# Changelog

All notable changes to this extension are documented in this file.

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