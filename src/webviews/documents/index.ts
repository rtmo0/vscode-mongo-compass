import {
  vscode,
  request,
  on,
  getState,
  setState,
  el,
  clear,
  escapeHtml,
  highlightJson,
  createSyntaxEditor,
  createExplainView,
  formatNumber,
  debounce
} from '../shared/client';

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

interface UiState {
  namespace: string;
  activeSection: 'documents' | 'indexes';
  viewMode: 'list' | 'table' | 'json';
  query: QueryState;
  documents: string[];
  count: number | null;
  totalCount: number | null;
  elapsedMS: number;
  indexes: IndexesData | null;
  loading: boolean;
  error: string | null;
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
  loading: false,
  error: null
});
state.activeSection ??= 'documents';
state.indexes ??= null;

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
    const init = payload as { namespace: string; query: QueryState; viewMode: 'list' | 'table' | 'json' };
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
$('menu-bulk-insert').addEventListener('click', () => {
  bulkMenuEl.hidden = true;
  showBulkInsertModal();
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
$('btn-create-index').addEventListener('click', () => showCreateIndexModal());
$('btn-indexes-refresh').addEventListener('click', () => void loadIndexes());

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

async function runFind(): Promise<void> {
  const query = readQueryFromInputs();
  state.query = query;
  state.loading = true;
  state.error = null;
  render();
  persist();

  try {
    const result = (await request('find', { query })) as FindResult;
    state.documents = result.documents ?? [];
    state.count = result.count ?? null;
    state.totalCount = result.totalCount ?? null;
    state.elapsedMS = result.elapsedMS ?? 0;
    if (result.query) {
      state.query = { ...state.query, ...result.query };
      syncInputsFromState();
    }
  } catch (err) {
    state.error = (err as Error).message;
    state.documents = [];
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

function setViewMode(mode: 'list' | 'table' | 'json'): void {
  state.viewMode = mode;
  void request('setViewMode', { mode });
  render();
  persist();
}

function switchSection(section: 'documents' | 'indexes'): void {
  state.activeSection = section;
  render();
  persist();
  if (section === 'indexes' && !state.indexes) {
    void loadIndexes();
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

// ───────────────────────────── rendering ─────────────────────────────

function render(): void {
  namespaceEl.textContent = state.namespace;
  $('indexes-namespace').textContent = state.namespace;
  renderSectionTabs();
  renderViewButtons();
  renderStatus();
  renderContent();
  renderPagination();
}

function renderSectionTabs(): void {
  const showingIndexes = state.activeSection === 'indexes';
  documentsToolbarEl.hidden = showingIndexes;
  documentsQuerybarEl.hidden = showingIndexes;
  indexesToolbarEl.hidden = !showingIndexes;
  for (const [id, section] of [['tab-documents', 'documents'], ['tab-indexes', 'indexes']] as const) {
    const button = $(id);
    const active = state.activeSection === section;
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
    contentEl.append(
        el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }),
          state.activeSection === 'indexes' ? 'Loading indexes…' : 'Loading documents…')
    );
    return;
  }

  if (state.activeSection === 'indexes') {
    contentEl.append(renderIndexes());
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
  const container = el('div', { className: 'mc-document-list' });
  const docs = parsedDocuments();
  docs.forEach((doc, index) => {
    const idText = formatId(doc._id);
    const card = el('div', { className: 'mc-doc' });

    const header = el('div', { className: 'mc-doc-header' });
    header.append(
      el('span', { className: 'mc-chip', text: `#${state.query.skip + index + 1}` }),
      el('span', { className: 'doc-id', text: idText }),
      el('span', { className: 'spacer' })
    );

    const editBtn = el('button', { className: 'mc-btn icon-only', text: '✎', title: 'Edit document' });
    editBtn.addEventListener('click', () => showEditModal(doc));
    const cloneBtn = el('button', { className: 'mc-btn icon-only', text: '⧉', title: 'Clone document' });
    cloneBtn.addEventListener('click', () => void cloneDocument(doc));
    const deleteBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Delete document' });
    deleteBtn.addEventListener('click', () => void deleteDocument(doc));

    header.append(editBtn, cloneBtn, deleteBtn);

    const body = el('div', { className: 'mc-doc-body mc-tree' });
    for (const [key, value] of Object.entries(doc)) {
      body.append(renderTreeField(key, value, 0));
    }

    card.append(header, body);
    container.append(card);
  });
  return container;
}

function renderTreeField(key: string, value: unknown, depth: number): HTMLElement {
  const branch = isExpandable(value);
  const row = el('div', { className: 'mc-tree-row' });
  row.style.setProperty('--tree-depth', String(depth));

  const toggle = el('button', {
    className: `mc-tree-toggle${branch ? '' : ' leaf'}`,
    text: branch ? '▸' : '',
    title: branch ? 'Expand field' : ''
  });
  const keyNode = el('span', { className: 'mc-tree-key', text: key });
  const separator = el('span', { className: 'mc-tree-separator', text: ':' });
  const valueNode = el('span', {
    className: `mc-tree-value ${valueClass(value)}`,
    text: branch ? valueSummary(value) : formatTreeValue(value)
  });
  row.append(toggle, keyNode, separator, valueNode);

  const field = el('div', { className: 'mc-tree-field' }, row);
  if (!branch) {
    return field;
  }

  const children = el('div', { className: 'mc-tree-children' });
  children.hidden = true;
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
    children.append(renderTreeField(childKey, childValue, depth + 1));
  }
  toggle.addEventListener('click', () => {
    children.hidden = !children.hidden;
    toggle.textContent = children.hidden ? '▸' : '▾';
    toggle.title = children.hidden ? 'Expand field' : 'Collapse field';
  });
  field.append(children);
  return field;
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
      const cell = el('td', { title: formatCell(doc[col], false) });
      cell.textContent = formatCell(doc[col], true);
      row.append(cell);
    }
    const actions = el('td');
    const editBtn = el('button', { className: 'mc-btn icon-only', text: '✎' });
    editBtn.addEventListener('click', () => showEditModal(doc));
    const deleteBtn = el('button', { className: 'mc-btn icon-only', text: '🗑' });
    deleteBtn.addEventListener('click', () => void deleteDocument(doc));
    actions.append(editBtn, deleteBtn);
    row.append(actions);
    tbody.append(row);
  });

  table.append(thead, tbody);
  return el('div', { className: 'mc-table-scroll' }, table);
}

