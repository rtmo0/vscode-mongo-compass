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

interface UiState {
  namespace: string;
  viewMode: 'list' | 'table' | 'json';
  query: QueryState;
  documents: string[];
  count: number | null;
  totalCount: number | null;
  elapsedMS: number;
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
  viewMode: 'list',
  query: DEFAULT_QUERY,
  documents: [],
  count: null,
  totalCount: null,
  elapsedMS: 0,
  loading: false,
  error: null
});

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

// ───────────────────────────── rendering ─────────────────────────────

function render(): void {
  namespaceEl.textContent = state.namespace;
  renderViewButtons();
  renderStatus();
  renderContent();
  renderPagination();
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
      el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), 'Loading documents…')
    );
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
    const rendered = renderJsonValue(childValue, depth + 1);
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
  const textarea = el('textarea', { className: 'mc-textarea', rows }) as HTMLTextAreaElement;
  textarea.value = value;
  textarea.spellcheck = false;
  wrap.append(el('label', { text: label }), textarea);
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
  const body = el('div');

  body.append(el('div', { className: 'mc-section-title', text: 'Insights' }));
  for (const insight of explain.insights) {
    body.append(el('div', { className: 'mc-insight', text: insight }));
  }

  body.append(el('div', { className: 'mc-section-title', text: 'Winning plan' }));
  const renderNode = (node: { stage: string; description: string; details: Record<string, string>; children: unknown[] }): HTMLElement => {
    const wrap = el('div', { className: 'mc-explain-node' });
    wrap.append(el('div', { className: 'stage', text: node.stage }));
    wrap.append(el('div', { className: 'desc', text: node.description }));
    const kv = el('dl', { className: 'mc-kv' });
    for (const [key, value] of Object.entries(node.details)) {
      kv.append(el('dt', { text: key }), el('dd', { text: value }));
    }
    wrap.append(kv);
    for (const child of node.children) {
      wrap.append(renderNode(child as never));
    }
    return wrap;
  };
  for (const node of explain.tree) {
    body.append(renderNode(node));
  }

  if (explain.executionStats) {
    body.append(el('div', { className: 'mc-section-title', text: 'Execution stats' }));
    const pre = el('pre', { className: 'mc-mono' });
    pre.innerHTML = highlightJson(explain.executionStats);
    body.append(pre);
  }

  body.append(el('div', { className: 'mc-section-title', text: 'Raw JSON' }));
  const rawPre = el('pre', { className: 'mc-mono' });
  rawPre.innerHTML = highlightJson(explain.raw);
  const details = el('details');
  details.append(el('summary', { text: 'Show raw explain output' }), rawPre);
  body.append(details);

  return body;
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
  const textarea = el('textarea', { className: 'mc-textarea', rows }) as HTMLTextAreaElement;
  textarea.value = value;
  textarea.spellcheck = false;
  wrap.append(textarea);
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
