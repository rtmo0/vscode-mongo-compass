import {
  request,
  on,
  getState,
  setState,
  el,
  clear,
  escapeHtml,
  createSyntaxEditor,
  createExplainView,
  createDocumentList,
  createDocumentJsonList,
  highlightJson,
  attachInputHighlight,
  formatJsonCell,
  formatNumber,
  debounce
} from '../shared/client';
import { attachQueryAutocomplete, toFieldInfo, type FieldInfo, type FieldPathSample } from '../shared/queryAutocomplete';

interface QueryState {
  filter: Record<string, unknown>;
  filterText: string;
  project: Record<string, unknown>;
  projectText: string;
  sort: Record<string, unknown>;
  sortText: string;
  collation: Record<string, unknown> | null;
  collationText: string;
  skip: number;
  limit: number;
  maxTimeMS: number;
}

interface FindResult {
  documents: string[];
  count: number | null;
  totalCount: number | null;
  elapsedMS: number;
  aborted?: boolean;
  query: QueryState;
}

interface IndexInfo {
  name: string;
  key: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  partialFilterExpression?: unknown;
  collation?: unknown;
  hidden?: boolean;
}

interface IndexesData {
  indexes: IndexInfo[];
  indexStats: Array<{
    name?: string;
    accesses?: { ops?: number; since?: string | { $date?: string } };
  }>;
  indexStatsError?: string;
  indexSizes: Record<string, number>;
}

interface SchemaType {
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
}

interface SchemaField {
  path: string;
  name: string;
  count: number;
  probability: number;
  types: SchemaType[];
}

interface SchemaData {
  namespace: string;
  sampledDocuments: number;
  totalDocuments: number | null;
  fields: SchemaField[];
  suggestions: string[];
  elapsedMS: number;
}

interface ValidationData {
  namespace: string;
  validator: unknown;
  validationLevel: string;
  validationAction: string;
}

type SectionId = 'documents' | 'indexes' | 'schema' | 'validation';

interface UiState {
  namespace: string;
  activeSection: SectionId;
  viewMode: 'list' | 'table' | 'json';
  query: QueryState;
  documents: string[];
  count: number | null;
  totalCount: number | null;
  elapsedMS: number;
  indexes: IndexesData | null;
  schema: SchemaData | null;
  validation: ValidationData | null;
  loading: boolean;
  error: string | null;
  /** Informational status message (e.g. "Query cancelled") shown instead of counts. */
  notice?: string | null;
}

const DEFAULT_QUERY: QueryState = {
  filter: {},
  filterText: '',
  project: {},
  projectText: '',
  sort: {},
  sortText: '',
  collation: null,
  collationText: '',
  skip: 0,
  limit: 20,
  maxTimeMS: 60000
};

/** Default limit / maxTimeMS from the extension settings, used by Reset. */
let queryDefaults = { limit: DEFAULT_QUERY.limit, maxTimeMS: DEFAULT_QUERY.maxTimeMS };

function applyConfigDefaults(config?: { defaultLimit: number; maxTimeMS: number }): void {
  if (config) {
    queryDefaults = { limit: config.defaultLimit, maxTimeMS: config.maxTimeMS };
  }
}

let state: UiState = getState<UiState>({
  namespace: '—',
  activeSection: 'documents',
  viewMode: 'list',
  query: DEFAULT_QUERY,
  documents: [],
  count: null,
  totalCount: null,
  elapsedMS: 0,
  indexes: null,
  schema: null,
  validation: null,
  loading: false,
  error: null
});
state.activeSection ??= 'documents';
state.indexes ??= null;
state.schema ??= null;
state.validation ??= null;
// A query in flight when the webview was reloaded will never answer.
state.loading = false;

// ───────────────────────────── element refs ─────────────────────────────

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const namespaceEl = $('namespace');
const filterEl = $<HTMLInputElement>('filter');
const projectEl = $<HTMLInputElement>('project');
const sortEl = $<HTMLInputElement>('sort');
const collationEl = $<HTMLInputElement>('collation');
const skipEl = $<HTMLInputElement>('skip');
const limitEl = $<HTMLInputElement>('limit');
const maxTimeEl = $<HTMLInputElement>('maxTimeMS');
const optionsEl = $('options');
const statusTextEl = $('status-text');
const contentEl = $('content');
const paginationEl = $('pagination');
const pageInfoEl = $('page-info');
const modalRoot = $('modal-root');
const bulkMenuEl = $('bulk-menu');
const documentsToolbarEl = $('documents-toolbar');
const indexesToolbarEl = $('indexes-toolbar');
const schemaToolbarEl = $('schema-toolbar');
const validationToolbarEl = $('validation-toolbar');
const documentsQuerybarEl = $('documents-querybar');

// ───────────────────────────── init ─────────────────────────────

on('init', (payload) => {
  const init = payload as {
    namespace: string;
    query: QueryState;
    viewMode: 'list' | 'table' | 'json';
    config?: { defaultLimit: number; maxTimeMS: number };
  };
  state.namespace = init.namespace;
  state.query = { ...DEFAULT_QUERY, ...init.query };
  state.viewMode = init.viewMode ?? 'list';
  applyConfigDefaults(init.config);
  if (init.config) {
    state.query.limit = state.query.limit || init.config.defaultLimit;
    state.query.maxTimeMS = state.query.maxTimeMS || init.config.maxTimeMS;
  }
  syncInputsFromState();
  render();
  persist();
});

on('refresh', () => {
  void runFind();
});

void request('ready').then((payload) => {
  if (payload) {
    const init = payload as {
      namespace: string;
      query: QueryState;
      viewMode: 'list' | 'table' | 'json';
      config?: { defaultLimit: number; maxTimeMS: number };
    };
    applyConfigDefaults(init.config);
    state.namespace = init.namespace;
    state.query = { ...DEFAULT_QUERY, ...init.query };
    state.viewMode = init.viewMode ?? 'list';
    syncInputsFromState();
    render();
    if (state.activeSection === 'documents') {
      void runFind();
    }
  }
});

// ───────────────────────────── toolbar wiring ─────────────────────────────

$('btn-find').addEventListener('click', () => void runFind());
$('btn-reset').addEventListener('click', () => void resetQuery());
$('btn-cancel').addEventListener('click', () => void request('cancel'));
$('btn-explain').addEventListener('click', () => void showExplain());
$('btn-insert').addEventListener('click', () => showInsertModal());
$('btn-save').addEventListener('click', () => void showSaveQueryModal());
$('btn-export').addEventListener('click', () => void showExportModal());
$('btn-agg').addEventListener('click', () => void request('openAggregation'));
$('btn-bulk').addEventListener('click', (event) => {
  event.stopPropagation();
  bulkMenuEl.hidden = !bulkMenuEl.hidden;
});
$('menu-bulk-update').addEventListener('click', () => {
  bulkMenuEl.hidden = true;
  showBulkUpdateModal();
});
$('menu-bulk-delete').addEventListener('click', () => {
  bulkMenuEl.hidden = true;
  showBulkDeleteModal();
});
document.addEventListener('click', () => {
  bulkMenuEl.hidden = true;
});

