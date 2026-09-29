import type { Document } from 'mongodb';
import type { ExplainNode, ExplainSummary } from './types';

/**
 * Converts raw `explain` output (classic or SBE) into a flattened tree plus
 * human-readable insights, the same way `@mongodb-js/explain-plan-helper` does
 * for Compass' Explain Plan tab.
 */
export function summarizeExplain(raw: Document, namespace: string): Omit<ExplainSummary, 'elapsedMS'> {
  const queryPlanner = (raw.queryPlanner ?? {}) as Document;
  const executionStats = (raw.executionStats ?? {}) as Document | undefined;
  const winningPlan = normalisePlan(queryPlanner.winningPlan as Document | undefined);
  const rejectedPlans = ((queryPlanner.rejectedPlans ?? []) as Document[])
    .map(normalisePlan)
    .filter((plan): plan is Document => plan !== undefined);

  const tree: ExplainNode[] = [];
  if (winningPlan) {
    tree.push(toNode(winningPlan, executionStats));
  }
  if (Array.isArray(raw.stages)) {
    for (const stage of raw.stages as Document[]) {
      tree.push(toNode(stage, executionStats));
    }
  }

  const insights = buildInsights(raw, winningPlan, executionStats);

  return {
    namespace,
    winningPlan: winningPlan ?? {},
    rejectedPlans,
    executionStats,
    raw,
    tree,
    insights
  };
}

function normalisePlan(plan: Document | undefined): Document | undefined {
  if (!plan) {
    return undefined;
  }
  // SBE plans wrap the classic plan in `queryPlanner.winningPlan.queryPlan`.
  if (plan.queryPlan && typeof plan.queryPlan === 'object') {
    return { ...plan, ...(plan.queryPlan as Document) };
  }
  return plan;
}

function toNode(plan: Document, executionStats: Document | undefined): ExplainNode {
  const stage = String(plan.stage ?? plan.$cursor?.queryPlanner?.winningPlan?.stage ?? 'UNKNOWN');
  const details: Record<string, string> = {};

  const interesting: Array<[string, string]> = [
    ['namespace', 'Namespace'],
    ['indexName', 'Index'],
    ['indexBounds', 'Index bounds'],
    ['direction', 'Direction'],
    ['filter', 'Filter'],
    ['inputStage', ''],
    ['keyPattern', 'Key pattern'],
    ['multikey', 'Multikey'],
    ['isPartial', 'Partial'],
    ['sparse', 'Sparse'],
    ['unique', 'Unique'],
    ['nReturned', 'Returned'],
    ['executionTimeMillis', 'Time (ms)'],
    ['totalKeysExamined', 'Keys examined'],
    ['totalDocsExamined', 'Docs examined'],
    ['sortPattern', 'Sort pattern']
  ];

  for (const [key, label] of interesting) {
    if (label && plan[key] !== undefined) {
      details[label] = stringify(plan[key]);
    }
  }

  if (executionStats) {
    if (executionStats.nReturned !== undefined && details['Returned'] === undefined) {
      details['Returned'] = stringify(executionStats.nReturned);
    }
    if (executionStats.executionTimeMillis !== undefined && details['Time (ms)'] === undefined) {
      details['Time (ms)'] = stringify(executionStats.executionTimeMillis);
    }
    if (executionStats.totalKeysExamined !== undefined && details['Keys examined'] === undefined) {
      details['Keys examined'] = stringify(executionStats.totalKeysExamined);
    }
    if (executionStats.totalDocsExamined !== undefined && details['Docs examined'] === undefined) {
      details['Docs examined'] = stringify(executionStats.totalDocsExamined);
    }
  }

  const children: ExplainNode[] = [];
  const inputStage = plan.inputStage ?? plan.$cursor?.queryPlanner?.winningPlan?.inputStage;
  if (inputStage && typeof inputStage === 'object') {
    children.push(toNode(inputStage as Document, executionStats));
  }
  if (Array.isArray(plan.inputStages)) {
    for (const child of plan.inputStages as Document[]) {
      children.push(toNode(child, executionStats));
    }
  }

  return {
    stage,
    description: describeStage(stage),
    details,
    children
  };
}

