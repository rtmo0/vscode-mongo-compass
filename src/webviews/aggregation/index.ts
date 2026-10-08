import { request, on, getState, setState, el, clear, createDocumentList, createDocumentJsonList, formatJsonCell, createSyntaxEditor, createExplainView, debounce } from '../shared/client';
import { createPipelineBuilder } from './builder';
import { attachQueryAutocomplete, pipelineStagePrefix, toFieldInfo, type FieldInfo, type FieldPathSample } from '../shared/queryAutocomplete';

interface UiState {
  namespace: string;
  pipelineText: string;
  results: string[];
  count: number | null;
  elapsedMS: number;
  loading: boolean;
  error: string | null;
  warning: string | null;
  /** Informational status message (e.g. "Pipeline cancelled") shown instead of counts. */
  notice?: string | null;
  panePercent: number;
  viewMode: 'list' | 'table' | 'json';
  /** Pipeline pane mode: raw text or the visual stage builder. */
  editorMode?: 'text' | 'builder';
}

let state = getState<UiState>({ namespace: '—', pipelineText: '[\n  \n]', results: [], count: null, elapsedMS: 0, loading: false, error: null, warning: null, panePercent: 50, viewMode: 'list' });
state.viewMode ??= 'list';
// A run in flight when the webview was reloaded will never answer.
state.loading = false;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const namespaceEl = $('namespace');
const statusEl = $('status-text');
const resultsEl = $('results');
const resultsInfo = $('results-info');
const editorHost = $('pipeline-editor');
const builderHost = $('pipeline-builder');
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

// Fields offered at a stage are those flowing *into* it, so they are
// fetched per pipeline prefix (stages before the caret) and cached.
const stageFieldCache = new Map<string, FieldInfo[]>();
const stageFieldRequests = new Map<string, Promise<FieldInfo[]>>();

/** Fields flowing into a stage, given the text of the stages before it ('' → the collection's fields). */
function fieldsForPrefix(prefixText: string): FieldInfo[] | Promise<FieldInfo[]> {
  const normalized = prefixText.replace(/\s+/g, ' ').trim();
  const cacheKey = normalized === '' || normalized === '[ ]' || normalized === '[]' ? '' : normalized;
  const cached = stageFieldCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  let pending = stageFieldRequests.get(cacheKey);
  if (!pending) {
    const collectionFields = (): Promise<FieldInfo[]> => Promise.resolve(fieldsForPrefix(''));
    pending = request<FieldPathSample>('stageFields', { pipelineText: cacheKey ? prefixText : '' })
      .then(toFieldInfo)
      // A stage prefix that fails or yields nothing falls back to the collection's fields.
      .catch(() => (cacheKey ? collectionFields() : []))
      .then((fields) => (fields.length || !cacheKey ? fields : collectionFields()))
      .then((fields) => {
        stageFieldCache.set(cacheKey, fields);
        return fields;
      })
      .finally(() => stageFieldRequests.delete(cacheKey));
    stageFieldRequests.set(cacheKey, pending);
  }
  return pending;
}

function stageFieldsAtCaret(text: string, caret: number): FieldInfo[] | Promise<FieldInfo[]> {
  const prefix = pipelineStagePrefix(text, caret);
  return fieldsForPrefix(prefix && prefix.stageIndex > 0 ? prefix.prefixText : '');
}
attachQueryAutocomplete(editor.textarea, { kind: 'pipeline', fields: stageFieldsAtCaret });

// ── visual builder ──
const builder = createPipelineBuilder({
  getPipelineText: () => editor.textarea.value,
  setPipelineText: (text) => {
    editor.textarea.value = text;
    editor.textarea.dispatchEvent(new Event('input'));
  },
  fieldsForPrefix,
  run: () => void run()
});
builderHost.append(builder.element);

async function setEditorMode(mode: 'text' | 'builder'): Promise<void> {
  if (mode === 'builder' && !(await builder.load())) {
    // Leave the error visible in the builder pane but keep the text editable.
    state.editorMode = 'builder';
  } else {
    state.editorMode = mode;
  }
  editorHost.hidden = state.editorMode !== 'text';
  builderHost.hidden = state.editorMode !== 'builder';
  $('btn-mode-text').classList.toggle('active', state.editorMode === 'text');
  $('btn-mode-builder').classList.toggle('active', state.editorMode === 'builder');
  setState(state);
}
$('btn-mode-text').addEventListener('click', () => void setEditorMode('text'));
$('btn-mode-builder').addEventListener('click', () => void setEditorMode('builder'));