$('btn-view-list').addEventListener('click', () => setViewMode('list'));
$('btn-view-table').addEventListener('click', () => setViewMode('table'));
$('btn-view-json').addEventListener('click', () => setViewMode('json'));
$('tab-documents').addEventListener('click', () => switchSection('documents'));
$('tab-indexes').addEventListener('click', () => switchSection('indexes'));
$('tab-schema').addEventListener('click', () => switchSection('schema'));
$('tab-validation').addEventListener('click', () => switchSection('validation'));
$('btn-create-index').addEventListener('click', () => showCreateIndexModal());
$('btn-indexes-refresh').addEventListener('click', () => void loadIndexes());
$('btn-analyze-schema').addEventListener('click', () => showAnalyzeSchemaModal());
$('btn-schema-refresh').addEventListener('click', () => void loadSchema());
$('btn-edit-validation').addEventListener('click', () => showValidationModal());
$('btn-validation-refresh').addEventListener('click', () => void loadValidation());

$('toggle-options').addEventListener('click', () => {
  optionsEl.classList.toggle('collapsed');
  $('toggle-options').textContent = optionsEl.classList.contains('collapsed')
    ? '⚙ Options ▾'
    : '⚙ Options ▴';
});

filterEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    void runFind();
  }
});

for (const input of [filterEl, projectEl, sortEl, collationEl]) {
  attachInputHighlight(input);
}

// Field paths are sampled once per panel and shared by all query inputs.
let queryFields: FieldInfo[] | null = null;
let queryFieldsPromise: Promise<FieldInfo[]> | null = null;
function queryFieldsAtCaret(): FieldInfo[] | Promise<FieldInfo[]> {
  if (queryFields) {
    return queryFields;
  }
  queryFieldsPromise ??= request<FieldPathSample>('schemaFields')
    .then((result) => (queryFields = toFieldInfo(result)))
    .finally(() => {
      queryFieldsPromise = null;
    });
  return queryFieldsPromise;
}
attachQueryAutocomplete(filterEl, { kind: 'filter', fields: queryFieldsAtCaret });
attachQueryAutocomplete(projectEl, { kind: 'project', fields: queryFieldsAtCaret });
attachQueryAutocomplete(sortEl, { kind: 'sort', fields: queryFieldsAtCaret });

for (const input of [projectEl, sortEl, collationEl]) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      void runFind();
    }
  });
}

$('btn-first').addEventListener('click', () => {
  state.query.skip = 0;
  syncInputsFromState();
  void runFind();
});

$('btn-prev').addEventListener('click', () => {
  state.query.skip = Math.max(0, state.query.skip - state.query.limit);
  syncInputsFromState();
  void runFind();
});

$('btn-next').addEventListener('click', () => {
  state.query.skip += state.query.limit;
  syncInputsFromState();
  void runFind();
});

const persist = debounce(() => setState(state), 200);

// ───────────────────────────── query execution ─────────────────────────────

function readQueryFromInputs(): QueryState {
  return {
    ...state.query,
    filterText: filterEl.value,
    projectText: projectEl.value,
    sortText: sortEl.value,
    collationText: collationEl.value,
    skip: Number(skipEl.value) || 0,
    limit: Number(limitEl.value) || 0,
    maxTimeMS: Number(maxTimeEl.value) || 0
  };
}

/** Restore every query bar field to its default and run Find. */
async function resetQuery(): Promise<void> {
  state.query = { ...DEFAULT_QUERY, ...queryDefaults };
  syncInputsFromState();
  await runFind();
}

/** Sequence number of the latest Find; responses to older Finds are ignored. */
let findSequence = 0;

async function runFind(): Promise<void> {
  const query = readQueryFromInputs();
  const sequence = ++findSequence;
  state.query = query;
  state.loading = true;
  state.error = null;
  state.notice = null;
  render();
  persist();

  try {
    const result = (await request('find', { query })) as FindResult;
    if (sequence !== findSequence) {
      return;
    }
    if (result.aborted) {
      // Keep the previously shown documents; just report the cancellation.
      state.notice = 'Query cancelled.';
      return;
    }
    state.documents = result.documents ?? [];
    state.count = result.count ?? null;
    state.totalCount = result.totalCount ?? null;
    state.elapsedMS = result.elapsedMS ?? 0;
    if (result.query) {
      state.query = { ...state.query, ...result.query };
      syncInputsFromState();
    }
  } catch (err) {
    if (sequence !== findSequence) {
      return;
    }
    state.error = (err as Error).message;
    state.documents = [];
  } finally {
    if (sequence === findSequence) {
      state.loading = false;
      render();
      persist();
    }
  }
}

function setViewMode(mode: 'list' | 'table' | 'json'): void {
  state.viewMode = mode;
  void request('setViewMode', { mode });
  render();
  persist();
}

function switchSection(section: SectionId): void {
  state.activeSection = section;
  render();
  persist();
  if (section === 'indexes' && !state.indexes) {
    void loadIndexes();
  } else if (section === 'schema' && !state.schema) {
    void loadSchema();
  } else if (section === 'validation' && !state.validation) {
    void loadValidation();
  }
}