function renderJson(): HTMLElement {
  const container = el('div', { className: 'mc-json-list' });
  parsedDocuments().forEach((document, index) => {
    const block = el('section', { className: 'mc-json-document' });
    block.append(el('div', {
      className: 'mc-json-document-number',
      text: `Document ${state.query.skip + index + 1}`
    }));
    block.append(renderJsonValue(document, 0, true));
    container.append(block);
  });
  return container;
}

function renderJsonValue(value: unknown, depth: number, expanded = false): HTMLElement {
  if (!isJsonExpandable(value)) {
    return el('span', {
      className: `mc-json-value ${valueClass(value)}`,
      text: formatTreeValue(value)
    });
  }

  const isArray = Array.isArray(value);
  const entries = Object.entries(value);
  const open = isArray ? '[' : '{';
  const close = isArray ? ']' : '}';
  const wrapper = el('div', { className: 'mc-json-node' });
  const line = el('div', { className: 'mc-json-line' });
  line.style.setProperty('--json-depth', String(depth));
  const toggle = el('button', {
    className: 'mc-json-toggle',
    text: expanded ? '▾' : '▸',
    title: expanded ? 'Collapse value' : 'Expand value'
  });
  const opener = el('span', { className: 'mc-json-punctuation', text: open });
  const preview = el('span', {
    className: 'mc-json-preview',
    text: expanded ? '' : `${valueSummary(value)} ${close}`
  });
  line.append(toggle, opener, preview);

  const children = el('div', { className: 'mc-json-children' });
  children.hidden = !expanded;
  entries.forEach(([key, childValue], index) => {
    const childLine = el('div', { className: 'mc-json-property' });
    childLine.style.setProperty('--json-depth', String(depth + 1));
    const property = el('span', {
      className: 'mc-json-key',
      text: isArray ? key : `"${key}"`
    });
    childLine.append(property, el('span', { className: 'mc-json-colon', text: ': ' }));
    const rendered = renderJsonValue(childValue, isJsonExpandable(childValue) ? 0 : depth + 1);
    if (isJsonExpandable(childValue)) {
      rendered.classList.add('mc-json-inline-node');
    }
    childLine.append(rendered);
    if (index < entries.length - 1) {
      childLine.append(el('span', { className: 'mc-json-punctuation', text: ',' }));
    }
    children.append(childLine);
  });

  const closing = el('div', { className: 'mc-json-closing' });
  closing.style.setProperty('--json-depth', String(depth));
  closing.textContent = close;
  closing.hidden = !expanded;

  toggle.addEventListener('click', () => {
    const nextExpanded = children.hidden;
    children.hidden = !nextExpanded;
    closing.hidden = !nextExpanded;
    preview.textContent = nextExpanded ? '' : `${valueSummary(value)} ${close}`;
    toggle.textContent = nextExpanded ? '▾' : '▸';
    toggle.title = nextExpanded ? 'Collapse value' : 'Expand value';
  });

  wrapper.append(line, children, closing);
  return wrapper;
}