function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  state.pipelineText = editor.textarea.value;
  return { pipelineText: state.pipelineText, ...extra };
}

function initialize(value: { namespace: string; pipelineText: string }): void {
  state.namespace = value.namespace;
  state.pipelineText = value.pipelineText || '[\n  \n]';  editor.textarea.value = state.pipelineText || '[\n  \n]';
  editor.textarea.dispatchEvent(new Event('input'));
  render();
  void setEditorMode(state.editorMode ?? 'text');
}

on('init', (value) => initialize(value as { namespace: string; pipelineText: string }));
void request('ready').then((value) => value && initialize(value as { namespace: string; pipelineText: string }));
editor.textarea.addEventListener('input', () => {
  state.pipelineText = editor.textarea.value;
  persist();
});
editor.textarea.addEventListener('keydown', (event) => {
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
  return createDocumentList(documents, { actions: (_document, index) => [createCopyResultButton(index)] });
}

function createCopyResultButton(index: number): HTMLElement {
  const copyButton = el('button', {
    className: 'mc-btn icon-only',
    text: '📋',
    title: 'Copy document JSON',
    ariaLabel: 'Copy document JSON'
  });
  copyButton.addEventListener('click', () => void copyResult(index));
  return copyButton;
}

function renderResultTable(documents: Record<string, unknown>[]): HTMLElement {
  const columns = [...new Set(documents.flatMap((document) => Object.keys(document)))];
  const table = el('table', { className: 'mc-table mc-aggregation-grid' });
  const header = el('tr', {}, el('th', { text: '#' }));
  for (const column of columns) header.append(el('th', { text: column }));
  header.append(el('th', { className: 'mc-actions-header', text: '' }));
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
    const actions = el('td', { className: 'mc-actions-cell' });
    const copyButton = el('button', {
      className: 'mc-btn icon-only',
      text: '📋',
      title: 'Copy document JSON',
      ariaLabel: 'Copy document JSON'
    });
    copyButton.addEventListener('click', () => void copyResult(index));
    actions.append(copyButton);
    row.append(actions);
    body.append(row);
  });
  table.append(body);
  return el('div', { className: 'mc-table-scroll' }, table);
}

/** Copy a result document's canonical Extended JSON to the clipboard. */
async function copyResult(index: number): Promise<void> {
  try {
    await request('copyDocument', { documentText: state.results[index] });
    state.warning = `Document ${index + 1} copied to clipboard.`;
  } catch (error) {
    state.error = (error as Error).message;
  }
  render();
}

function renderResultJson(documents: Record<string, unknown>[]): HTMLElement {
  return createDocumentJsonList(documents, { actions: (_document, index) => [createCopyResultButton(index)] });
}

function render(): void {
  namespaceEl.textContent = state.namespace;
  ($('btn-cancel') as HTMLButtonElement).disabled = !state.loading;
  renderResultViewButtons();
  clear(statusEl);
  if (state.loading) statusEl.append(el('span', { className: 'mc-spinner' }), ' Running pipeline…');
  else if (state.error) statusEl.append(el('span', { className: 'error', text: state.error }));
  else statusEl.textContent = state.notice ?? state.warning ?? (state.elapsedMS ? `Showing ${state.results.length}${state.count === null ? '' : ` of ${state.count}`} · ${state.elapsedMS} ms` : 'Ready');
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

/** Sequence number of the latest Run; responses to older runs are ignored. */
let runSequence = 0;

async function run(): Promise<void> {
  const sequence = ++runSequence;
  state.loading = true; state.error = null; state.warning = null; state.notice = null; render();
  try {
    const result = await request('runAll', payload()) as { documents?: string[]; count?: number | null; elapsedMS?: number; warning?: string; error?: string; aborted?: boolean };
    if (sequence !== runSequence) return;
    if (result.aborted) {
      // Keep the previously shown results; just report the cancellation.
      state.notice = 'Pipeline cancelled.';
      return;
    }
    if (result.error) throw new Error(result.error);
    state.results = result.documents ?? []; state.count = result.count ?? null; state.elapsedMS = result.elapsedMS ?? 0; state.warning = result.warning ?? null;
  } catch (error) {
    if (sequence === runSequence) state.error = (error as Error).message;
  } finally {
    if (sequence === runSequence) { state.loading = false; render(); }
  }
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
render();
