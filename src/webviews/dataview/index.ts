import {
  request,
  on,
  getState,
  setState,
  el,
  clear,
  highlightJson,
  createSyntaxEditor,
  createExplainView,
  formatNumber,
  debounce
} from '../shared/client';

type ViewKind =
  | 'indexes'
  | 'schema'
  | 'validation'
  | 'explain'
  | 'stats'
  | 'serverStatus'
  | 'performanceMetrics'
  | 'databaseCommand'
  | 'queryHistory'
  | 'savedQueries'
  | 'currentOp';

interface UiState {
  kind: ViewKind;
  title: string;
  context: { connectionId: string; database?: string; collection?: string };
  data: unknown;
  error: string | null;
  loading: boolean;
}

let state: UiState = getState<UiState>({
  kind: 'indexes',
  title: 'MongoDB',
  context: { connectionId: '' },
  data: null,
  error: null,
  loading: true
});

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const titleEl = $('title');
const contentEl = $('content');
const statusTextEl = $('status-text');
const toolbarActions = $('toolbar-actions');
const modalRoot = $('modal-root');

interface PerformanceSampleData {
  sampledAt: number;
  connectionName?: string;
  serverStatus: Record<string, unknown>;
  currentOp: Array<Record<string, unknown>>;
  top: Record<string, unknown>;
}

interface PerformancePoint {
  sampledAt: number;
  operations: Record<string, number>;
  readWrite: Record<string, number>;
  network: Record<string, number>;
  connections: Record<string, number>;
  memory: Record<string, number>;
}

let performanceTimer: ReturnType<typeof setInterval> | undefined;
let performancePaused = false;
let previousPerformanceSample: PerformanceSampleData | undefined;
let performanceHistory: PerformancePoint[] = [];
let databaseCommandTextarea: HTMLTextAreaElement | undefined;

// ───────────────────────────── init ─────────────────────────────

on('init', (payload) => {
  const init = payload as {
    kind: ViewKind;
    title: string;
    context: UiState['context'];
    data?: unknown;
    error?: string;
  };
  state.kind = init.kind;
  state.title = init.title;
  state.context = init.context;
  state.data = init.data ?? null;
  state.error = init.error ?? null;
  state.loading = false;
  if (state.kind === 'performanceMetrics' && init.data) {
    ingestPerformanceSample(init.data as PerformanceSampleData);
    startPerformancePolling();
  } else {
    stopPerformancePolling();
  }
  render();
  persist();
});

on('refreshExplorer', () => {
  /* handled host-side */
});

void request('ready');

$('btn-refresh').addEventListener('click', () => void refresh());

const persist = debounce(() => setState(state), 200);

async function refresh(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const result = (await request('refresh')) as { data: unknown };
    state.data = result.data;
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

// ───────────────────────────── render dispatch ─────────────────────────────

function render(): void {
  titleEl.textContent = state.title;
  renderStatus();
  renderToolbar();
  clear(contentEl);

  if (state.loading) {
    contentEl.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), 'Loading…'));
    return;
  }
  if (state.error) {
    contentEl.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-error-text', text: state.error })));
    return;
  }

  switch (state.kind) {
    case 'indexes':
      contentEl.append(renderIndexes());
      break;
    case 'schema':
      contentEl.append(renderSchema());
      break;
    case 'validation':
      contentEl.append(renderValidation());
      break;
    case 'explain':
      contentEl.append(renderExplain());
      break;
    case 'stats':
      contentEl.append(renderStats());
      break;
    case 'serverStatus':
      contentEl.append(renderServerStatus());
      break;
    case 'performanceMetrics':
      contentEl.append(renderPerformanceMetrics());
      break;
    case 'databaseCommand':
      contentEl.append(renderDatabaseCommand());
      break;
    case 'queryHistory':
      contentEl.append(renderHistory());
      break;
    case 'savedQueries':
      contentEl.append(renderSavedQueries());
      break;
    case 'currentOp':
      contentEl.append(renderCurrentOp());
      break;
    default:
      contentEl.append(el('div', { className: 'mc-empty', text: 'Unknown view' }));
  }
}

function renderStatus(): void {
  clear(statusTextEl);
  if (state.loading) {
    statusTextEl.append(el('span', { className: 'mc-spinner' }), ' Working…');
    return;
  }
  if (state.error) {
    statusTextEl.append(el('span', { className: 'error', text: state.error }));
    return;
  }
  const ns = state.context.collection
    ? `${state.context.database}.${state.context.collection}`
    : state.context.database ?? '';
  statusTextEl.textContent = ns || 'Ready';
}

function renderToolbar(): void {
  clear(toolbarActions);
  const addButton = (label: string, title: string, handler: () => void): void => {
    const btn = el('button', { className: 'mc-btn', text: label, title });
    btn.addEventListener('click', handler);
    toolbarActions.append(btn);
  };

  switch (state.kind) {
    case 'indexes':
      addButton('＋ Create Index', 'Create a new index', () => showCreateIndexModal());
      addButton('＋ Search Index', 'Create an Atlas Search index', () => showCreateSearchIndexModal());
      break;
    case 'schema':
      addButton('▶ Analyze', 'Re-run schema analysis', () => showAnalyzeModal());
      break;
    case 'validation':
      addButton('✎ Edit Rules', 'Edit validation rules', () => showValidationModal());
      break;
    case 'queryHistory':
      addButton('🗑 Clear', 'Clear all history', () => void clearHistory());
      break;
    case 'currentOp':
      addButton('⟳ Refresh', 'Refresh operations', () => void refresh());
      break;
    case 'performanceMetrics':
      addButton(performancePaused ? '▶ Resume' : 'Ⅱ Pause', 'Pause or resume live sampling', () => {
        performancePaused = !performancePaused;
        render();
      });
      break;
    case 'databaseCommand':
      addButton('▶ Run', 'Run command (Cmd/Ctrl+Enter)', () => void runDatabaseCommand());
      break;
    default:
      break;
  }
}

// ───────────────────────────── indexes ─────────────────────────────

interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  [k: string]: unknown;
}

interface IndexUsageStat {
  name?: string;
  accesses?: {
    ops?: number;
    since?: string | { $date?: string };
  };
}