async function loadIndexes(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    state.indexes = await request<IndexesData>('indexes');
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

async function loadSchema(queryText?: string, sampleSize?: number): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const result = await request<{ data: SchemaData }>('analyzeSchema', { queryText, sampleSize });
    state.schema = result.data;
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

async function loadValidation(): Promise<void> {
  state.loading = true;
  state.error = null;
  render();
  try {
    const result = await request<{ data: ValidationData }>('getValidation');
    state.validation = result.data;
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

// ───────────────────────────── rendering ─────────────────────────────

function render(): void {
  namespaceEl.textContent = state.namespace;
  $('indexes-namespace').textContent = state.namespace;
  $('schema-namespace').textContent = state.namespace;
  $('validation-namespace').textContent = state.namespace;
  renderSectionTabs();
  renderViewButtons();
  renderStatus();
  renderContent();
  renderPagination();
  ($('btn-cancel') as HTMLButtonElement).disabled = !state.loading;
}

function renderSectionTabs(): void {
  const section = state.activeSection;
  documentsToolbarEl.hidden = section !== 'documents';
  documentsQuerybarEl.hidden = section !== 'documents';
  indexesToolbarEl.hidden = section !== 'indexes';
  schemaToolbarEl.hidden = section !== 'schema';
  validationToolbarEl.hidden = section !== 'validation';
  for (const [id, idSection] of [
    ['tab-documents', 'documents'],
    ['tab-indexes', 'indexes'],
    ['tab-schema', 'schema'],
    ['tab-validation', 'validation']
  ] as const) {
    const button = $(id);
    const active = section === idSection;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  }
}

function renderViewButtons(): void {
  for (const [id, mode] of [
    ['btn-view-list', 'list'],
    ['btn-view-json', 'json'],
    ['btn-view-table', 'table']
  ] as const) {
    const button = $(id);
    button.classList.toggle('active', state.viewMode === mode);
    button.setAttribute('aria-pressed', String(state.viewMode === mode));
  }
}

function renderStatus(): void {
  clear(statusTextEl);
  if (state.loading) {
    statusTextEl.append(el('span', { className: 'mc-spinner' }), ' Querying…');
    return;
  }
  if (state.error) {
    statusTextEl.append(el('span', { className: 'error', text: state.error }));
    return;
  }
  if (state.activeSection === 'indexes') {
    statusTextEl.textContent = state.indexes
      ? `${formatNumber(state.indexes.indexes.length)} indexes`
      : 'Index information';
    return;
  }
  if (state.activeSection === 'schema') {
    statusTextEl.textContent = state.schema
      ? `${formatNumber(state.schema.fields.length)} fields · ${formatNumber(state.schema.sampledDocuments)} sampled`
      : 'Schema analysis';
    return;
  }
  if (state.activeSection === 'validation') {
    statusTextEl.textContent = state.validation
      ? `Level: ${state.validation.validationLevel} · Action: ${state.validation.validationAction}`
      : 'Validation rules';
    return;
  }
  if (state.notice) {
    statusTextEl.textContent = state.notice;
    return;
  }
  const parts: string[] = [];
  if (state.count !== null) {
    parts.push(`${formatNumber(state.count)} matched`);
  }
  parts.push(`${formatNumber(state.documents.length)} shown`);
  if (state.totalCount !== null) {
    parts.push(`${formatNumber(state.totalCount)} total`);
  }
  if (state.elapsedMS) {
    parts.push(`${state.elapsedMS} ms`);
  }
  statusTextEl.textContent = parts.join(' · ');
}

function renderContent(): void {
  clear(contentEl);

  if (state.loading) {
    const loadingText =
      state.activeSection === 'indexes' ? 'Loading indexes…' :
      state.activeSection === 'schema' ? 'Analyzing schema…' :
      state.activeSection === 'validation' ? 'Loading validation rules…' :
      'Loading documents…';
    contentEl.append(
        el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), loadingText)
    );
    return;
  }

  if (state.activeSection === 'indexes') {
    contentEl.append(renderIndexes());
    return;
  }

  if (state.activeSection === 'schema') {
    contentEl.append(renderSchema());
    return;
  }

  if (state.activeSection === 'validation') {
    contentEl.append(renderValidation());
    return;
  }

  if (state.documents.length === 0) {
    contentEl.append(
      el(
        'div',
        { className: 'mc-empty' },
        el('span', { text: state.error ? '' : 'No documents to show.' }),
        el('span', { className: 'mc-muted', text: 'Adjust the filter and press Find.' })
      )
    );
    return;
  }

  switch (state.viewMode) {
    case 'table':
      contentEl.append(renderTable());
      break;
    case 'json':
      contentEl.append(renderJson());
      break;
    default:
      contentEl.append(renderList());
      break;
  }
}

function renderIndexes(): HTMLElement {
  const wrap = el('div', { className: 'mc-indexes-view' });
  const data = state.indexes;
  if (!data || data.indexes.length === 0) {
    return el('div', { className: 'mc-empty', text: 'No indexes on this collection.' });
  }

  if (data.indexStatsError) {
    wrap.append(
      el('div', { className: 'mc-index-warning' },
        el('strong', { text: 'Usage statistics unavailable: ' }),
        data.indexStatsError
      )
    );
  }

  const usageByName = new Map(data.indexStats.map((stat) => [stat.name, stat.accesses]));
  const scroll = el('div', { className: 'mc-index-table-scroll' });
  const table = el('table', { className: 'mc-index-table' });
  const head = el('tr');
  for (const title of ['Name & Definition', 'Type', 'Size', 'Usage', 'Properties', 'Status', '']) {
    head.append(el('th', {}, el('span', { text: title }), title ? el('span', { className: 'mc-index-sort', text: '↕' }) : ''));
  }
  const tbody = el('tbody');

  for (const index of data.indexes) {
    const row = el('tr');
    const definition = el('details', { className: 'mc-index-definition' });
    definition.append(
      el('summary', {}, el('span', { className: 'mc-index-name', text: index.name })),
      el('div', { className: 'mc-index-keys mc-mono', text: formatIndexKeys(index.key) })
    );
    row.append(el('td', {}, definition));
    row.append(el('td', {}, indexBadge(indexType(index), 'neutral')));
    row.append(el('td', { text: formatIndexBytes(data.indexSizes[index.name]) }));
    const usage = formatIndexUsage(usageByName.get(index.name), data.indexStatsError);
    row.append(el('td', { text: usage.text, title: usage.title }));

    const properties = el('td', { className: 'mc-index-properties' });
    const labels = indexProperties(index);
    if (labels.length === 0) properties.textContent = '—';
    for (const label of labels) properties.append(indexBadge(label, 'neutral'));
    row.append(properties);
    row.append(el('td', {}, indexBadge(index.hidden ? 'HIDDEN' : 'READY', index.hidden ? 'neutral' : 'success')));

    const actions = el('td');
    if (index.name !== '_id_') {
      const drop = el('button', { className: 'mc-index-drop', text: '×', title: `Drop ${index.name}` });
      drop.addEventListener('click', () => void dropEmbeddedIndex(index.name));
      actions.append(drop);
    }
    row.append(actions);
    tbody.append(row);
  }

  table.append(el('thead', {}, head), tbody);
  scroll.append(table);
  wrap.append(scroll);
  return wrap;
}

function indexBadge(text: string, tone: 'neutral' | 'success'): HTMLElement {
  return el('span', { className: `mc-index-badge ${tone}`, text });
}

function indexType(index: IndexInfo): string {
  const values = Object.values(index.key ?? {});
  if (values.includes('text')) return 'TEXT';
  if (values.includes('2d')) return '2D';
  if (values.includes('2dsphere')) return '2DSPHERE';
  if (values.includes('hashed')) return 'HASHED';
  if (Object.keys(index.key ?? {}).some((field) => field === '$**' || field.endsWith('.$**'))) return 'WILDCARD';
  return 'REGULAR';
}

function indexProperties(index: IndexInfo): string[] {
  const properties: string[] = [];
  if (index.unique) properties.push('UNIQUE');
  if (index.sparse) properties.push('SPARSE');
  if (index.expireAfterSeconds !== undefined) properties.push(`TTL ${index.expireAfterSeconds}s`);
  if (index.partialFilterExpression) properties.push('PARTIAL');
  if (index.collation) properties.push('COLLATION');
  if (index.hidden) properties.push('HIDDEN');
  return properties;
}

function formatIndexKeys(keys: Record<string, unknown>): string {
  return Object.entries(keys ?? {})
    .map(([field, direction]) => `${field}: ${direction === 1 ? 'ascending' : direction === -1 ? 'descending' : String(direction)}`)
    .join(', ');
}

function formatIndexBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes <= 0) return '0 B';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatIndexUsage(
  accesses: { ops?: number; since?: string | { $date?: string } } | undefined,
  error?: string
): { text: string; title: string } {
  if (!accesses) {
    return {
      text: error ? 'Unavailable (hover for details)' : 'No usage data',
      title: error ?? 'MongoDB returned no $indexStats entry for this index.'
    };
  }
  const rawSince = typeof accesses.since === 'string' ? accesses.since : accesses.since?.$date;
  const since = rawSince ? new Date(rawSince) : null;
  const date = since && !Number.isNaN(since.getTime())
    ? since.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' })
    : 'unknown';
  const text = `${formatNumber(accesses.ops ?? 0)} (since ${date})`;
  return { text, title: text };
}