function describeStage(stage: string): string {
  const descriptions: Record<string, string> = {
    COLLSCAN: 'Collection scan — every document in the collection was examined. Add an index to avoid this.',
    IXSCAN: 'Index scan — documents were located using an index.',
    FETCH: 'Documents were fetched from storage by record id.',
    IDHACK: 'Fast path lookup by _id.',
    SHARDING_FILTER: 'Documents were filtered by shard key.',
    SORT: 'An in-memory sort was performed. Consider an index that matches the sort.',
    SORT_MERGE: 'Sorted results from multiple indexes were merged.',
    LIMIT: 'Result set was truncated by $limit.',
    SKIP: 'Documents were skipped.',
    PROJECTION_COVERED: 'Projection was satisfied entirely from the index (no fetch needed).',
    PROJECTION_SIMPLE: 'A simple projection was applied.',
    COUNT: 'Count operation.',
    COUNT_SCAN: 'Count satisfied from an index.',
    SUBPLAN: 'A sub-plan was used (e.g. for $or).',
    AND_SORTED: 'Intersection of sorted input stages.',
    OR: 'Union of input stages.',
    EOFSORT: 'External (disk) sort — the sort spilled to disk.',
    DISTINCT_SCAN: 'Distinct values were read directly from an index.',
    TEXT_MATCH: 'Text search match phase.',
    TEXT: 'Text search.',
    GEO_NEAR: 'Geospatial $near query.',
    GEO_SORT_KEY_GENERATOR: 'Geospatial sort key generation.',
    NEED_TIME: 'Stage requested more time from its child.',
    RECORD_STORE_FAST_COUNT: 'Fast count from the storage engine.',
    GROUP: 'Grouping stage.',
    UNPACK: 'Time-series bucket unpacking.',
    $_internalSearchMongotRemote: 'Atlas Search query executed on the search node.',
    $cursor: 'Aggregation cursor over the source collection.',
    $match: '$match stage.',
    $group: '$group stage.',
    $sort: '$sort stage.',
    $limit: '$limit stage.',
    $skip: '$skip stage.',
    $project: '$project stage.',
    $lookup: '$lookup (join) stage.',
    $unwind: '$unwind stage.',
    $facet: '$facet stage.',
    $count: '$count stage.',
    $addFields: '$addFields stage.',
    $set: '$set stage.',
    $replaceRoot: '$replaceRoot stage.',
    $out: '$out stage — writes results to a collection.',
    $merge: '$merge stage — writes results to a collection.',
    $search: 'Atlas Search stage.',
    $vectorSearch: 'Atlas Vector Search stage.',
    $sample: '$sample stage.',
    $bucket: '$bucket stage.',
    $graphLookup: '$graphLookup stage.'
  };
  return descriptions[stage] ?? `Execution stage: ${stage}`;
}

function buildInsights(
  raw: Document,
  winningPlan: Document | undefined,
  executionStats: Document | undefined
): string[] {
  const insights: string[] = [];
  const stages = collectStages(winningPlan);

  if (stages.includes('COLLSCAN')) {
    insights.push(
      '⚠️ This query performed a **collection scan**. If it runs frequently, create an index covering the filter fields.'
    );
  }
  if (stages.includes('IXSCAN')) {
    const indexName = winningPlan?.indexName ?? findIndexName(winningPlan);
    insights.push(`✅ An index was used${indexName ? `: \`${String(indexName)}\`` : ''}.`);
  }
  if (stages.includes('SORT')) {
    insights.push(
      '⚠️ An in-memory **SORT** stage was required. An index matching the sort order can remove it.'
    );
  }
  if (stages.includes('EOFSORT')) {
    insights.push('🔴 The sort **spilled to disk** (EOFSORT). This is expensive — add a supporting index.');
  }
  if (stages.includes('SHARDING_FILTER')) {
    insights.push('ℹ️ Results were filtered by shard key — the query targets multiple shards.');
  }

  if (executionStats) {
    const returned = Number(executionStats.nReturned ?? 0);
    const examined = Number(executionStats.totalDocsExamined ?? 0);
    const keys = Number(executionStats.totalKeysExamined ?? 0);
    const millis = Number(executionStats.executionTimeMillis ?? 0);

    if (examined > 0 && returned > 0 && examined / returned > 10) {
      insights.push(
        `⚠️ Examined ${examined} documents to return ${returned} (ratio ${(examined / returned).toFixed(1)}:1). A more selective index would reduce this.`
      );
    }
    if (keys > 0 && examined === 0) {
      insights.push('✅ The query was **covered** by the index — no documents were fetched.');
    }
    if (millis > 100) {
      insights.push(`⏱️ Execution took ${millis} ms.`);
    }
    if (executionStats.executionStages?.docsExamined !== undefined) {
      void executionStats.executionStages;
    }
  }

  if (raw.command?.hint) {
    insights.push(`ℹ️ A hint was used: \`${JSON.stringify(raw.command.hint)}\`.`);
  }

  if (insights.length === 0) {
    insights.push('No notable performance signals detected for this plan.');
  }
  return insights;
}

function collectStages(plan: Document | undefined): string[] {
  const stages: string[] = [];
  const walk = (node: Document | undefined): void => {
    if (!node) {
      return;
    }
    if (node.stage) {
      stages.push(String(node.stage));
    }
    if (node.inputStage && typeof node.inputStage === 'object') {
      walk(node.inputStage as Document);
    }
    if (Array.isArray(node.inputStages)) {
      for (const child of node.inputStages as Document[]) {
        walk(child);
      }
    }
  };
  walk(plan);
  return stages;
}

function findIndexName(plan: Document | undefined): unknown {
  if (!plan) {
    return undefined;
  }
  if (plan.indexName) {
    return plan.indexName;
  }
  if (plan.inputStage && typeof plan.inputStage === 'object') {
    return findIndexName(plan.inputStage as Document);
  }
  return undefined;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
