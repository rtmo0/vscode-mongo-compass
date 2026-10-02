import { request, on, getState, setState, el, clear, createFieldTree, createJsonTree, formatJsonCell, createSyntaxEditor, createExplainView, debounce } from '../shared/client';

interface UiState {
  namespace: string;
  pipelineText: string;
  results: string[];
  count: number | null;
  elapsedMS: number;
  loading: boolean;
  error: string | null;
  warning: string | null;
  panePercent: number;
  viewMode: 'list' | 'table' | 'json';
}

let state = getState<UiState>({ namespace: '—', pipelineText: '[\n  \n]', results: [], count: null, elapsedMS: 0, loading: false, error: null, warning: null, panePercent: 50, viewMode: 'list' });
state.viewMode ??= 'list';
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const namespaceEl = $('namespace');
const statusEl = $('status-text');
const resultsEl = $('results');
const resultsInfo = $('results-info');
const editorHost = $('pipeline-editor');
const suggestionsEl = $('pipeline-suggestions');
const workspaceEl = $('pipeline-resizer').parentElement as HTMLElement;
const resizerEl = $('pipeline-resizer');
const modalRoot = $('modal-root');
const editor = createSyntaxEditor(state.pipelineText, 12);
editorHost.append(editor.element);

function setPanePercent(value: number, persistState = false): void {
  state.panePercent = Math.min(75, Math.max(25, Number.isFinite(value) ? value : 50));
  workspaceEl.style.setProperty('--pipeline-editor-width', `${state.panePercent}%`);
  resizerEl.setAttribute('aria-valuenow', String(Math.round(state.panePercent)));
  if (persistState) setState(state);
}

function resizePanes(clientX: number): void {
  const bounds = workspaceEl.getBoundingClientRect();
  if (bounds.width > 0) setPanePercent((clientX - bounds.left) / bounds.width * 100);
}

resizerEl.addEventListener('pointerdown', (event) => {
  resizerEl.setPointerCapture(event.pointerId);
  resizePanes(event.clientX);
});
resizerEl.addEventListener('pointermove', (event) => {
  if (resizerEl.hasPointerCapture(event.pointerId)) resizePanes(event.clientX);
});
resizerEl.addEventListener('pointerup', (event) => {
  if (resizerEl.hasPointerCapture(event.pointerId)) resizerEl.releasePointerCapture(event.pointerId);
  setPanePercent(state.panePercent, true);
});
resizerEl.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  setPanePercent(state.panePercent + (event.key === 'ArrowLeft' ? -5 : 5), true);
});
setPanePercent(state.panePercent);
const persist = debounce(() => {
  setState(state);
  void request('syncPipeline', { pipelineText: state.pipelineText }).catch(() => undefined);
}, 200);

const PIPELINE_COMPLETIONS = [
  { label: '$match', detail: 'Filter documents', insert: '{\n    $match: {\n      field: value\n    }\n  }' },
  { label: '$project', detail: 'Select or compute fields', insert: '{\n    $project: {\n      field: 1\n    }\n  }' },
  { label: '$group', detail: 'Group documents', insert: '{\n    $group: {\n      _id: "$field",\n      count: { $sum: 1 }\n    }\n  }' },
  { label: '$sort', detail: 'Sort documents', insert: '{\n    $sort: {\n      field: 1\n    }\n  }' },
  { label: '$limit', detail: 'Limit result count', insert: '{ $limit: 100 }' },
  { label: '$skip', detail: 'Skip documents', insert: '{ $skip: 0 }' },
  { label: '$unwind', detail: 'Expand an array', insert: '{ $unwind: "$field" }' },
  { label: '$lookup', detail: 'Join another collection', insert: '{\n    $lookup: {\n      from: "collection",\n      localField: "field",\n      foreignField: "_id",\n      as: "joined"\n    }\n  }' },
  { label: '$addFields', detail: 'Add computed fields', insert: '{\n    $addFields: {\n      field: expression\n    }\n  }' },
  { label: '$set', detail: 'Set computed fields', insert: '{\n    $set: {\n      field: expression\n    }\n  }' },
  { label: '$unset', detail: 'Remove fields', insert: '{ $unset: ["field"] }' },
  { label: '$count', detail: 'Count results', insert: '{ $count: "count" }' },
  { label: '$facet', detail: 'Run multiple sub-pipelines', insert: '{\n    $facet: {\n      results: [],\n      total: [{ $count: "count" }]\n    }\n  }' },
  { label: '$replaceRoot', detail: 'Replace the root document', insert: '{ $replaceRoot: { newRoot: "$field" } }' },
  { label: '$sample', detail: 'Select random documents', insert: '{ $sample: { size: 10 } }' },
  { label: '$sum', detail: 'Accumulator', insert: '$sum: 1' },
  { label: '$avg', detail: 'Average accumulator', insert: '$avg: "$field"' },
  { label: '$first', detail: 'First value accumulator', insert: '$first: "$field"' },
  { label: '$last', detail: 'Last value accumulator', insert: '$last: "$field"' },
  { label: '$push', detail: 'Array accumulator', insert: '$push: "$field"' },
  { label: '$in', detail: 'Value is in array', insert: '$in: ["$field", []]' },
  { label: '$gte', detail: 'Greater than or equal', insert: '$gte: value' },
  { label: '$lte', detail: 'Less than or equal', insert: '$lte: value' }
];
let visibleCompletions: typeof PIPELINE_COMPLETIONS = [];
let selectedCompletion = 0;