function dropEmbeddedIndex(name: string): void {
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
        await loadIndexes();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

// ───────────────────────────── schema ─────────────────────────────

function renderSchema(): HTMLElement {
  const data = state.schema;
  if (!data) {
    return el('div', { className: 'mc-empty' },
      el('span', { text: 'No schema data. Click "Analyze" to sample this collection.' })
    );
  }

  const wrap = el('div', { className: 'mc-schema-view' });

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
    wrap.append(el('div', { className: 'mc-empty', text: 'No fields found in the sample.' }));
    return wrap;
  }

  const table = el('table', { className: 'mc-table mc-schema-table' });
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

function showAnalyzeSchemaModal(): void {
  const body = el('div');
  const queryEditor = createSyntaxEditor('{}', 4);
  const queryField = el('div', { className: 'mc-field' });
  queryField.append(el('label', { text: 'Query filter (optional)' }), queryEditor.element);

  const sampleSizeWrap = el('div', { className: 'mc-field' });
  const sampleSizeInput = el('input', { className: 'mc-input', type: 'number' }) as HTMLInputElement;
  sampleSizeInput.value = '1000';
  sampleSizeWrap.append(el('label', { text: 'Sample size' }), sampleSizeInput);

  body.append(queryField, sampleSizeWrap);

  openModal({
    title: 'Analyze schema',
    body,
    primaryLabel: 'Analyze',
    onPrimary: async () => {
      const queryText = queryEditor.textarea.value.trim();
      const sampleSize = Number(sampleSizeInput.value) || 1000;
      closeModal();
      await loadSchema(queryText, sampleSize);
    }
  });
}

// ───────────────────────────── validation ─────────────────────────────

function hasValidator(data: ValidationData | null): boolean {
  if (!data?.validator || typeof data.validator !== 'object') {
    return false;
  }
  const validator = data.validator as Record<string, unknown>;
  const keys = Object.keys(validator);
  if (keys.length === 0) {
    return false;
  }
  // A validator that only wraps an empty `$jsonSchema` (e.g. after removing
  // the last rule) is effectively empty — show the zero-state.
  if (keys.length === 1 && keys[0] === '$jsonSchema') {
    const schema = validator.$jsonSchema as Record<string, unknown> | undefined;
    if (schema && typeof schema === 'object') {
      const properties = schema.properties;
      const meaningfulKeys = Object.keys(schema).filter((k) => k !== 'bsonType');
      const hasProperties = properties && typeof properties === 'object' && Object.keys(properties as object).length > 0;
      const hasOtherRules = meaningfulKeys.some((k) => {
        const value = schema[k];
        if (k === 'required') {
          return Array.isArray(value) && value.length > 0;
        }
        return value !== undefined;
      });
      if (!hasProperties && !hasOtherRules) {
        return false;
      }
    }
  }
  return true;
}

function renderValidation(): HTMLElement {
  const data = state.validation;
  if (!data) {
    return el('div', { className: 'mc-empty' },
      el('span', { text: 'No validation data.' })
    );
  }

  const wrap = el('div', { className: 'mc-validation-view' });

  if (!hasValidator(data)) {
    // Compass zero-state: no rules yet, offer generate / add-rule actions.
    const zero = el('div', { className: 'mc-validation-zero' });
    zero.append(
      el('div', { className: 'mc-zero-title', text: 'Create validation rules' }),
      el('p', {
        className: 'mc-muted',
        text: 'Generate rules via schema analysis from existing sample data, or add them manually to enforce document structure during updates and inserts.'
      })
    );
    const actions = el('div', { className: 'mc-zero-actions' });
    const generateBtn = el('button', { className: 'mc-btn primary', text: 'Generate rules' });
    generateBtn.addEventListener('click', () => void generateValidationRules());
    const addRuleBtn = el('button', { className: 'mc-btn', text: 'Add rule' });
    addRuleBtn.addEventListener('click', () => showValidationModal());
    actions.append(generateBtn, addRuleBtn);
    zero.append(actions);
    wrap.append(zero);
    return wrap;
  }

  const summary = el('dl', { className: 'mc-kv' });
  summary.append(
    el('dt', { text: 'Namespace' }), el('dd', { text: data.namespace }),
    el('dt', { text: 'Level' }), el('dd', { text: data.validationLevel }),
    el('dt', { text: 'Action' }), el('dd', { text: data.validationAction })
  );
  wrap.append(summary);

  const schema = extractJsonSchema(data.validator);
  if (schema) {
    wrap.append(el('div', { className: 'mc-section-title', text: 'Rules' }));
    const rules = Object.keys(schema.properties);
    if (rules.length === 0) {
      wrap.append(el('div', { className: 'mc-muted', text: 'No field rules (validator uses a custom expression).' }));
    } else {
      const list = el('div', { className: 'mc-validation-rules' });
      for (const field of rules) {
        const rule = schema.properties[field];
        const row = el('div', { className: 'mc-validation-rule' });
        const info = el('div', { className: 'mc-validation-rule-info' });
        info.append(
          el('span', { className: 'mc-mono', text: field }),
          el('span', { className: 'mc-muted', text: formatRuleType(rule.bsonType) })
        );
        if (schema.required.includes(field)) {
          info.append(el('span', { className: 'mc-badge', text: 'required' }));
        }
        if (rule.unique) {
          info.append(el('span', { className: 'mc-badge', text: 'unique' }));
        }
        const removeBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: `Remove ${field} rule`, type: 'button' });
        removeBtn.addEventListener('click', () => void removeValidationRule(field));
        row.append(info, removeBtn);
        list.append(row);
      }
      wrap.append(list);
    }
  }

  wrap.append(el('div', { className: 'mc-section-title', text: 'Validator' }));
  const pre = el('pre', { className: 'mc-mono' });
  pre.innerHTML = highlightJson(data.validator);
  wrap.append(pre);
  return wrap;
}

function formatRuleType(bsonType: unknown): string {
  if (Array.isArray(bsonType)) {
    return bsonType.join(' | ');
  }
  return String(bsonType ?? 'unknown');
}