interface IndexesData {
  namespace: string;
  indexes: IndexInfo[];
  searchIndexes: unknown[];
  indexStats: IndexUsageStat[];
  indexSizes: Record<string, number>;
}

function renderIndexes(): HTMLElement {
  const data = state.data as IndexesData | null;
  const wrap = el('div', { className: 'mc-indexes-view' });
  if (!data) {
    return empty('No index data');
  }

  if (data.indexes.length === 0) {
    wrap.append(empty('No indexes on this collection'));
  } else {
    const usageByName = new Map((data.indexStats ?? []).map((stat) => [stat.name, stat.accesses]));
    const tableScroll = el('div', { className: 'mc-index-table-scroll' });
    const table = el('table', { className: 'mc-index-table' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const col of ['Name & Definition', 'Type', 'Size', 'Usage', 'Properties', 'Status', '']) {
      const heading = el('span', { text: col });
      if (col) {
        heading.append(el('span', { className: 'mc-index-sort', text: '↕' }));
      }
      headRow.append(el('th', {}, heading));
    }
    thead.append(headRow);
    const tbody = el('tbody');
    for (const index of data.indexes) {
      const usage = usageByName.get(index.name);
      const row = el('tr');

      const definitionCell = el('td');
      const definition = el('details', { className: 'mc-index-definition' });
      const summary = el('summary');
      summary.append(el('span', { className: 'mc-index-name', text: index.name }));
      definition.append(summary);
      definition.append(el('div', { className: 'mc-index-keys mc-mono', text: formatIndexKeys(index.key) }));
      definitionCell.append(definition);
      row.append(definitionCell);

      row.append(el('td', {}, indexBadge(indexType(index), 'neutral')));
      row.append(el('td', { text: formatBytes(data.indexSizes?.[index.name]) }));
      row.append(el('td', { text: formatIndexUsage(usage) }));

      const props: string[] = [];
      if (index.unique) props.push('UNIQUE');
      if (index.sparse) props.push('SPARSE');
      if (index.expireAfterSeconds !== undefined) props.push(`TTL ${index.expireAfterSeconds}s`);
      if (index.partialFilterExpression) props.push('PARTIAL');
      if (index.collation) props.push('COLLATION');
      if (index.hidden) props.push('HIDDEN');
      const propertiesCell = el('td', { className: 'mc-index-properties' });
      if (props.length) {
        for (const property of props) propertiesCell.append(indexBadge(property, 'neutral'));
      } else {
        propertiesCell.textContent = '—';
      }
      row.append(propertiesCell);
      row.append(el('td', {}, indexBadge(index.hidden ? 'HIDDEN' : 'READY', index.hidden ? 'neutral' : 'success')));

      const actions = el('td');
      if (index.name !== '_id_') {
        const dropBtn = el('button', { className: 'mc-index-drop', text: '×', title: `Drop ${index.name}` });
        dropBtn.addEventListener('click', () => void dropIndex(index.name));
        actions.append(dropBtn);
      }
      row.append(actions);
      tbody.append(row);
    }
    table.append(thead, tbody);
    tableScroll.append(table);
    wrap.append(tableScroll);
  }

  if (data.searchIndexes && data.searchIndexes.length > 0) {
    wrap.append(el('div', { className: 'mc-section-title', text: `Atlas Search Indexes (${data.searchIndexes.length})` }));
    const pre = el('pre', { className: 'mc-mono' });
    pre.innerHTML = highlightJson(data.searchIndexes);
    wrap.append(pre);
  }

  wrap.append(el('div', { className: 'mc-section-title', text: 'Raw index specs' }));
  const details = el('details');
  const rawPre = el('pre', { className: 'mc-mono' });
  rawPre.innerHTML = highlightJson(data.indexes);
  details.append(el('summary', { text: 'Show raw JSON' }), rawPre);
  wrap.append(details);

  return wrap;
}

function indexBadge(text: string, tone: 'neutral' | 'success'): HTMLElement {
  return el('span', { className: `mc-index-badge ${tone}`, text });
}

function indexType(index: IndexInfo): string {
  const directions = Object.values(index.key ?? {});
  if (directions.includes('text')) return 'TEXT';
  if (directions.includes('2d')) return '2D';
  if (directions.includes('2dsphere')) return '2DSPHERE';
  if (directions.includes('hashed')) return 'HASHED';
  if (Object.keys(index.key ?? {}).some((field) => field === '$**' || field.endsWith('.$**'))) return 'WILDCARD';
  return 'REGULAR';
}

function formatIndexKeys(keys: Record<string, unknown>): string {
  return Object.entries(keys ?? {})
    .map(([field, direction]) => `${field}: ${formatDirection(direction)}`)
    .join(', ');
}

function formatDirection(direction: unknown): string {
  if (direction === 1) return 'ascending';
  if (direction === -1) return 'descending';
  return String(direction);
}

function formatIndexUsage(accesses: IndexUsageStat['accesses'] | undefined): string {
  if (!accesses) return 'Unavailable';
  const sinceValue = typeof accesses.since === 'string' ? accesses.since : accesses.since?.$date;
  const since = sinceValue ? new Date(sinceValue) : null;
  const formattedSince = since && !Number.isNaN(since.getTime())
    ? since.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' })
    : 'unknown';
  return `${formatNumber(accesses.ops ?? 0)} (since ${formattedSince})`;
}

function dropIndex(name: string): void {
  const body = el('div');
  body.append(el('p', { text: `Drop index "${name}"? This action cannot be undone.` }));
  openModal({
    title: 'Drop index',
    body,
    primaryLabel: 'Drop index',
    onPrimary: async () => {
      try {
        await request('dropIndex', { name });
        closeModal();
        setStatusMessage(`Index "${name}" dropped.`);
        await refresh();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function showCreateIndexModal(): void {
  const body = el('div');
  body.append(editorField('Keys (e.g. { field: 1 })', '{\n  \n}', 6, 'keys'));
  body.append(editorField('Options (optional)', '{\n  name: "",\n  unique: false\n}', 6, 'options'));
  openModal({
    title: 'Create index',
    body,
    primaryLabel: 'Create',
    onPrimary: async (getFirst) => {
      const values = getValues();
      try {
        const result = (await request('createIndex', {
          keysText: values.keys,
          optionsText: values.options
        })) as { name: string };
        closeModal();
        setStatusMessage(`Index "${result.name}" created.`);
        await refresh();
      } catch (err) {
        showFieldError((err as Error).message);
      }
      void getFirst;
    }
  });
}

function showCreateSearchIndexModal(): void {
  const body = el('div');
  body.append(
    editorField(
      'Search index definition',
      '{\n  name: "my-index",\n  definition: {\n    mappings: {\n      dynamic: true\n    }\n  }\n}',
      10,
      'definition'
    )
  );
  openModal({
    title: 'Create Atlas Search index',
    body,
    primaryLabel: 'Create',
    onPrimary: async () => {
      const values = getValues();
      try {
        await request('createSearchIndex', { definitionText: values.definition });
        closeModal();
        setStatusMessage('Search index creation started.');
        await refresh();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

// ───────────────────────────── schema ─────────────────────────────

interface SchemaField {
  path: string;
  name: string;
  count: number;
  probability: number;
  types: Array<{
    name: string;
    count: number;
    probability: number;
    unique?: number;
    values?: unknown[];
    minLength?: number;
    maxLength?: number;
    averageLength?: number;
    min?: number;
    max?: number;
    average?: number;
  }>;
}

function renderSchema(): HTMLElement {
  const data = state.data as {
    namespace: string;
    sampledDocuments: number;
    totalDocuments: number | null;
    fields: SchemaField[];
    suggestions: string[];
    elapsedMS: number;
  } | null;

  if (!data) {
    return empty('No schema data. Click "Analyze".');
  }

  const wrap = el('div');

  const summary = el('dl', { className: 'mc-kv' });
  summary.append(
    el('dt', { text: 'Namespace' }), el('dd', { text: data.namespace }),
    el('dt', { text: 'Sampled' }), el('dd', { text: formatNumber(data.sampledDocuments) }),
    el('dt', { text: 'Total docs' }), el('dd', { text: data.totalDocuments !== null ? formatNumber(data.totalDocuments) : '—' }),
    el('dt', { text: 'Fields' }), el('dd', { text: formatNumber(data.fields.length) }),
    el('dt', { text: 'Analysis time' }), el('dd', { text: `${data.elapsedMS} ms` })
  );
  wrap.append(summary);

  if (data.suggestions.length > 0) {
    wrap.append(el('div', { className: 'mc-section-title', text: 'Insights' }));
    for (const suggestion of data.suggestions) {
      wrap.append(el('div', { className: 'mc-insight', text: suggestion }));
    }
  }

  wrap.append(el('div', { className: 'mc-section-title', text: 'Fields' }));

  if (data.fields.length === 0) {
    wrap.append(empty('No fields found in the sample.'));
    return wrap;
  }

  const table = el('table', { className: 'mc-table' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of ['Field', 'Presence', 'Types', 'Statistics']) {
    headRow.append(el('th', { text: col }));
  }
  thead.append(headRow);
  const tbody = el('tbody');

  for (const field of data.fields) {
    const row = el('tr');
    row.append(el('td', { className: 'mc-mono', text: field.path }));

    const presenceCell = el('td');
    const pct = Math.round(field.probability * 100);
    presenceCell.append(
      el('div', { text: `${pct}%` }),
      el('div', { className: 'mc-bar' }, el('span', { style: `width:${pct}%` } as never))
    );
    row.append(presenceCell);

    const typesText = field.types
      .map((t) => `${t.name} (${Math.round(t.probability * 100)}%)`)
      .join(', ');
    row.append(el('td', { text: typesText }));

    const statsCell = el('td');
    const statParts: string[] = [];
    for (const type of field.types) {
      if (type.unique !== undefined) {
        statParts.push(`unique: ${type.unique}`);
      }
      if (type.minLength !== undefined) {
        statParts.push(`len: ${type.minLength}–${type.maxLength} (avg ${type.averageLength})`);
      }
      if (type.min !== undefined) {
        statParts.push(`range: ${type.min}–${type.max} (avg ${type.average})`);
      }
    }
    statsCell.textContent = statParts.join(' · ') || '—';
    row.append(statsCell);

    tbody.append(row);
  }
  table.append(thead, tbody);
  wrap.append(table);

  return wrap;
}

function showAnalyzeModal(): void {
  const body = el('div');
  body.append(editorField('Query filter (optional)', '{}', 4, 'query'));
  body.append(numberField('Sample size', 1000, 'sampleSize'));
  openModal({
    title: 'Analyze schema',
    body,
    primaryLabel: 'Analyze',
    onPrimary: async () => {
      const values = getValues();
      state.loading = true;
      render();
      try {
        const result = (await request('analyzeSchema', {
          queryText: values.query,
          sampleSize: Number(values.sampleSize) || 1000
        })) as { data: unknown };
        state.data = result.data;
        closeModal();
      } catch (err) {
        showFieldError((err as Error).message);
      } finally {
        state.loading = false;
        render();
        persist();
      }
    }
  });
}

// ───────────────────────────── validation ─────────────────────────────

function renderValidation(): HTMLElement {
  const data = state.data as {
    namespace: string;
    validator: unknown;
    validationLevel: string;
    validationAction: string;
  } | null;

  if (!data) {
    return empty('No validation data');
  }

  const wrap = el('div');
  const summary = el('dl', { className: 'mc-kv' });
  summary.append(
    el('dt', { text: 'Namespace' }), el('dd', { text: data.namespace }),
    el('dt', { text: 'Level' }), el('dd', { text: data.validationLevel }),
    el('dt', { text: 'Action' }), el('dd', { text: data.validationAction })
  );
  wrap.append(summary);

  wrap.append(el('div', { className: 'mc-section-title', text: 'Validator' }));
  if (!data.validator || Object.keys(data.validator as object).length === 0) {
    wrap.append(empty('No validation rules defined on this collection.'));
  } else {
    const pre = el('pre', { className: 'mc-mono' });
    pre.innerHTML = highlightJson(data.validator);
    wrap.append(pre);
  }
  return wrap;
}

function showValidationModal(): void {
  const data = state.data as { validator: unknown; validationLevel: string; validationAction: string } | null;
  const body = el('div');
  const currentValidator = data?.validator ? JSON.stringify(data.validator, null, 2) : '{\n  $jsonSchema: {\n    \n  }\n}';
  body.append(editorField('Validator (empty = remove)', currentValidator, 12, 'validator'));

  const levelSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const level of ['off', 'strict', 'moderate']) {
    const option = el('option', { value: level, text: level }) as HTMLOptionElement;
    option.selected = data?.validationLevel === level;
    levelSelect.append(option);
  }
  body.append(el('div', { className: 'mc-field' }, el('label', { text: 'Validation level' }), levelSelect));

  const actionSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const action of ['error', 'warn']) {
    const option = el('option', { value: action, text: action }) as HTMLOptionElement;
    option.selected = data?.validationAction === action;
    actionSelect.append(option);
  }
  body.append(el('div', { className: 'mc-field' }, el('label', { text: 'Validation action' }), actionSelect));

  openModal({
    title: 'Edit validation rules',
    body,
    primaryLabel: 'Save',
    onPrimary: async () => {
      const values = getValues();
      try {
        await request('setValidation', {
          validatorText: values.validator,
          validationLevel: levelSelect.value,
          validationAction: actionSelect.value
        });
        closeModal();
        setStatusMessage('Validation rules updated.');
        await refresh();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

// ───────────────────────────── explain ─────────────────────────────

function renderExplain(): HTMLElement {
  const data = state.data as {
    namespace: string;
    tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
    insights: string[];
    executionStats?: Record<string, unknown>;
    raw: Record<string, unknown>;
    elapsedMS: number;
  } | null;

  if (!data) {
    return empty('No explain data');
  }

  return createExplainView(data as never);
}

// ───────────────────────────── stats ─────────────────────────────

function renderStats(): HTMLElement {
  const data = state.data as Record<string, unknown> | null;
  if (!data) {
    return empty('No stats');
  }
  const wrap = el('div');

  if (data.scope === 'collection') {
    const collStats = (data.collStats ?? {}) as Record<string, unknown>;
    wrap.append(el('div', { className: 'mc-section-title', text: `Collection: ${String(data.namespace)}` }));
    const summary = el('dl', { className: 'mc-kv' });
    summary.append(
      el('dt', { text: 'Documents' }), el('dd', { text: formatNumber(Number(data.count ?? collStats.count ?? 0)) }),
      el('dt', { text: 'Size' }), el('dd', { text: formatBytes(Number(collStats.size ?? 0)) }),
      el('dt', { text: 'Storage size' }), el('dd', { text: formatBytes(Number(collStats.storageSize ?? 0)) }),
      el('dt', { text: 'Avg object size' }), el('dd', { text: formatBytes(Number(collStats.avgObjSize ?? 0)) }),
      el('dt', { text: 'Indexes' }), el('dd', { text: formatNumber(Number(collStats.nindexes ?? 0)) }),
      el('dt', { text: 'Total index size' }), el('dd', { text: formatBytes(Number(collStats.totalIndexSize ?? 0)) })
    );
    wrap.append(summary);
  } else {
    const dbStats = (data.dbStats ?? {}) as Record<string, unknown>;
    wrap.append(el('div', { className: 'mc-section-title', text: `Database: ${String(data.database)}` }));
    const summary = el('dl', { className: 'mc-kv' });
    summary.append(
      el('dt', { text: 'Collections' }), el('dd', { text: formatNumber(Number(dbStats.collections ?? 0)) }),
      el('dt', { text: 'Views' }), el('dd', { text: formatNumber(Number(dbStats.views ?? 0)) }),
      el('dt', { text: 'Objects' }), el('dd', { text: formatNumber(Number(dbStats.objects ?? 0)) }),
      el('dt', { text: 'Data size' }), el('dd', { text: formatBytes(Number(dbStats.dataSize ?? 0)) }),
      el('dt', { text: 'Storage size' }), el('dd', { text: formatBytes(Number(dbStats.storageSize ?? 0)) }),
      el('dt', { text: 'Indexes' }), el('dd', { text: formatNumber(Number(dbStats.indexes ?? 0)) }),
      el('dt', { text: 'Index size' }), el('dd', { text: formatBytes(Number(dbStats.indexSize ?? 0)) })
    );
    wrap.append(summary);
  }

  wrap.append(el('div', { className: 'mc-section-title', text: 'Raw stats' }));
  const details = el('details');
  const pre = el('pre', { className: 'mc-mono' });
  pre.innerHTML = highlightJson(data);
  details.append(el('summary', { text: 'Show raw JSON' }), pre);
  wrap.append(details);

  return wrap;
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

// ───────────────────────────── server status ─────────────────────────────

function renderServerStatus(): HTMLElement {
  const data = state.data as {
    serverStatus: Record<string, unknown> & { error?: string };
    buildInfo: Record<string, unknown>;
    topology?: { serverVersion: string; topologyType: string; isAtlas: boolean };
    connectionName?: string;
  } | null;

  if (!data) {
    return empty('No server status');
  }

  const wrap = el('div');
  const status = data.serverStatus;

  if (status.error) {
    wrap.append(el('div', { className: 'mc-insight', text: `serverStatus unavailable: ${status.error}` }));
  }

  const summary = el('dl', { className: 'mc-kv' });
  summary.append(
    el('dt', { text: 'Connection' }), el('dd', { text: data.connectionName ?? '—' }),
    el('dt', { text: 'Version' }), el('dd', { text: String(data.buildInfo.version ?? data.topology?.serverVersion ?? '—') }),
    el('dt', { text: 'Topology' }), el('dd', { text: data.topology?.topologyType ?? '—' }),
    el('dt', { text: 'Atlas' }), el('dd', { text: data.topology?.isAtlas ? 'yes' : 'no' }),
    el('dt', { text: 'Host' }), el('dd', { text: String(status.host ?? '—') }),
    el('dt', { text: 'Uptime' }), el('dd', { text: status.uptime ? `${formatNumber(Number(status.uptime))} s` : '—' })
  );

  const connections = (status.connections ?? {}) as Record<string, unknown>;
  if (connections.current !== undefined) {
    summary.append(
      el('dt', { text: 'Connections' }),
      el('dd', { text: `${formatNumber(Number(connections.current))} current / ${formatNumber(Number(connections.available ?? 0))} available` })
    );
  }

  const opcounters = (status.opcounters ?? {}) as Record<string, unknown>;
  if (opcounters.insert !== undefined) {
    summary.append(
      el('dt', { text: 'Opcounters' }),
      el('dd', {
        text: `ins ${formatNumber(Number(opcounters.insert ?? 0))} · qry ${formatNumber(Number(opcounters.query ?? 0))} · upd ${formatNumber(Number(opcounters.update ?? 0))} · del ${formatNumber(Number(opcounters.delete ?? 0))} · cmd ${formatNumber(Number(opcounters.command ?? 0))}`
      })
    );
  }

  const mem = (status.mem ?? {}) as Record<string, unknown>;
  if (mem.resident !== undefined) {
    summary.append(
      el('dt', { text: 'Memory' }),
      el('dd', { text: `resident ${formatNumber(Number(mem.resident))} MB · virtual ${formatNumber(Number(mem.virtual ?? 0))} MB` })
    );
  }

  wrap.append(summary);

  wrap.append(el('div', { className: 'mc-section-title', text: 'Raw serverStatus' }));
  const details = el('details');
  const pre = el('pre', { className: 'mc-mono' });
  pre.innerHTML = highlightJson(status);
  details.append(el('summary', { text: 'Show raw JSON' }), pre);
  wrap.append(details);

  return wrap;
}

// ───────────────────────────── performance metrics ─────────────────────────────

function startPerformancePolling(): void {
  if (performanceTimer) return;
  performanceTimer = setInterval(() => void pollPerformanceSample(), 1000);
}

function stopPerformancePolling(): void {
  if (performanceTimer) clearInterval(performanceTimer);
  performanceTimer = undefined;
}

async function pollPerformanceSample(): Promise<void> {
  if (performancePaused || state.kind !== 'performanceMetrics') return;
  try {
    const result = await request<{ data: PerformanceSampleData }>('performanceSample');
    state.data = result.data;
    ingestPerformanceSample(result.data);
    render();
  } catch (err) {
    statusTextEl.textContent = (err as Error).message;
    statusTextEl.classList.add('error');
  }
}

function ingestPerformanceSample(sample: PerformanceSampleData): void {
  const previous = previousPerformanceSample;
  previousPerformanceSample = sample;
  if (!previous) return;
  const seconds = Math.max((sample.sampledAt - previous.sampledAt) / 1000, 0.001);
  const currentStatus = sample.serverStatus;
  const previousStatus = previous.serverStatus;
  const currentOps = objectValue(currentStatus.opcounters);
  const previousOps = objectValue(previousStatus.opcounters);
  const currentNetwork = objectValue(currentStatus.network);
  const previousNetwork = objectValue(previousStatus.network);
  const currentConnections = objectValue(currentStatus.connections);
  const currentMemory = objectValue(currentStatus.mem);
  const currentExtra = objectValue(currentStatus.opcountersRepl);
  const previousExtra = objectValue(previousStatus.opcountersRepl);

  performanceHistory.push({
    sampledAt: sample.sampledAt,
    operations: rateSeries(currentOps, previousOps, seconds, ['insert', 'query', 'update', 'delete', 'command']),
    readWrite: {
      reads: counterRate(currentOps.query, previousOps.query, seconds) + counterRate(currentOps.getmore, previousOps.getmore, seconds),
      writes: counterRate(currentOps.insert, previousOps.insert, seconds) + counterRate(currentOps.update, previousOps.update, seconds) + counterRate(currentOps.delete, previousOps.delete, seconds),
      replication: Object.values(rateSeries(currentExtra, previousExtra, seconds, ['insert', 'query', 'update', 'delete', 'command'])).reduce((sum, value) => sum + value, 0)
    },
    network: {
      in: counterRate(currentNetwork.bytesIn, previousNetwork.bytesIn, seconds),
      out: counterRate(currentNetwork.bytesOut, previousNetwork.bytesOut, seconds),
      requests: counterRate(currentNetwork.numRequests, previousNetwork.numRequests, seconds)
    },
    connections: {
      current: numberValue(currentConnections.current),
      active: numberValue(currentConnections.active),
      available: numberValue(currentConnections.available)
    },
    memory: {
      resident: numberValue(currentMemory.resident),
      virtual: numberValue(currentMemory.virtual)
    }
  });
  performanceHistory = performanceHistory.slice(-60);
}

function renderPerformanceMetrics(): HTMLElement {
  const sample = state.data as PerformanceSampleData | null;
  if (!sample) return empty('Waiting for performance samples…');
  const wrap = el('div', { className: 'mc-performance' });
  const heading = el('div', { className: 'mc-performance-heading' });
  heading.append(
    el('div', {}, el('strong', { text: sample.connectionName ?? 'MongoDB' }), el('span', { className: 'mc-muted', text: ' · live server metrics' })),
    el('span', { className: `mc-live-indicator${performancePaused ? ' paused' : ''}`, text: performancePaused ? 'Paused' : 'Live' })
  );
  wrap.append(heading);

  if (performanceHistory.length === 0) {
    wrap.append(el('div', { className: 'mc-insight', text: 'Collecting the first two samples…' }));
  }

  const charts = el('div', { className: 'mc-performance-grid' });
  charts.append(
    metricChart('Operations', 'ops/s', 'operations', ['insert', 'query', 'update', 'delete', 'command']),
    metricChart('Read & Write', 'ops/s', 'readWrite', ['reads', 'writes', 'replication']),
    metricChart('Network', 'bytes/s', 'network', ['in', 'out']),
    metricChart('Connections', 'connections', 'connections', ['current', 'active']),
    metricChart('Memory', 'MB', 'memory', ['resident', 'virtual'])
  );
  wrap.append(charts);

  const details = el('div', { className: 'mc-performance-tables' });
  details.append(renderHottestCollections(sample), renderSlowOperations(sample));
  wrap.append(details);
  return wrap;
}

// ───────────────────────────── database command ─────────────────────────────

function renderDatabaseCommand(): HTMLElement {
  const data = state.data as {
    database?: string;
    commandText?: string;
    result?: string | null;
    commandError?: string | null;
  } | null;
  const wrap = el('div', { className: 'mc-command-view' });
  const editor = createSyntaxEditor(data?.commandText ?? '{\n  ping: 1\n}', 14);
  databaseCommandTextarea = editor.textarea;
  databaseCommandTextarea.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      void runDatabaseCommand();
    }
  });
  wrap.append(
    el('div', { className: 'mc-command-header' },
      el('div', {}, el('strong', { text: `Database: ${state.context.database ?? data?.database ?? '—'}` }), el('span', { className: 'mc-muted', text: ' · EJSON / shell syntax' })),
      el('button', { className: 'mc-btn primary', text: '▶ Run', title: 'Run command (Cmd/Ctrl+Enter)' })
    ),
    editor.element
  );
  const runButton = wrap.querySelector<HTMLButtonElement>('.mc-command-header button');
  runButton?.addEventListener('click', () => void runDatabaseCommand());

  const output = el('section', { className: 'mc-command-output' });
  output.append(el('div', { className: 'mc-section-title', text: 'Result' }));
  if (data?.commandError) {
    output.append(el('div', { className: 'mc-error-text', text: data.commandError }));
  } else if (data?.result) {
    const pre = el('pre', { className: 'mc-mono' });
    pre.innerHTML = highlightJson(data.result);
    output.append(pre);
  } else {
    output.append(el('div', { className: 'mc-muted', text: 'Run a command to see its result.' }));
  }
  wrap.append(output);
  return wrap;
}

async function runDatabaseCommand(): Promise<void> {
  const commandText = databaseCommandTextarea?.value ?? '';
  const database = state.context.database;
  if (!database || !commandText.trim()) return;
  statusTextEl.textContent = 'Running command…';
  try {
    const result = await request<{ result: string }>('runCommand', { database, commandText });
    state.data = { database, commandText, result: result.result, commandError: null };
    render();
    statusTextEl.textContent = 'Command completed.';
    persist();
  } catch (err) {
    state.data = { database, commandText, result: null, commandError: (err as Error).message };
    render();
    statusTextEl.textContent = 'Command failed.';
    persist();
  }
}

const chartColors = ['#00a35c', '#4c9ffe', '#f2b134', '#e15b64', '#a879e8'];

function metricChart(title: string, unit: string, group: keyof PerformancePoint, series: string[]): HTMLElement {
  const card = el('section', { className: 'mc-metric-card' });
  const latest = performanceHistory.at(-1)?.[group] as Record<string, number> | undefined;
  card.append(el('div', { className: 'mc-metric-title' }, el('strong', { text: title }), el('span', { text: unit })));
  const chart = el('div', { className: 'mc-line-chart' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 600 170');
  svg.setAttribute('preserveAspectRatio', 'none');
  const values = performanceHistory.flatMap((point) => series.map((name) => numberValue((point[group] as Record<string, number>)[name])));
  const max = Math.max(...values, 1);
  for (const y of [20, 65, 110, 155]) {
    const line = document.createElementNS(svg.namespaceURI, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('x2', '600'); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y));
    line.setAttribute('class', 'mc-chart-gridline');
    svg.append(line);
  }
  series.forEach((name, seriesIndex) => {
    const points = performanceHistory.map((point, index) => {
      const value = numberValue((point[group] as Record<string, number>)[name]);
      const x = performanceHistory.length <= 1 ? 0 : index * 600 / (performanceHistory.length - 1);
      const y = 160 - value / max * 145;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const polyline = document.createElementNS(svg.namespaceURI, 'polyline');
    polyline.setAttribute('points', points);
    polyline.setAttribute('fill', 'none');
    polyline.setAttribute('stroke', chartColors[seriesIndex % chartColors.length]);
    polyline.setAttribute('stroke-width', '2');
    polyline.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(polyline);
  });
  chart.append(svg);
  card.append(chart);
  const legend = el('div', { className: 'mc-chart-legend' });
  series.forEach((name) => legend.append(
    el('span', {}, el('i', { className: 'mc-chart-swatch' }), el('span', { text: `${name} ${formatMetric(latest?.[name] ?? 0, unit)}` }))
  ));
  Array.from(legend.querySelectorAll<HTMLElement>('.mc-chart-swatch')).forEach((swatch, index) => {
    swatch.style.background = chartColors[index % chartColors.length];
  });
  card.append(legend);
  return card;
}

function renderHottestCollections(sample: PerformanceSampleData): HTMLElement {
  const card = el('section', { className: 'mc-metric-card mc-metric-table-card' });
  card.append(el('div', { className: 'mc-metric-title' }, el('strong', { text: 'Hottest Collections' }), el('span', { text: 'total time' })));
  const rows = Object.entries(sample.top ?? {})
    .filter(([namespace]) => !namespace.startsWith('admin.') && !namespace.startsWith('config.') && !namespace.startsWith('local.'))
    .map(([namespace, raw]) => {
      const total = objectValue(objectValue(raw).total);
      return { namespace, micros: numberValue(total.time) };
    })
    .sort((a, b) => b.micros - a.micros)
    .slice(0, 8);
  const table = el('table', { className: 'mc-table mc-performance-table' });
  table.append(el('thead', {}, el('tr', {}, el('th', { text: 'Namespace' }), el('th', { text: 'Time' }))));
  const body = el('tbody');
  for (const row of rows) body.append(el('tr', {}, el('td', { text: row.namespace }), el('td', { text: formatDurationMicros(row.micros) })));
  if (!rows.length) body.append(el('tr', {}, el('td', { text: 'No collection activity yet', colSpan: 2 })));
  table.append(body); card.append(table); return card;
}

function renderSlowOperations(sample: PerformanceSampleData): HTMLElement {
  const card = el('section', { className: 'mc-metric-card mc-metric-table-card' });
  card.append(el('div', { className: 'mc-metric-title' }, el('strong', { text: 'Slowest Operations' }), el('span', { text: 'currently running' })));
  const operations = [...(sample.currentOp ?? [])]
    .filter((operation) => numberValue(operation.secs_running ?? operation.microsecs_running) > 0)
    .sort((a, b) => numberValue(b.secs_running ?? b.microsecs_running) - numberValue(a.secs_running ?? a.microsecs_running))
    .slice(0, 8);
  const table = el('table', { className: 'mc-table mc-performance-table' });
  table.append(el('thead', {}, el('tr', {}, el('th', { text: 'Operation' }), el('th', { text: 'Namespace' }), el('th', { text: 'Time' }))));
  const body = el('tbody');
  for (const operation of operations) body.append(el('tr', {},
    el('td', { text: String(operation.op ?? operation.desc ?? 'command') }),
    el('td', { text: String(operation.ns ?? '—') }),
    el('td', { text: operation.secs_running !== undefined ? `${numberValue(operation.secs_running).toFixed(1)} s` : `${(numberValue(operation.microsecs_running) / 1e6).toFixed(1)} s` })
  ));
  if (!operations.length) body.append(el('tr', {}, el('td', { text: 'No running operations', colSpan: 3 })));
  table.append(body); card.append(table); return card;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function counterRate(current: unknown, previous: unknown, seconds: number): number {
  return Math.max(0, numberValue(current) - numberValue(previous)) / seconds;
}

function rateSeries(current: Record<string, unknown>, previous: Record<string, unknown>, seconds: number, keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, counterRate(current[key], previous[key], seconds)]));
}

function formatMetric(value: number, unit: string): string {
  if (unit === 'bytes/s') return `${formatBytes(value)}/s`;
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function formatDurationMicros(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)} s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} ms`;
  return `${value.toFixed(0)} μs`;
}

// ───────────────────────────── query history ─────────────────────────────

interface HistoryEntry {
  id: string;
  connectionName: string;
  database: string;
  collection: string;
  kind: string;
  text: string;
  status: string;
  error?: string;
  count?: number | null;
  elapsedMS: number;
  timestamp: number;
}

function renderHistory(): HTMLElement {
  const data = state.data as { entries: HistoryEntry[] } | null;
  if (!data || data.entries.length === 0) {
    return empty('No query history yet. Run a query or aggregation.');
  }

  const wrap = el('div');
  const table = el('table', { className: 'mc-table' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of ['When', 'Type', 'Namespace', 'Query', 'Result', '']) {
    headRow.append(el('th', { text: col }));
  }
  thead.append(headRow);
  const tbody = el('tbody');

  for (const entry of data.entries) {
    const row = el('tr');
    row.append(el('td', { text: new Date(entry.timestamp).toLocaleString() }));
    row.append(el('td', { text: entry.kind }));
    row.append(el('td', { className: 'mc-mono', text: `${entry.database}.${entry.collection}` }));
    const queryCell = el('td', { className: 'mc-mono', title: entry.text });
    queryCell.textContent = truncate(entry.text, 60);
    row.append(queryCell);
    const resultText = entry.status === 'error'
      ? `error: ${entry.error ?? ''}`
      : `${formatNumber(entry.count ?? 0)} docs · ${entry.elapsedMS} ms`;
    row.append(el('td', { className: entry.status === 'error' ? 'mc-error-text' : '', text: resultText }));
    const actions = el('td');
    const openBtn = el('button', { className: 'mc-btn icon-only', text: '↗', title: 'Open' });
    openBtn.addEventListener('click', () => void openHistoryEntry(entry.id));
    const removeBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Remove' });
    removeBtn.addEventListener('click', () => void removeHistoryEntry(entry.id));
    actions.append(openBtn, removeBtn);
    row.append(actions);
    tbody.append(row);
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

async function openHistoryEntry(id: string): Promise<void> {
  try {
    await request('openHistoryEntry', { id });
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

async function removeHistoryEntry(id: string): Promise<void> {
  try {
    const result = (await request('removeHistoryEntry', { id })) as { entries: HistoryEntry[] };
    state.data = result;
    render();
    persist();
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

async function clearHistory(): Promise<void> {
  if (!window.confirm('Clear all query history?')) {
    return;
  }
  try {
    const result = (await request('clearHistory')) as { entries: HistoryEntry[] };
    state.data = result;
    render();
    persist();
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

// ───────────────────────────── saved queries ─────────────────────────────

interface SavedQuery {
  id: string;
  name: string;
  database: string;
  collection: string;
  updatedAt: number;
}

interface SavedPipeline {
  id: string;
  name: string;
  database: string;
  collection: string;
  updatedAt: number;
}

function renderSavedQueries(): HTMLElement {
  const data = state.data as { queries: SavedQuery[]; pipelines: SavedPipeline[] } | null;
  if (!data) {
    return empty('No saved queries');
  }

  const wrap = el('div');

  wrap.append(el('div', { className: 'mc-section-title', text: `Saved Queries (${data.queries.length})` }));
  if (data.queries.length === 0) {
    wrap.append(empty('No saved queries. Save one from the Documents view.'));
  } else {
    wrap.append(savedTable(data.queries, 'openSavedQuery', 'deleteSavedQuery'));
  }

  wrap.append(el('div', { className: 'mc-section-title', text: `Saved Pipelines (${data.pipelines.length})` }));
  if (data.pipelines.length === 0) {
    wrap.append(empty('No saved pipelines. Save one from the Aggregation view.'));
  } else {
    wrap.append(savedTable(data.pipelines, 'openSavedPipeline', 'deleteSavedPipeline'));
  }

  return wrap;
}

function savedTable(
  items: Array<{ id: string; name: string; database: string; collection: string; updatedAt: number }>,
  openCommand: string,
  deleteCommand: string
): HTMLElement {
  const table = el('table', { className: 'mc-table' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of ['Name', 'Namespace', 'Updated', '']) {
    headRow.append(el('th', { text: col }));
  }
  thead.append(headRow);
  const tbody = el('tbody');
  for (const item of items) {
    const row = el('tr');
    row.append(el('td', { text: item.name }));
    row.append(el('td', { className: 'mc-mono', text: `${item.database}.${item.collection}` }));
    row.append(el('td', { text: new Date(item.updatedAt).toLocaleString() }));
    const actions = el('td');
    const openBtn = el('button', { className: 'mc-btn icon-only', text: '↗', title: 'Open' });
    openBtn.addEventListener('click', () => void runSavedCommand(openCommand, item.id));
    const deleteBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Delete' });
    deleteBtn.addEventListener('click', () => void runSavedCommand(deleteCommand, item.id, true));
    actions.append(openBtn, deleteBtn);
    row.append(actions);
    tbody.append(row);
  }
  table.append(thead, tbody);
  return table;
}

async function runSavedCommand(command: string, id: string, isDelete = false): Promise<void> {
  if (isDelete && !window.confirm('Delete this item?')) {
    return;
  }
  try {
    const result = (await request(command, { id })) as { queries?: SavedQuery[]; pipelines?: SavedPipeline[] };
    if (result.queries || result.pipelines) {
      state.data = result;
      render();
      persist();
    }
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

// ───────────────────────────── current op ─────────────────────────────

function renderCurrentOp(): HTMLElement {
  const data = state.data as { inprog: Array<Record<string, unknown>>; error?: string } | null;
  if (!data) {
    return empty('No operations data');
  }

  const wrap = el('div');
  if (data.error) {
    wrap.append(el('div', { className: 'mc-insight', text: `currentOp: ${data.error}` }));
  }

  const ops = data.inprog ?? [];
  wrap.append(el('div', { className: 'mc-section-title', text: `Operations (${ops.length})` }));

  if (ops.length === 0) {
    wrap.append(empty('No active operations.'));
    return wrap;
  }

  const table = el('table', { className: 'mc-table' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of ['OpId', 'Type', 'Namespace', 'Command', 'Microsecs', '']) {
    headRow.append(el('th', { text: col }));
  }
  thead.append(headRow);
  const tbody = el('tbody');

  for (const op of ops) {
    const row = el('tr');
    row.append(el('td', { className: 'mc-mono', text: String(op.opid ?? op.id ?? '—') }));
    row.append(el('td', { text: String(op.type ?? op.op ?? '—') }));
    row.append(el('td', { className: 'mc-mono', text: String(op.ns ?? '—') }));
    const cmdCell = el('td', { className: 'mc-mono', title: JSON.stringify(op.command ?? {}) });
    cmdCell.textContent = truncate(JSON.stringify(op.command ?? op.desc ?? {}), 50);
    row.append(cmdCell);
    row.append(el('td', { text: formatNumber(Number(op.microsecs ?? 0)) }));
    const actions = el('td');
    if (op.opid !== undefined) {
      const killBtn = el('button', { className: 'mc-btn icon-only', text: '✕', title: 'Kill operation' });
      killBtn.addEventListener('click', () => void killOp(Number(op.opid)));
      actions.append(killBtn);
    }
    row.append(actions);
    tbody.append(row);
  }

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}

async function killOp(opId: number): Promise<void> {
  if (!window.confirm(`Kill operation ${opId}?`)) {
    return;
  }
  try {
    await request('killOp', { opId });
    setStatusMessage(`Operation ${opId} killed.`);
    await refresh();
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

// ───────────────────────────── shared helpers ─────────────────────────────

function empty(message: string): HTMLElement {
  return el('div', { className: 'mc-empty' }, el('span', { text: message }));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function setStatusMessage(message: string, isError = false): void {
  clear(statusTextEl);
  statusTextEl.append(el('span', { className: isError ? 'error' : '', text: message }));
}

// ───────────────────────────── modal infrastructure ─────────────────────────────

interface ModalOptions {
  title: string;
  body: HTMLElement;
  primaryLabel: string;
  onPrimary: (getValue: () => string) => void | Promise<void>;
  hideSecondary?: boolean;
}

const fieldValues = new Map<string, () => string>();
let errorEl: HTMLElement | undefined;

function getValue(): string {
  const first = fieldValues.values().next();
  return first.done ? '' : first.value();
}

function getValues(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, getter] of fieldValues) {
    result[key] = getter();
  }
  return result;
}

function openModal(options: ModalOptions): void {
  closeModal();
  const backdrop = el('div', { className: 'mc-modal-backdrop' });
  const modal = el('div', { className: 'mc-modal' });
  modal.append(el('h3', { text: options.title }));
  modal.append(options.body);

  errorEl = el('div', { className: 'mc-error-text' });
  errorEl.style.marginTop = '8px';
  errorEl.style.display = 'none';
  modal.append(errorEl);

  const actions = el('div', { className: 'mc-modal-actions' });
  if (!options.hideSecondary) {
    const cancel = el('button', { className: 'mc-btn', text: 'Cancel' });
    cancel.addEventListener('click', closeModal);
    actions.append(cancel);
  }
  const primary = el('button', { className: 'mc-btn primary', text: options.primaryLabel });
  primary.addEventListener('click', () => void options.onPrimary(getValue));
  actions.append(primary);
  modal.append(actions);

  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  });
  modalRoot.append(backdrop);
}

function closeModal(): void {
  clear(modalRoot);
  errorEl = undefined;
  fieldValues.clear();
}

function showFieldError(message: string): void {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
}

function editorField(label: string, value: string, rows: number, key: string): HTMLElement {
  const wrap = el('div', { className: 'mc-field' });
  wrap.style.marginBottom = '8px';
  wrap.append(el('label', { text: label }));
  const editor = createSyntaxEditor(value, rows);
  const textarea = editor.textarea;
  wrap.append(editor.element);
  fieldValues.set(key, () => textarea.value);
  return wrap;
}

function numberField(label: string, value: number, key: string): HTMLElement {
  const wrap = el('div', { className: 'mc-field' });
  wrap.style.marginBottom = '8px';
  wrap.append(el('label', { text: label }));
  const input = el('input', { className: 'mc-input', type: 'number' }) as HTMLInputElement;
  input.value = String(value);
  wrap.append(input);
  fieldValues.set(key, () => input.value);
  return wrap;
}