function completionPrefix(): { start: number; text: string } | null {
  const before = editor.textarea.value.slice(0, editor.textarea.selectionStart);
  const match = /\$[A-Za-z]*$/.exec(before);
  return match ? { start: before.length - match[0].length, text: match[0].toLowerCase() } : null;
}

function hideSuggestions(): void { suggestionsEl.hidden = true; clear(suggestionsEl); }

function applyCompletion(index: number): void {
  const prefix = completionPrefix();
  const completion = visibleCompletions[index];
  if (!prefix || !completion) return;
  const textarea = editor.textarea;
  const end = textarea.selectionStart;
  textarea.setRangeText(completion.insert, prefix.start, end, 'end');
  textarea.dispatchEvent(new Event('input'));
  textarea.focus();
  hideSuggestions();
}

function showSuggestions(): void {
  const prefix = completionPrefix();
  if (!prefix) { hideSuggestions(); return; }
  visibleCompletions = PIPELINE_COMPLETIONS.filter((item) => item.label.toLowerCase().startsWith(prefix.text)).slice(0, 10);
  if (!visibleCompletions.length) { hideSuggestions(); return; }
  selectedCompletion = 0;
  clear(suggestionsEl);
  visibleCompletions.forEach((item, index) => {
    const option = el('button', { className: `mc-pipeline-suggestion${index === 0 ? ' active' : ''}` });
    option.append(el('strong', { text: item.label }), el('span', { text: item.detail }));
    option.addEventListener('mousedown', (event) => { event.preventDefault(); applyCompletion(index); });
    suggestionsEl.append(option);
  });
  suggestionsEl.hidden = false;
}

function updateSuggestionSelection(): void {
  Array.from(suggestionsEl.children).forEach((child, index) => child.classList.toggle('active', index === selectedCompletion));
}

function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  state.pipelineText = editor.textarea.value;
  return { pipelineText: state.pipelineText, ...extra };
}

function initialize(value: { namespace: string; pipelineText: string }): void {
  state.namespace = value.namespace;
  state.pipelineText = value.pipelineText || '[\n  \n]';  editor.textarea.value = state.pipelineText || '[\n  \n]';
  editor.textarea.dispatchEvent(new Event('input'));
  render();
}

on('init', (value) => initialize(value as { namespace: string; pipelineText: string }));
void request('ready').then((value) => value && initialize(value as { namespace: string; pipelineText: string }));
editor.textarea.addEventListener('input', () => {
  state.pipelineText = editor.textarea.value;
  showSuggestions();
  persist();
});
editor.textarea.addEventListener('blur', () => setTimeout(hideSuggestions, 100));
editor.textarea.addEventListener('keydown', (event) => {
  if (!suggestionsEl.hidden && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
    event.preventDefault();
    if (event.key === 'ArrowDown') selectedCompletion = (selectedCompletion + 1) % visibleCompletions.length;
    else if (event.key === 'ArrowUp') selectedCompletion = (selectedCompletion - 1 + visibleCompletions.length) % visibleCompletions.length;
    else if (event.key === 'Escape') hideSuggestions();
    else applyCompletion(selectedCompletion);
    updateSuggestionSelection();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void run(); }
});

function parsedResults(): Record<string, unknown>[] {
  return state.results.map((result) => JSON.parse(result) as Record<string, unknown>);
}