/** Remove a single field rule from the stored validator and persist it. */
async function removeValidationRule(field: string): Promise<void> {
  const data = state.validation;
  if (!data?.validator || typeof data.validator !== 'object') {
    return;
  }
  const validator = JSON.parse(JSON.stringify(data.validator)) as Record<string, unknown>;
  const schema = (validator.$jsonSchema ?? {}) as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];

  delete properties[field];
  schema.properties = properties;
  const remainingRequired = required.filter((f) => f !== field);
  if (remainingRequired.length > 0) {
    schema.required = remainingRequired;
  } else {
    delete schema.required; // an empty required array is invalid in $jsonSchema
  }

  // When no field rules remain, clear the validator entirely so the tab
  // returns to the zero-state (instead of an empty $jsonSchema).
  const remainingFields = Object.keys(properties);
  const validatorText =
    remainingFields.length === 0
      ? ''
      : JSON.stringify(validator, null, 2);

  try {
    await request('setValidation', {
      validatorText,
      validationLevel: data.validationLevel,
      validationAction: data.validationAction
    });
    await loadValidation();
    setStatusMessage(
      remainingFields.length === 0
        ? 'Validation rules removed.'
        : `Rule for "${field}" removed.`
    );
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

/** Generate validation rules from schema analysis (Compass "Generate rules"). */
async function generateValidationRules(): Promise<void> {
  setStatusMessage('Generating rules from schema analysis…');
  try {
    const result = await request<{
      validator: Record<string, unknown>;
      validationLevel: string;
      validationAction: string;
      sampledDocuments: number;
      totalDocuments: number | null;
    }>('generateValidation', {});
    await request('setValidation', {
      validatorText: JSON.stringify(result.validator, null, 2),
      validationLevel: result.validationLevel,
      validationAction: result.validationAction
    });
    await loadValidation();
    setStatusMessage(`Validation rules generated from ${formatNumber(result.sampledDocuments)} sampled documents.`);
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

const BSON_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'objectId',
  'date',
  'timestamp',
  'object',
  'array',
  'null',
  'binData',
  'regex',
  'uuid'
];

/** Open the Validation editor: rule builder + raw JSON editor + level/action. */
function showValidationModal(): void {
  const data = state.validation;
  // Existing $jsonSchema (when present) seeds the builder.
  const existingSchema = extractJsonSchema(data?.validator);
  const workingSchema: {
    bsonType: string;
    required: string[];
    properties: Record<string, { bsonType: string; unique?: boolean }>;
  } = existingSchema ?? { bsonType: 'object', required: [], properties: {} };

  const body = el('div', { className: 'mc-validation-form' });

  // ── rule builder ──
  const builderTitle = el('div', { className: 'mc-section-title', text: 'Rule builder' });
  body.append(builderTitle);

  const rulesList = el('div', { className: 'mc-validation-rules' });

  // ── raw editor (created first so the builder can sync it) ──
  const initialSchema: Record<string, unknown> = {
    bsonType: workingSchema.bsonType,
    properties: workingSchema.properties
  };
  if (workingSchema.required.length > 0) {
    initialSchema.required = workingSchema.required;
  }
  const currentValidator = data?.validator
    ? JSON.stringify(data.validator, null, 2)
    : JSON.stringify({ $jsonSchema: initialSchema }, null, 2);
  const validatorEditor = createSyntaxEditor(currentValidator, 14);

  const syncRawEditor = (): void => {
    const schemaToEmit: Record<string, unknown> = {
      bsonType: workingSchema.bsonType,
      properties: workingSchema.properties
    };
    if (workingSchema.required.length > 0) {
      schemaToEmit.required = workingSchema.required;
    }
    validatorEditor.textarea.value = JSON.stringify({ $jsonSchema: schemaToEmit }, null, 2);
    validatorEditor.textarea.dispatchEvent(new Event('input'));
  };

  const renderRules = (): void => {
    clear(rulesList);
    const fields = Object.keys(workingSchema.properties);
    if (fields.length === 0) {
      rulesList.append(el('div', { className: 'mc-muted', text: 'No rules yet. Add a field rule below.' }));
    }
    for (const field of fields) {
      const rule = workingSchema.properties[field];
      const row = el('div', { className: 'mc-validation-rule' });
      const info = el('div', { className: 'mc-validation-rule-info' });
      info.append(
        el('span', { className: 'mc-mono', text: field }),
        el('span', { className: 'mc-muted', text: formatRuleType(rule.bsonType) })
      );
      if (workingSchema.required.includes(field)) {
        info.append(el('span', { className: 'mc-badge', text: 'required' }));
      }
      if (rule.unique) {
        info.append(el('span', { className: 'mc-badge', text: 'unique' }));
      }
      const removeBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: `Remove ${field} rule`, type: 'button' });
      removeBtn.addEventListener('click', () => {
        delete workingSchema.properties[field];
        workingSchema.required = workingSchema.required.filter((f) => f !== field);
        renderRules();
        syncRawEditor();
      });
      row.append(info, removeBtn);
      rulesList.append(row);
    }
  };

  const fieldSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  const fieldOption = el('option', { value: '', text: '— loading fields… —' }) as HTMLOptionElement;
  fieldSelect.append(fieldOption);
  // Load field suggestions in the background so the modal opens instantly.
  void request<{ fields: string[] }>('schemaFields')
    .then((result) => {
      fieldOption.textContent = '— pick an existing field —';
      for (const field of result.fields ?? []) {
        fieldSelect.append(el('option', { value: field, text: field }) as HTMLOptionElement);
      }
    })
    .catch(() => {
      fieldOption.textContent = '— type a field name —';
    });
  const customField = el('input', { className: 'mc-input', placeholder: 'or type a field name' }) as HTMLInputElement;
  customField.addEventListener('input', () => {
    fieldSelect.value = '';
  });
  fieldSelect.addEventListener('change', () => {
    if (fieldSelect.value) {
      customField.value = '';
    }
  });

  const typeSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const type of BSON_TYPES) {
    typeSelect.append(el('option', { value: type, text: type }));
  }
  const requiredCheck = createCheckbox('Required');
  const uniqueCheck = createCheckbox('Unique');

  const addRuleButton = el('button', { className: 'mc-btn', text: '＋ Add rule', type: 'button' });
  addRuleButton.addEventListener('click', () => {
    const field = (fieldSelect.value || customField.value).trim();
    if (!field) {
      showFieldError('Choose a field or type a name first.');
      return;
    }
    workingSchema.properties[field] = {
      bsonType: typeSelect.value,
      unique: uniqueCheck.input.checked || undefined
    };
    if (requiredCheck.input.checked && !workingSchema.required.includes(field)) {
      workingSchema.required.push(field);
    }
    if (!requiredCheck.input.checked) {
      workingSchema.required = workingSchema.required.filter((f) => f !== field);
    }
    customField.value = '';
    fieldSelect.value = '';
    requiredCheck.input.checked = false;
    uniqueCheck.input.checked = false;
    renderRules();
    syncRawEditor();
  });

  body.append(
    el('div', { className: 'mc-validation-builder' },
      el('div', { className: 'mc-field' }, el('label', { text: 'Field' }), fieldSelect, customField),
      el('div', { className: 'mc-field' }, el('label', { text: 'Type' }), typeSelect),
      requiredCheck.wrap,
      uniqueCheck.wrap,
      addRuleButton
    ),
    rulesList
  );

  // ── raw editor ──
  const validatorField = el('div', { className: 'mc-field' });
  validatorField.append(el('label', { text: 'Validator JSON (advanced)' }), validatorEditor.element);

  body.append(validatorField);

  // ── level / action ──
  const levelSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const level of ['off', 'strict', 'moderate']) {
    const option = el('option', { value: level, text: level }) as HTMLOptionElement;
    option.selected = data?.validationLevel === level;
    levelSelect.append(option);
  }
  const actionSelect = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const action of ['error', 'warn']) {
    const option = el('option', { value: action, text: action }) as HTMLOptionElement;
    option.selected = data?.validationAction === action;
    actionSelect.append(option);
  }
  const optionsRow = el('div', { className: 'mc-validation-options' });
  optionsRow.append(
    el('div', { className: 'mc-field' }, el('label', { text: 'Validation level' }), levelSelect),
    el('div', { className: 'mc-field' }, el('label', { text: 'Validation action' }), actionSelect)
  );
  body.append(optionsRow);

  renderRules();

  openModal({
    title: 'Edit validation rules',
    body,
    primaryLabel: 'Save',
    onPrimary: async () => {
      try {
        const validatorText = validatorEditor.textarea.value.trim();
        // Ignore an empty validator (no rules): saving `{ $jsonSchema:
        // { bsonType: 'object', properties: {} } }` is pointless and would
        // leave a dangling empty schema on the collection.
        if (!validatorText || isEffectivelyEmptyValidator(validatorText)) {
          closeModal();
          setStatusMessage('No validation rules to save.');
          return;
        }
        await request('setValidation', {
          validatorText,
          validationLevel: levelSelect.value,
          validationAction: actionSelect.value
        });
        closeModal();
        await loadValidation();
        setStatusMessage('Validation rules updated.');
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

/** True when a validator JSON carries no meaningful rules. */
function isEffectivelyEmptyValidator(validatorText: string): boolean {
  try {
    const parsed = JSON.parse(validatorText) as Record<string, unknown>;
    const schema = parsed.$jsonSchema;
    if (!schema || typeof schema !== 'object') {
      return false;
    }
    const obj = schema as Record<string, unknown>;
    const properties = obj.properties;
    const hasProperties =
      properties && typeof properties === 'object' && Object.keys(properties as object).length > 0;
    const required = obj.required;
    const hasRequired = Array.isArray(required) && required.length > 0;
    // Only bsonType/properties/required are considered; anything else means
    // the validator has real content.
    const otherKeys = Object.keys(obj).filter(
      (k) => k !== 'bsonType' && k !== 'properties' && k !== 'required'
    );
    return !hasProperties && !hasRequired && otherKeys.length === 0;
  } catch {
    return false;
  }
}

/** Extract `$jsonSchema` from a stored validator, normalised into the shape the
 * rule builder understands: each property becomes `{ bsonType: string, unique? }`.
 * Nested documents and type arrays are rendered as text but cannot be edited
 * visually — they stay intact in the raw JSON editor. */
function extractJsonSchema(validator: unknown): {
  bsonType: string;
  required: string[];
  properties: Record<string, { bsonType: string; unique?: boolean }>;
} | undefined {
  if (!validator || typeof validator !== 'object') {
    return undefined;
  }
  const schema = (validator as Record<string, unknown>).$jsonSchema;
  if (!schema || typeof schema !== 'object') {
    return undefined;
  }
  const required = Array.isArray((schema as Record<string, unknown>).required)
    ? ((schema as Record<string, unknown>).required as string[])
    : [];
  const rawProperties = ((schema as Record<string, unknown>).properties ?? {}) as Record<
    string,
    unknown
  >;
  const properties: Record<string, { bsonType: string; unique?: boolean }> = {};
  for (const [field, rawRule] of Object.entries(rawProperties)) {
    properties[field] = normaliseRule(field, rawRule);
  }
  return {
    bsonType: String((schema as Record<string, unknown>).bsonType ?? 'object'),
    required,
    properties
  };
}

/** Convert a `$jsonSchema` property entry into the builder's simple form. */
function normaliseRule(_field: string, rawRule: unknown): { bsonType: string; unique?: boolean } {
  if (rawRule && typeof rawRule === 'object' && !Array.isArray(rawRule)) {
    const obj = rawRule as Record<string, unknown>;
    let bsonType = obj.bsonType;
    if (Array.isArray(bsonType)) {
      bsonType = bsonType.join(' | ');
    } else if (bsonType === undefined || bsonType === null) {
      bsonType = 'object';
    }
    const unique = obj.unique === true ? true : undefined;
    return { bsonType: String(bsonType), unique };
  }
  if (Array.isArray(rawRule)) {
    return { bsonType: rawRule.join(' | ') };
  }
  return { bsonType: String(rawRule ?? 'object') };
}

function showCreateIndexModal(): void {
  const body = el('div', { className: 'mc-create-index-form' });
  const fields = el('div', { className: 'mc-index-field-list' });
  const addField = (): void => fields.append(createIndexFieldRow(fields));
  addField();

  const addFieldButton = el('button', { className: 'mc-btn', text: '＋ Add field', type: 'button' });
  addFieldButton.addEventListener('click', addField);

  const nameInput = createFormInput('Index name (optional)', 'MongoDB will generate a name');
  const uniqueInput = createCheckbox('Create unique index');
  const sparseInput = createCheckbox('Create sparse index');
  const ttlInput = createFormInput('TTL seconds (optional)', 'e.g. 3600', 'number');
  const partialInput = createFormTextarea('Partial Filter Expression (optional)', '{\n  \n}');
  const wildcardInput = createFormTextarea('Wildcard Projection (optional)', '{\n  \n}');
  const collationInput = createFormTextarea('Custom Collation (optional)', '{\n  "locale": "en"\n}');

  body.append(
    el('div', { className: 'mc-section-title', text: state.namespace }),
    el('label', { className: 'mc-index-form-label', text: 'Index fields' }),
    fields,
    addFieldButton,
    el('div', { className: 'mc-index-options-title', text: 'Options' }),
    uniqueInput.wrap,
    sparseInput.wrap,
    nameInput.wrap,
    ttlInput.wrap,
    partialInput.wrap,
    wildcardInput.wrap,
    collationInput.wrap
  );

  openModal({
    title: 'Create Index',
    body,
    primaryLabel: 'Create Index',
    onPrimary: async () => {
      const keys: Record<string, unknown> = {};
      for (const row of Array.from(fields.querySelectorAll('.mc-index-field-row'))) {
        const field = (row.querySelector('.mc-index-field-name') as HTMLInputElement | null)?.value.trim() ?? '';
        const type = (row.querySelector('.mc-index-field-type') as HTMLSelectElement | null)?.value ?? '1';
        if (!field) {
          showFieldError('Every index field must have a name.');
          return;
        }
        keys[field] = type === '1' || type === '-1' ? Number(type) : type;
      }

      if (Object.keys(keys).length === 0) {
        showFieldError('Add at least one index field.');
        return;
      }

      try {
        const options: Record<string, unknown> = {};
        if (nameInput.input.value.trim()) options.name = nameInput.input.value.trim();
        if (uniqueInput.input.checked) options.unique = true;
        if (sparseInput.input.checked) options.sparse = true;
        if (ttlInput.input.value.trim()) options.expireAfterSeconds = Number(ttlInput.input.value);
        addJsonOption(options, 'partialFilterExpression', partialInput.input.value);
        addJsonOption(options, 'wildcardProjection', wildcardInput.input.value);
        addJsonOption(options, 'collation', collationInput.input.value);

        const result = await request<{ name: string }>('createIndex', { keys, options });
        closeModal();
        await loadIndexes();
        setStatusMessage(`Index "${result.name}" created.`);
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function createIndexFieldRow(container: HTMLElement): HTMLElement {
  const row = el('div', { className: 'mc-index-field-row' });
  const field = el('input', {
    className: 'mc-input mc-index-field-name',
    placeholder: 'Select or type a field name'
  }) as HTMLInputElement;
  const type = el('select', { className: 'mc-select mc-index-field-type' }) as HTMLSelectElement;
  for (const [value, label] of [
    ['1', 'Ascending'], ['-1', 'Descending'], ['text', 'Text'],
    ['hashed', 'Hashed'], ['2dsphere', '2dsphere'], ['2d', '2d']
  ]) {
    type.append(el('option', { value, text: label }));
  }
  const remove = el('button', { className: 'mc-index-remove-field', text: '×', title: 'Remove field', type: 'button' });
  remove.addEventListener('click', () => {
    if (container.children.length > 1) row.remove();
  });
  row.append(field, type, remove);
  return row;
}

function createFormInput(label: string, placeholder: string, type = 'text'): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { className: 'mc-input', placeholder, type }) as HTMLInputElement;
  const wrap = el('label', { className: 'mc-index-form-control' }, el('span', { text: label }), input);
  return { wrap, input };
}

function createFormTextarea(label: string, value: string): { wrap: HTMLElement; input: HTMLTextAreaElement } {
  const editor = createSyntaxEditor(value, 4);
  const input = editor.textarea;
  const wrap = el('label', { className: 'mc-index-form-control' }, el('span', { text: label }), editor.element);
  return { wrap, input };
}

function createCheckbox(label: string): { wrap: HTMLElement; input: HTMLInputElement } {
  const input = el('input', { type: 'checkbox' }) as HTMLInputElement;
  const wrap = el('label', { className: 'mc-index-checkbox' }, input, el('span', { text: label }));
  return { wrap, input };
}

function addJsonOption(options: Record<string, unknown>, key: string, source: string): void {
  const trimmed = source.trim();
  if (!trimmed || trimmed === '{}') return;
  options[key] = JSON.parse(trimmed);
}

function parsedDocuments(): Array<Record<string, unknown>> {
  return state.documents.map((text) => {
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { __raw: text };
    }
  });
}

function renderList(): HTMLElement {
  return createDocumentList(parsedDocuments(), {
    startIndex: state.query.skip,
    actions: (document, index) => createDocumentActions(document, index)
  });
}

function createDocumentActions(document: Record<string, unknown>, index: number): HTMLElement[] {
  const editButton = el('button', { className: 'mc-btn icon-only', text: '✎', title: 'Edit document' });
  editButton.addEventListener('click', () => showEditModal(document));
  const copyButton = el('button', { className: 'mc-btn icon-only', text: '📋', title: 'Copy document JSON' });
  copyButton.addEventListener('click', () => void copyDocumentText(index));
  const deleteButton = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Delete document' });
  deleteButton.addEventListener('click', () => void deleteDocument(document));
  return [editButton, copyButton, deleteButton];
}

function renderTable(): HTMLElement {
  const docs = parsedDocuments();
  const columns = new Set<string>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      columns.add(key);
    }
  }
  const cols = [...columns];

  const table = el('table', { className: 'mc-table mc-doc-grid' });
  const thead = el('thead');
  const headRow = el('tr');
  headRow.append(el('th', { text: '#' }));
  for (const col of cols) {
    headRow.append(el('th', { text: col }));
  }
  headRow.append(el('th', { text: '' }));
  thead.append(headRow);

  const tbody = el('tbody');
  docs.forEach((doc, index) => {
    const row = el('tr');
    row.append(el('td', { text: String(state.query.skip + index + 1) }));
    for (const col of cols) {
      const cell = el('td', { title: formatJsonCell(doc[col], false) });
      cell.textContent = formatJsonCell(doc[col], true);
      row.append(cell);
    }
    const actions = el('td');
    const editBtn = el('button', { className: 'mc-btn icon-only', text: '✎', title: 'Edit document' });
    editBtn.addEventListener('click', () => showEditModal(doc));
    const copyBtn = el('button', { className: 'mc-btn icon-only', text: '📋', title: 'Copy document JSON' });
    copyBtn.addEventListener('click', () => void copyDocumentText(index));
    const deleteBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Delete document' });
    deleteBtn.addEventListener('click', () => void deleteDocument(doc));
    actions.append(editBtn, copyBtn, deleteBtn);
    row.append(actions);
    tbody.append(row);
  });

  table.append(thead, tbody);
  return el('div', { className: 'mc-table-scroll' }, table);
}

function renderJson(): HTMLElement {
  return createDocumentJsonList(parsedDocuments(), {
    startIndex: state.query.skip,
    actions: (document, index) => createDocumentActions(document, index)
  });
}

function renderPagination(): void {
  if (state.activeSection !== 'documents') {
    paginationEl.style.display = 'none';
    return;
  }
  if (state.documents.length === 0 && state.count === null) {
    paginationEl.style.display = 'none';
    return;
  }
  paginationEl.style.display = 'flex';
  const from = state.query.skip + 1;
  const to = state.query.skip + state.documents.length;
  const total = state.count ?? state.totalCount;
  pageInfoEl.textContent = total !== null ? `${from}–${to} of ${formatNumber(total)}` : `${from}–${to}`;
  setButtonDisabled('btn-first', state.query.skip === 0);
  setButtonDisabled('btn-prev', state.query.skip === 0);
  const hasMore = state.count === null || state.query.skip + state.documents.length < state.count;
  setButtonDisabled('btn-next', !hasMore);
}

/** Enable/disable a button via the `disabled` property, not the attribute.
 * `setAttribute('disabled', 'false')` still disables a button, since any
 * non-empty attribute value counts as disabled in HTML. */
function setButtonDisabled(id: string, disabled: boolean): void {
  ($(id) as HTMLButtonElement).disabled = disabled;
}

function formatId(id: unknown): string {
  if (id === undefined) {
    return '(no _id)';
  }
  if (typeof id === 'object' && id !== null) {
    const obj = id as Record<string, unknown>;
    if (obj.$oid) {
      return `ObjectId(${String(obj.$oid)})`;
    }
    return JSON.stringify(id);
  }
  return String(id);
}

function syncInputsFromState(): void {
  filterEl.value = state.query.filterText ?? '';
  projectEl.value = state.query.projectText ?? '';
  sortEl.value = state.query.sortText ?? '';
  collationEl.value = state.query.collationText ?? '';
  skipEl.value = String(state.query.skip ?? 0);
  limitEl.value = String(state.query.limit ?? 0);
  maxTimeEl.value = String(state.query.maxTimeMS ?? 0);
}

// ───────────────────────────── CRUD ─────────────────────────────

function showInsertModal(): void {
  const template = '{\n  \n}';
  openModal({
    title: `Insert document into ${state.namespace}`,
    body: editorField('Document (JSON / Extended JSON)', template, 18),
    primaryLabel: 'Insert',
    onPrimary: async (getValue) => {
      const text = getValue();
      try {
        const result = (await request('insert', { documentText: text })) as {
          insertedId: string;
          replacedDuplicateId: boolean;
        };
        closeModal();
        setStatusMessage(
          result.replacedDuplicateId
            ? `Inserted with new _id: ${result.insertedId} (the copied _id already existed).`
            : `Inserted _id: ${result.insertedId}`
        );
        await runFind();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function showEditModal(doc: Record<string, unknown>): void {
  const filterText = JSON.stringify({ _id: doc._id });
  const docText = JSON.stringify(doc, null, 2);
  openModal({
    title: `Edit document ${formatId(doc._id)}`,
    body: editorField('Replacement document', docText, 22),
    primaryLabel: 'Save',
    onPrimary: async (getValue) => {
      try {
        await request('update', { filterText, documentText: getValue() });
        closeModal();
        setStatusMessage('Document updated.');
        await runFind();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

async function deleteDocument(doc: Record<string, unknown>): Promise<void> {
  const filterText = JSON.stringify({ _id: doc._id });
  const confirmed = await confirmDelete(formatId(doc._id));
  if (!confirmed) {
    return;
  }
  try {
    const result = (await request('delete', { filterText })) as { deleted: number };
    setStatusMessage(`Deleted ${result.deleted} document(s).`);
    await runFind();
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

/** Show a modal-based confirmation (webviews do not implement `window.confirm`). */
function confirmDelete(label: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: boolean): void => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    openModal({
      title: 'Delete document',
      body: el('div', { className: 'mc-error-text', text: `Delete ${label}? This cannot be undone.` }),
      primaryLabel: 'Delete',
      onPrimary: () => {
        closeModal();
        done(true);
      },
      onCancel: () => done(false)
    });
  });
}

/** Copy a document's canonical Extended JSON to the clipboard. */
async function copyDocumentText(index: number): Promise<void> {
  const label = `Document ${state.query.skip + index + 1}`;
  try {
    await request('copyDocument', { documentText: state.documents[index] });
    setStatusMessage(`${label} copied to clipboard.`);
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

function showBulkUpdateModal(): void {
  const filterText = state.query.filterText.trim() || '{}';
  const body = el('div', { className: 'mc-bulk-form' });
  const filterInput = bulkEditorField('Filter', filterText, 6);
  const updateInput = bulkEditorField('Update', '{\n  "$set": {\n    \n  }\n}', 12);
  const matchCount = el('div', { className: 'mc-muted', text: 'Counting matching documents…' });
  const refreshMatchCount = bindBulkCount(filterInput.textarea, matchCount);
  body.append(filterInput.wrap, updateInput.wrap, matchCount);
  openModal({
    title: 'Bulk update documents',
    body,
    primaryLabel: 'Update documents',
    onPrimary: async () => {
      try {
        const result = (await request('bulkUpdate', {
          filterText: filterInput.textarea.value,
          updateText: updateInput.textarea.value
        })) as { matched: number; modified: number };
        closeModal();
        setStatusMessage(`Matched ${result.matched}, modified ${result.modified} document(s).`);
        await runFind();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    },
    onOpen: refreshMatchCount
  });
}

function showBulkDeleteModal(): void {
  const filterText = state.query.filterText.trim() || '{}';
  const body = el('div', { className: 'mc-bulk-form' });
  const filterInput = bulkEditorField('Filter', filterText, 8);
  const warning = el('div', {
    className: 'mc-error-text',
    text: 'This permanently deletes every document matching the filter.'
  });
  const matchCount = el('div', { className: 'mc-muted', text: 'Counting matching documents…' });
  const refreshMatchCount = bindBulkCount(filterInput.textarea, matchCount);
  body.append(filterInput.wrap, warning, matchCount);
  openModal({
    title: 'Bulk delete documents',
    body,
    primaryLabel: 'Delete documents',
    onPrimary: async () => {
      try {
        const result = (await request('bulkDelete', {
          filterText: filterInput.textarea.value
        })) as { deleted: number };
        closeModal();
        setStatusMessage(`Deleted ${result.deleted} document(s).`);
        await runFind();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    },
    onOpen: refreshMatchCount
  });
}

function bulkEditorField(label: string, value: string, rows: number): {
  wrap: HTMLElement;
  textarea: HTMLTextAreaElement;
} {
  const wrap = el('div', { className: 'mc-field' });
  const editor = createSyntaxEditor(value, rows);
  const textarea = editor.textarea;
  wrap.append(el('label', { text: label }), editor.element);
  return { wrap, textarea };
}

function bindBulkCount(textarea: HTMLTextAreaElement, target: HTMLElement): () => void {
  let requestVersion = 0;
  const refresh = (): void => {
    const version = ++requestVersion;
    target.classList.remove('error');
    target.textContent = 'Counting matching documents…';
    void updateBulkCount(textarea.value, target, () => version === requestVersion);
  };
  textarea.addEventListener('input', debounce(refresh, 300));
  return refresh;
}

async function updateBulkCount(
  filterText: string,
  target: HTMLElement,
  isCurrent: () => boolean
): Promise<void> {
  try {
    const result = (await request('bulkCount', { filterText })) as { count: number };
    if (!isCurrent()) return;
    target.classList.remove('error');
    target.textContent = `${formatNumber(result.count)} document(s) match this filter.`;
  } catch (err) {
    if (!isCurrent()) return;
    target.textContent = (err as Error).message;
    target.classList.add('error');
  }
}

// ───────────────────────────── explain ─────────────────────────────

async function showExplain(): Promise<void> {
  setStatusMessage('Running explain…');
  try {
    const explain = (await request('explain')) as {
      tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
      insights: string[];
      executionStats?: Record<string, unknown>;
      raw: Record<string, unknown>;
      elapsedMS: number;
    };
    renderExplain(explain);
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

function renderExplain(explain: {
  tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
  insights: string[];
  executionStats?: Record<string, unknown>;
  raw: Record<string, unknown>;
}): void {
  openModal({
    title: `Explain plan — ${state.namespace}`,
    body: buildExplainBody(explain),
    primaryLabel: 'Close',
    onPrimary: async () => closeModal(),
    hideSecondary: true
  });
}

function buildExplainBody(explain: {
  tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
  insights: string[];
  executionStats?: Record<string, unknown>;
  raw: Record<string, unknown>;
}): HTMLElement {
  return createExplainView(explain as never);
}

// ───────────────────────────── save / export ─────────────────────────────

async function showSaveQueryModal(): Promise<void> {
  openModal({
    title: 'Save query to My Queries',
    body: textField('Query name', `${state.namespace} query`),
    primaryLabel: 'Save',
    onPrimary: async (getValue) => {
      const name = getValue().trim();
      if (!name) {
        showFieldError('Name is required');
        return;
      }
      try {
        await request('saveQuery', { name });
        closeModal();
        setStatusMessage(`Query "${name}" saved.`);
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

async function showExportModal(): Promise<void> {
  const body = el('div');
  const select = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const format of ['json', 'jsonl', 'csv']) {
    select.append(el('option', { value: format, text: format.toUpperCase() }));
  }
  body.append(
    el('div', { className: 'mc-field' }, el('label', { text: 'Format' }), select),
    el('p', { text: 'All documents matching the current filter will be exported.' })
  );

  openModal({
    title: 'Export filtered documents',
    body,
    primaryLabel: 'Export',
    onPrimary: async () => {
      try {
        const result = await request('exportData', { format: select.value }) as { cancelled?: boolean; exported?: number };
        if (!result.cancelled) {
          closeModal();
          setStatusMessage(`Exported ${result.exported ?? 0} documents.`);
        }
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

// ───────────────────────────── modal infrastructure ─────────────────────────────

interface ModalOptions {
  title: string;
  body: HTMLElement;
  primaryLabel: string;
  onPrimary: (getValue: () => string) => void | Promise<void>;
  hideSecondary?: boolean;
  onOpen?: () => void;
  /** Called when the modal is dismissed without the primary action. */
  onCancel?: () => void;
}

let currentGetValue: () => string = () => '';
let errorEl: HTMLElement | undefined;

function openModal(options: ModalOptions): void {
  closeModal(false);
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
    cancel.addEventListener('click', () => {
      closeModal();
      options.onCancel?.();
    });
    actions.append(cancel);
  }
  const primary = el('button', { className: 'mc-btn primary', text: options.primaryLabel });
  primary.addEventListener('click', () => void options.onPrimary(currentGetValue));
  actions.append(primary);
  modal.append(actions);

  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
      options.onCancel?.();
    }
  });
  modalRoot.append(backdrop);
  options.onOpen?.();
}

function closeModal(resetValue = true): void {
  clear(modalRoot);
  errorEl = undefined;
  if (resetValue) {
    currentGetValue = () => '';
  }
}

function showFieldError(message: string): void {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
}

function editorField(label: string, value: string, rows: number): HTMLElement {
  const wrap = el('div', { className: 'mc-field' });
  wrap.append(el('label', { text: label }));
  const editor = createSyntaxEditor(value, rows);
  const textarea = editor.textarea;
  wrap.append(editor.element);
  currentGetValue = () => textarea.value;
  return wrap;
}

function textField(label: string, value: string): HTMLElement {
  const wrap = el('div', { className: 'mc-field' });
  wrap.append(el('label', { text: label }));
  const input = el('input', { className: 'mc-input' }) as HTMLInputElement;
  input.value = value;
  wrap.append(input);
  currentGetValue = () => input.value;
  return wrap;
}

function setStatusMessage(message: string, isError = false): void {
  clear(statusTextEl);
  statusTextEl.append(
    el('span', { className: isError ? 'error' : '', text: message })
  );
}

void escapeHtml;