function renderPagination(): void {
  if (state.activeSection === 'indexes') {
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
  $('btn-first').setAttribute('disabled', state.query.skip === 0 ? 'true' : 'false');
  $('btn-prev').setAttribute('disabled', state.query.skip === 0 ? 'true' : 'false');
  const hasMore = state.count === null || state.query.skip + state.documents.length < state.count;
  $('btn-next').setAttribute('disabled', hasMore ? 'false' : 'true');
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

function formatCell(value: unknown, compact = false): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'object') {
    const bsonValue = formatEjsonScalar(value);
    if (bsonValue !== undefined) {
      return bsonValue;
    }
    if (compact) {
      return valueSummary(value);
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object' && !isEjsonScalar(value);
}

function isJsonExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

function isEjsonScalar(value: object): boolean {
  return formatEjsonScalar(value) !== undefined;
}

function formatEjsonScalar(value: object): string | undefined {
  const obj = value as Record<string, unknown>;
  if (typeof obj.$oid === 'string') {
    return `ObjectId("${obj.$oid}")`;
  }
  if (typeof obj.$numberLong === 'string') {
    return `NumberLong("${obj.$numberLong}")`;
  }
  if (typeof obj.$numberInt === 'string') {
    return `NumberInt("${obj.$numberInt}")`;
  }
  if (typeof obj.$numberDouble === 'string') {
    return `NumberDouble("${obj.$numberDouble}")`;
  }
  if (typeof obj.$numberDecimal === 'string') {
    return `Decimal128("${obj.$numberDecimal}")`;
  }
  if (obj.$timestamp && typeof obj.$timestamp === 'object') {
    const timestamp = obj.$timestamp as Record<string, unknown>;
    return `Timestamp(${String(timestamp.t ?? '?')}, ${String(timestamp.i ?? '?')})`;
  }
  if (typeof obj.$minKey === 'number') {
    return 'MinKey()';
  }
  if (typeof obj.$maxKey === 'number') {
    return 'MaxKey()';
  }
  if (typeof obj.$undefined === 'boolean') {
    return 'undefined';
  }
  if (typeof obj.$regularExpression === 'object' && obj.$regularExpression !== null) {
    const regex = obj.$regularExpression as Record<string, unknown>;
    return `/${String(regex.pattern ?? '')}/${String(regex.options ?? '')}`;
  }
  return undefined;
}

function valueSummary(value: unknown): string {
  if (Array.isArray(value)) {
    return `Array (${value.length})`;
  }
  if (value !== null && typeof value === 'object') {
    return `Object (${Object.keys(value).length})`;
  }
  return formatTreeValue(value);
}

function formatTreeValue(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (typeof value === 'object') {
    return formatCell(value);
  }
  return String(value);
}

function valueClass(value: unknown): string {
  if (value === null) {
    return 'tok-null';
  }
  if (isExpandable(value)) {
    return 'mc-tree-summary';
  }
  if (typeof value === 'string') {
    return 'tok-string';
  }
  if (typeof value === 'number') {
    return 'tok-number';
  }
  if (typeof value === 'boolean') {
    return 'tok-boolean';
  }
  if (typeof value === 'object') {
    return 'tok-bson';
  }
  return '';
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
    body: editorField('Document (EJSON / shell syntax)', template, 18),
    primaryLabel: 'Insert',
    onPrimary: async (getValue) => {
      const text = getValue();
      try {
        const result = (await request('insert', { documentText: text })) as { insertedId: string };
        void vscode;
        closeModal();
        setStatusMessage(`Inserted _id: ${result.insertedId}`);
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
  const confirmed = window.confirm(`Delete document ${formatId(doc._id)}? This cannot be undone.`);
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

async function cloneDocument(doc: Record<string, unknown>): Promise<void> {
  const filterText = JSON.stringify({ _id: doc._id });
  try {
    const result = (await request('clone', { filterText })) as { insertedId: string };
    setStatusMessage(`Cloned document, new _id: ${result.insertedId}`);
    await runFind();
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
}

function showBulkInsertModal(): void {
  const documentsInput = bulkEditorField(
    'Documents (EJSON / shell syntax)',
    '[\n  {\n    \n  },\n  {\n    \n  }\n]',
    18
  );
  const body = el('div', { className: 'mc-bulk-form' });
  body.append(documentsInput.wrap);
  openModal({
    title: `Bulk insert into ${state.namespace}`,
    body,
    primaryLabel: 'Insert documents',
    onPrimary: async () => {
      try {
        const result = (await request('bulkInsert', {
          documentsText: documentsInput.textarea.value
        })) as { inserted: number };
        closeModal();
        setStatusMessage(`Inserted ${result.inserted} document(s).`);
        await runFind();
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function showBulkUpdateModal(): void {
  const filterText = state.query.filterText.trim() || '{}';
  const body = el('div', { className: 'mc-bulk-form' });
  const filterInput = bulkEditorField('Filter', filterText, 6);
  const updateInput = bulkEditorField('Update', '{\n  "$set": {\n    \n  }\n}', 12);
  const matchCount = el('div', { className: 'mc-muted', text: 'Counting matching documents…' });
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
    onOpen: () => void updateBulkCount(filterInput.textarea.value, matchCount)
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
    onOpen: () => void updateBulkCount(filterInput.textarea.value, matchCount)
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

async function updateBulkCount(filterText: string, target: HTMLElement): Promise<void> {
  try {
    const result = (await request('bulkCount', { filterText })) as { count: number };
    target.textContent = `${formatNumber(result.count)} document(s) match this filter.`;
  } catch (err) {
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
  const languages = [
    'shell',
    'javascript',
    'typescript',
    'python',
    'java',
    'csharp',
    'go',
    'php',
    'ruby',
    'rust',
    'compass'
  ];
  const body = el('div');
  const select = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const lang of languages) {
    select.append(el('option', { value: lang, text: lang }));
  }
  body.append(el('div', { className: 'mc-field' }, el('label', { text: 'Language' }), select));
  const output = el('pre', { className: 'mc-mono' });
  output.style.marginTop = '12px';
  output.style.maxHeight = '320px';
  output.style.overflow = 'auto';
  body.append(output);

  const generate = async (): Promise<void> => {
    try {
      const result = (await request('exportToLanguage', { language: select.value })) as { code: string };
      output.innerHTML = highlightJson(result.code);
      output.textContent = result.code;
    } catch (err) {
      output.textContent = (err as Error).message;
    }
  };

  select.addEventListener('change', () => void generate());

  openModal({
    title: 'Export query to language',
    body,
    primaryLabel: 'Copy',
    onPrimary: async () => {
      await vscode.postMessage({ type: 'noop' });
      try {
        const result = (await request('exportToLanguage', { language: select.value })) as { code: string };
        await navigator.clipboard.writeText(result.code);
        closeModal();
        setStatusMessage('Code copied to clipboard.');
      } catch (err) {
        showFieldError((err as Error).message);
      }
    },
    onOpen: () => void generate()
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
}

let currentGetValue: () => string = () => '';
let errorEl: HTMLElement | undefined;

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
  primary.addEventListener('click', () => void options.onPrimary(currentGetValue));
  actions.append(primary);
  modal.append(actions);

  backdrop.append(modal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      closeModal();
    }
  });
  modalRoot.append(backdrop);
  options.onOpen?.();
}

function closeModal(): void {
  clear(modalRoot);
  errorEl = undefined;
  currentGetValue = () => '';
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