function setResultView(mode: 'list' | 'table' | 'json'): void {
  state.viewMode = mode;
  setState(state);
  render();
}

function renderResultViewButtons(): void {
  for (const [id, mode] of [
    ['btn-result-list', 'list'],
    ['btn-result-table', 'table'],
    ['btn-result-json', 'json']
  ] as const) {
    const button = $(id);
    button.classList.toggle('active', state.viewMode === mode);
    button.setAttribute('aria-pressed', String(state.viewMode === mode));
  }
}

function renderResultList(documents: Record<string, unknown>[]): HTMLElement {
  const container = el('div', { className: 'mc-document-list' });
  documents.forEach((document, index) => {
    const card = el('article', { className: 'mc-doc mc-aggregation-document' });
    const tree = createFieldTree(document);
    tree.classList.add('mc-doc-body');
    card.append(
      el('div', { className: 'mc-doc-header' },
        el('span', { className: 'mc-chip', text: `#${index + 1}` }),
        el('span', { className: 'doc-id', text: formatJsonCell(document._id) })
      ),
      tree
    );
    container.append(card);
  });
  return container;
}

function renderResultTable(documents: Record<string, unknown>[]): HTMLElement {
  const columns = [...new Set(documents.flatMap((document) => Object.keys(document)))];
  const table = el('table', { className: 'mc-table mc-aggregation-grid' });
  const header = el('tr', {}, el('th', { text: '#' }));
  for (const column of columns) header.append(el('th', { text: column }));
  table.append(el('thead', {}, header));
  const body = el('tbody');
  documents.forEach((document, index) => {
    const row = el('tr', {}, el('td', { text: String(index + 1) }));
    for (const column of columns) {
      row.append(el('td', {
        text: formatJsonCell(document[column], true),
        title: formatJsonCell(document[column])
      }));
    }
    body.append(row);
  });
  table.append(body);
  return el('div', { className: 'mc-table-scroll' }, table);
}

function renderResultJson(documents: Record<string, unknown>[]): HTMLElement {
  const container = el('div', { className: 'mc-json-list' });
  documents.forEach((document, index) => {
    const block = el('article', { className: 'mc-json-document mc-pipeline-result' });
    const header = el('div', { className: 'mc-json-document-number', text: `Document ${index + 1}` });
    const copyButton = el('button', {
      className: 'mc-btn icon-only mc-json-copy',
      text: '⧉',
      title: 'Copy document JSON',
      ariaLabel: 'Copy document JSON'
    });
    copyButton.addEventListener('click', async () => {
      try {
        await request('copyDocument', { documentText: state.results[index] });
        state.warning = `Document ${index + 1} copied to clipboard.`;
      } catch (error) {
        state.error = (error as Error).message;
      }
      render();
    });
    header.append(copyButton);
    block.append(header, createJsonTree(document));
    container.append(block);
  });
  return container;
}

function render(): void {
  namespaceEl.textContent = state.namespace;
  renderResultViewButtons();
  clear(statusEl);
  if (state.loading) statusEl.append(el('span', { className: 'mc-spinner' }), ' Running pipeline…');
  else if (state.error) statusEl.append(el('span', { className: 'error', text: state.error }));
  else statusEl.textContent = state.warning ?? (state.elapsedMS ? `Showing ${state.results.length}${state.count === null ? '' : ` of ${state.count}`} · ${state.elapsedMS} ms` : 'Ready');
  resultsInfo.textContent = state.count === null
    ? `${state.results.length} shown`
    : `${state.results.length} of ${state.count} documents`;
  clear(resultsEl);
  if (state.loading) { resultsEl.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), ' Executing pipeline…')); return; }
  if (state.error) { resultsEl.append(el('div', { className: 'mc-empty error', text: state.error })); return; }
  if (!state.results.length) {
    resultsEl.append(el('div', {
      className: 'mc-empty',
      text: state.count === 0 ? 'The pipeline returned no documents.' : 'Run the pipeline to preview its output.'
    }));
    return;
  }
  const documents = parsedResults();
  if (state.viewMode === 'table') resultsEl.append(renderResultTable(documents));
  else if (state.viewMode === 'json') resultsEl.append(renderResultJson(documents));
  else resultsEl.append(renderResultList(documents));
  persist();
}

async function run(): Promise<void> {
  state.loading = true; state.error = null; state.warning = null; render();
  try {
    const result = await request('runAll', payload()) as { documents?: string[]; count?: number | null; elapsedMS?: number; warning?: string; error?: string };
    if (result.error) throw new Error(result.error);
    state.results = result.documents ?? []; state.count = result.count ?? null; state.elapsedMS = result.elapsedMS ?? 0; state.warning = result.warning ?? null;
  } catch (error) { state.error = (error as Error).message; } finally { state.loading = false; render(); }
}

async function count(): Promise<void> {
  try { const result = await request('count', payload()) as { count: number | null }; state.count = result.count; state.warning = result.count === null ? 'Count unavailable' : `${result.count} result(s)`; render(); }
  catch (error) { state.error = (error as Error).message; render(); }
}

async function explain(): Promise<void> {
  try {
    const result = await request('explain', payload());
    showExplainModal(result);
  } catch (error) { state.error = (error as Error).message; render(); }
}

/** Explain opens in a modal with Visual Tree / Raw Output tabs, exactly like
 * the Documents panel. */
function showExplainModal(result: unknown): void {
  clear(modalRoot);
  const backdrop = el('div', { className: 'mc-modal-backdrop' });
  const modal = el('div', { className: 'mc-modal' });
  const close = (): void => clear(modalRoot);

  const closeButton = el('button', { className: 'mc-btn primary', text: 'Close' });
  closeButton.addEventListener('click', close);

  modal.append(
    el('h3', { text: `Explain plan — ${state.namespace}` }),
    createExplainView(result as never),
    el('div', { className: 'mc-modal-actions' }, closeButton)
  );
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  backdrop.append(modal);
  modalRoot.append(backdrop);
}

async function namedAction(type: 'savePipeline' | 'createView'): Promise<void> {
  try {
    const result = await request(type, payload()) as { cancelled?: boolean; name?: string };
    if (result.cancelled) return;
    state.warning = type === 'savePipeline' ? 'Pipeline saved.' : 'View created.';
    render();
  }
  catch (error) { state.error = (error as Error).message; render(); }
}

function showExportModal(): void {
  clear(modalRoot);
  const select = el('select', { className: 'mc-select' }) as HTMLSelectElement;
  for (const format of ['json', 'jsonl', 'csv']) {
    select.append(el('option', { value: format, text: format.toUpperCase() }));
  }

  const backdrop = el('div', { className: 'mc-modal-backdrop' });
  const modal = el('div', { className: 'mc-modal' });
  const errorEl = el('div', { className: 'mc-error-text' });
  errorEl.hidden = true;
  const cancel = el('button', { className: 'mc-btn', text: 'Cancel' });
  const submit = el('button', { className: 'mc-btn primary', text: 'Export' });
  const close = (): void => clear(modalRoot);

  cancel.addEventListener('click', close);
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const result = await request('exportData', payload({ format: select.value })) as { cancelled?: boolean; exported?: number };
      if (!result.cancelled) {
        state.warning = `Exported ${result.exported ?? 0} documents.`;
        close();
        render();
      }
    } catch (error) {
      errorEl.textContent = (error as Error).message;
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
  modal.append(
    el('h3', { text: 'Export aggregation results' }),
    el('div', { className: 'mc-field' }, el('label', { text: 'Format' }), select),
    el('p', { text: 'All documents produced by the current pipeline will be exported.' }),
    errorEl,
    el('div', { className: 'mc-modal-actions' }, cancel, submit)
  );
  backdrop.append(modal);
  modalRoot.append(backdrop);
  select.focus();
}

async function copyShell(): Promise<void> {
  try { await request('copyShellSnippet', payload()); state.warning = 'mongosh pipeline copied.'; render(); }
  catch (error) { state.error = (error as Error).message; render(); }
}

$('btn-run').addEventListener('click', () => void run());
$('btn-cancel').addEventListener('click', () => void request('cancel'));
$('btn-count').addEventListener('click', () => void count());
$('btn-explain').addEventListener('click', () => void explain());
$('btn-save').addEventListener('click', () => void namedAction('savePipeline'));
$('btn-view').addEventListener('click', () => void namedAction('createView'));
$('btn-result-list').addEventListener('click', () => setResultView('list'));
$('btn-result-table').addEventListener('click', () => setResultView('table'));
$('btn-result-json').addEventListener('click', () => setResultView('json'));
$('btn-export').addEventListener('click', showExportModal);
$('btn-shell').addEventListener('click', () => void copyShell());
render();
