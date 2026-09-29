import {
  request,
  on,
  getState,
  setState,
  el,
  clear,
  highlightJson,
  formatNumber,
  debounce
} from '../shared/client';

interface Stage {
  id: string;
  text: string;
  enabled: boolean;
  expanded: boolean;
  preview?: string[];
  previewError?: string;
  previewCount?: number | null;
  isLoading?: boolean;
}

interface StageOperator {
  name: string;
  description: string;
  template: string;
}

interface UiState {
  namespace: string;
  stages: Stage[];
  autoPreview: boolean;
  results: string[];
  count: number | null;
  elapsedMS: number;
  loading: boolean;
  error: string | null;
  warning: string | null;
}

let stageOperators: StageOperator[] = [];

let state: UiState = getState<UiState>({
  namespace: '—',
  stages: [],
  autoPreview: true,
  results: [],
  count: null,
  elapsedMS: 0,
  loading: false,
  error: null,
  warning: null
});

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const namespaceEl = $('namespace');
const stagesEl = $('stages');
const statusTextEl = $('status-text');
const resultsBar = $('results-bar');
const resultsInfo = $('results-info');
const autoPreviewEl = $<HTMLInputElement>('auto-preview');
const modalRoot = $('modal-root');

// ───────────────────────────── init ─────────────────────────────

on('init', (payload) => {
  const init = payload as {
    namespace: string;
    stages: Stage[];
    autoPreview: boolean;
    stageOperators: StageOperator[];
  };
  state.namespace = init.namespace;
  state.stages = init.stages ?? [];
  state.autoPreview = init.autoPreview ?? true;
  stageOperators = init.stageOperators ?? [];
  autoPreviewEl.checked = state.autoPreview;
  render();
  persist();
});

on('refreshExplorer', () => {
  // no-op in webview; explorer refresh handled host-side
});

void request('ready').then((payload) => {
  if (payload) {
    const init = payload as { namespace: string; stages: Stage[]; autoPreview: boolean; stageOperators: StageOperator[] };
    state.namespace = init.namespace;
    state.stages = init.stages ?? [];
    state.autoPreview = init.autoPreview ?? true;
    stageOperators = init.stageOperators ?? [];
    autoPreviewEl.checked = state.autoPreview;
    render();
  }
});

// ───────────────────────────── toolbar ─────────────────────────────

$('btn-run').addEventListener('click', () => void runAll());
$('btn-cancel').addEventListener('click', () => void request('cancel'));
$('btn-explain').addEventListener('click', () => void showExplain());
$('btn-count').addEventListener('click', () => void runCount());
$('btn-add').addEventListener('click', () => showAddStagePicker());
$('btn-save').addEventListener('click', () => showSaveModal());
$('btn-view').addEventListener('click', () => showCreateViewModal());
$('btn-export').addEventListener('click', () => showExportModal());
$('btn-shell').addEventListener('click', () => void copyShell());

autoPreviewEl.addEventListener('change', () => {
  state.autoPreview = autoPreviewEl.checked;
  persist();
});

const persist = debounce(() => setState(state), 200);

// ───────────────────────────── stage rendering ─────────────────────────────

function render(): void {
  namespaceEl.textContent = state.namespace;
  renderStatus();
  renderStages();
  renderResultsBar();
}

function renderStatus(): void {
  clear(statusTextEl);
  if (state.loading) {
    statusTextEl.append(el('span', { className: 'mc-spinner' }), ' Running pipeline…');
    return;
  }
  if (state.error) {
    statusTextEl.append(el('span', { className: 'error', text: state.error }));
    return;
  }
  if (state.warning) {
    statusTextEl.append(el('span', { text: state.warning }));
    return;
  }
  const parts: string[] = [];
  parts.push(`${state.stages.length} stage(s)`);
  parts.push(`${state.stages.filter((s) => s.enabled).length} enabled`);
  if (state.elapsedMS) {
    parts.push(`${state.elapsedMS} ms`);
  }
  statusTextEl.textContent = parts.join(' · ');
}

function renderStages(): void {
  clear(stagesEl);
  if (state.stages.length === 0) {
    stagesEl.append(
      el(
        'div',
        { className: 'mc-empty' },
        el('span', { text: 'No stages yet.' }),
        el('span', { className: 'mc-muted', text: 'Click "Add Stage" to build your pipeline.' })
      )
    );
    return;
  }

  state.stages.forEach((stage, index) => {
    stagesEl.append(renderStage(stage, index));
  });
}

function renderStage(stage: Stage, index: number): HTMLElement {
  const card = el('div', { className: `mc-stage${stage.enabled ? '' : ' disabled'}` });

  const header = el('div', { className: 'mc-stage-header' });
  const stageName = detectStageName(stage.text);

  const toggle = el('button', {
    className: 'mc-btn icon-only',
    text: stage.expanded ? '▾' : '▸',
    title: 'Collapse/expand'
  });
  toggle.addEventListener('click', () => {
    stage.expanded = !stage.expanded;
    render();
    persist();
  });

  const enableCheckbox = el('input') as HTMLInputElement;
  enableCheckbox.type = 'checkbox';
  enableCheckbox.checked = stage.enabled;
  enableCheckbox.title = 'Enable/disable stage';
  enableCheckbox.addEventListener('change', () => {
    stage.enabled = enableCheckbox.checked;
    syncStages();
    render();
    persist();
    if (state.autoPreview) {
      void previewUpTo(stage.id);
    }
  });

  header.append(
    toggle,
    el('span', { className: 'mc-chip', text: `#${index + 1}` }),
    enableCheckbox,
    el('span', { className: 'stage-name', text: stageName }),
    el('span', { className: 'spacer' })
  );

  const previewBtn = el('button', { className: 'mc-btn icon-only', text: '▶', title: 'Preview up to this stage' });
  previewBtn.addEventListener('click', () => void previewUpTo(stage.id));

  const helpBtn = el('button', { className: 'mc-btn icon-only', text: '?', title: 'Stage documentation' });
  helpBtn.addEventListener('click', () => void openStageHelp(stageName));

  const moveUp = el('button', { className: 'mc-btn icon-only', text: '↑', title: 'Move up' });
  moveUp.addEventListener('click', () => moveStage(index, -1));
  const moveDown = el('button', { className: 'mc-btn icon-only', text: '↓', title: 'Move down' });
  moveDown.addEventListener('click', () => moveStage(index, 1));

  const duplicateBtn = el('button', { className: 'mc-btn icon-only', text: '⧉', title: 'Duplicate stage' });
  duplicateBtn.addEventListener('click', () => duplicateStage(index));

  const deleteBtn = el('button', { className: 'mc-btn icon-only', text: '🗑', title: 'Delete stage' });
  deleteBtn.addEventListener('click', () => deleteStage(index));

  header.append(previewBtn, helpBtn, moveUp, moveDown, duplicateBtn, deleteBtn);
  card.append(header);

  if (stage.expanded) {
    const body = el('div', { className: 'mc-stage-body' });

    const editorWrap = el('div', { className: 'mc-field' });
    editorWrap.append(el('label', { text: 'Stage' }));
    const textarea = el('textarea', { className: 'mc-textarea', rows: 8 }) as HTMLTextAreaElement;
    textarea.value = stage.text;
    textarea.spellcheck = false;
    textarea.addEventListener('input', () => {
      stage.text = textarea.value;
      persist();
    });
    const debouncedPreview = debounce(() => {
      syncStages();
      if (state.autoPreview) {
        void previewUpTo(stage.id);
      }
    }, 600);
    textarea.addEventListener('input', debouncedPreview);
    editorWrap.append(textarea);

    const previewWrap = el('div', { className: 'mc-stage-preview' });
    previewWrap.append(el('label', { className: 'mc-muted', text: 'Preview' }));
    if (stage.isLoading) {
      previewWrap.append(el('span', { className: 'mc-spinner' }));
    } else if (stage.previewError) {
      previewWrap.append(el('div', { className: 'mc-error-text', text: stage.previewError }));
    } else if (stage.preview && stage.preview.length > 0) {
      const pre = el('pre');
      pre.innerHTML = highlightJson(stage.preview.map((p) => safeParse(p)));
      previewWrap.append(pre);
      if (stage.previewCount !== null && stage.previewCount !== undefined) {
        previewWrap.append(
          el('div', { className: 'mc-muted', text: `${formatNumber(stage.previewCount)} document(s) at this stage` })
        );
      }
    } else {
      previewWrap.append(el('div', { className: 'mc-muted', text: 'No preview yet.' }));
    }

    body.append(editorWrap, previewWrap);
    card.append(body);
  }

  return card;
}

function renderResultsBar(): void {
  if (state.results.length === 0 && state.count === null) {
    resultsBar.style.display = 'none';
    return;
  }
  resultsBar.style.display = 'flex';
  const parts: string[] = [];
  parts.push(`${formatNumber(state.results.length)} result(s) shown`);
  if (state.count !== null) {
    parts.push(`${formatNumber(state.count)} total`);
  }
  if (state.elapsedMS) {
    parts.push(`${state.elapsedMS} ms`);
  }
  resultsInfo.textContent = parts.join(' · ');
}

// ───────────────────────────── stage operations ─────────────────────────────

function detectStageName(text: string): string {
  const match = /\$[a-zA-Z]+/.exec(text);
  return match ? match[0] : '(empty)';
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function moveStage(index: number, delta: number): void {
  const target = index + delta;
  if (target < 0 || target >= state.stages.length) {
    return;
  }
  const [stage] = state.stages.splice(index, 1);
  state.stages.splice(target, 0, stage);
  syncStages();
  render();
  persist();
}

function duplicateStage(index: number): void {
  const source = state.stages[index];
  const copy: Stage = {
    ...source,
    id: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    preview: undefined,
    previewError: undefined,
    previewCount: undefined
  };
  state.stages.splice(index + 1, 0, copy);
  syncStages();
  render();
  persist();
}

function deleteStage(index: number): void {
  state.stages.splice(index, 1);
  syncStages();
  render();
  persist();
}

function addStage(template: string): void {
  state.stages.push({
    id: `stage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: template,
    enabled: true,
    expanded: true
  });
  syncStages();
  render();
  persist();
}

function syncStages(): void {
  void request('syncStages', {
    stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
  });
}

// ───────────────────────────── execution ─────────────────────────────

async function previewUpTo(stageId: string): Promise<void> {
  const stage = state.stages.find((s) => s.id === stageId);
  if (!stage) {
    return;
  }
  stage.isLoading = true;
  stage.previewError = undefined;
  render();

  try {
    const result = (await request('preview', {
      stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled })),
      upToStageId: stageId
    })) as {
      documents: string[];
      count: number | null;
      error?: string;
      warning?: string;
      elapsedMS: number;
    };
    stage.preview = result.documents ?? [];
    stage.previewCount = result.count ?? null;
    stage.previewError = result.error ?? result.warning ?? undefined;
    state.elapsedMS = result.elapsedMS ?? 0;
  } catch (err) {
    stage.previewError = (err as Error).message;
  } finally {
    stage.isLoading = false;
    render();
    persist();
  }
}

async function runAll(): Promise<void> {
  state.loading = true;
  state.error = null;
  state.warning = null;
  render();

  try {
    const result = (await request('runAll', {
      stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
    })) as {
      documents: string[];
      count: number | null;
      error?: string;
      warning?: string;
      elapsedMS: number;
    };
    state.results = result.documents ?? [];
    state.count = result.count ?? null;
    state.elapsedMS = result.elapsedMS ?? 0;
    state.error = result.error ?? null;
    state.warning = result.warning ?? null;
    showResults();
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
    persist();
  }
}

async function runCount(): Promise<void> {
  try {
    const result = (await request('count', {
      stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
    })) as { count: number | null };
    state.count = result.count;
    render();
    persist();
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

function showResults(): void {
  if (state.results.length === 0) {
    return;
  }
  const body = el('div');
  const pre = el('pre', { className: 'mc-mono' });
  pre.innerHTML = highlightJson(state.results.map((r) => safeParse(r)));
  pre.style.maxHeight = '60vh';
  pre.style.overflow = 'auto';
  body.append(pre);
  openModal({
    title: `Pipeline results — ${state.namespace}`,
    body,
    primaryLabel: 'Close',
    onPrimary: () => closeModal(),
    hideSecondary: true
  });
}

// ───────────────────────────── explain ─────────────────────────────

async function showExplain(): Promise<void> {
  state.loading = true;
  render();
  try {
    const explain = (await request('explain', {
      stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
    })) as {
      tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
      insights: string[];
      raw: Record<string, unknown>;
    };
    renderExplain(explain);
  } catch (err) {
    state.error = (err as Error).message;
  } finally {
    state.loading = false;
    render();
  }
}

function renderExplain(explain: {
  tree: Array<{ stage: string; description: string; details: Record<string, string>; children: unknown[] }>;
  insights: string[];
  raw: Record<string, unknown>;
}): void {
  const body = el('div');
  body.append(el('div', { className: 'mc-section-title', text: 'Insights' }));
  for (const insight of explain.insights) {
    body.append(el('div', { className: 'mc-insight', text: insight }));
  }
  body.append(el('div', { className: 'mc-section-title', text: 'Plan' }));
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
  const details = el('details');
  const rawPre = el('pre', { className: 'mc-mono' });
  rawPre.innerHTML = highlightJson(explain.raw);
  details.append(el('summary', { text: 'Raw explain output' }), rawPre);
  body.append(details);

  openModal({
    title: `Explain — ${state.namespace}`,
    body,
    primaryLabel: 'Close',
    onPrimary: () => closeModal(),
    hideSecondary: true
  });
}

// ───────────────────────────── add stage picker ─────────────────────────────

function showAddStagePicker(): void {
  const body = el('div');
  const search = el('input', { className: 'mc-input', placeholder: 'Filter stages…' }) as HTMLInputElement;
  search.style.width = '100%';
  search.style.marginBottom = '8px';
  body.append(search);

  const list = el('div');
  list.style.maxHeight = '50vh';
  list.style.overflow = 'auto';
  body.append(list);

  const renderList = (filter: string): void => {
    clear(list);
    for (const op of stageOperators) {
      if (filter && !op.name.toLowerCase().includes(filter.toLowerCase()) && !op.description.toLowerCase().includes(filter.toLowerCase())) {
        continue;
      }
      const row = el('div');
      row.style.padding = '6px 8px';
      row.style.cursor = 'pointer';
      row.style.borderBottom = '1px solid var(--vscode-panel-border)';
      row.append(
        el('div', { className: 'mc-mono', text: op.name }),
        el('div', { className: 'mc-muted', text: op.description })
      );
      row.addEventListener('click', () => {
        addStage(op.template);
        closeModal();
      });
      list.append(row);
    }
  };

  search.addEventListener('input', () => renderList(search.value));
  renderList('');

  openModal({
    title: 'Add aggregation stage',
    body,
    primaryLabel: 'Blank stage',
    onPrimary: () => {
      addStage('{\n  \n}');
      closeModal();
    },
    hideSecondary: true
  });
}

async function openStageHelp(stageName: string): Promise<void> {
  try {
    const help = (await request('stageHelp', { stage: stageName })) as { url: string; description: string };
    const body = el('div');
    body.append(el('p', { text: help.description || `Documentation for ${stageName}` }));
    const link = el('a', { text: help.url, href: help.url }) as HTMLAnchorElement;
    link.style.color = 'var(--vscode-textLink-foreground)';
    body.append(link);
    openModal({
      title: `${stageName} documentation`,
      body,
      primaryLabel: 'Close',
      onPrimary: () => closeModal(),
      hideSecondary: true
    });
  } catch (err) {
    state.error = (err as Error).message;
    render();
  }
}

// ───────────────────────────── save / view / export ─────────────────────────────

function showSaveModal(): void {
  openModal({
    title: 'Save pipeline to My Queries',
    body: textField('Pipeline name', `${state.namespace} pipeline`),
    primaryLabel: 'Save',
    onPrimary: async (getValue) => {
      const name = getValue().trim();
      if (!name) {
        showFieldError('Name is required');
        return;
      }
      try {
        await request('savePipeline', {
          name,
          stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
        });
        closeModal();
        setStatusMessage(`Pipeline "${name}" saved.`);
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function showCreateViewModal(): void {
  openModal({
    title: `Create view on ${state.namespace}`,
    body: textField('View name', `${state.namespace.split('.')[1]}_view`),
    primaryLabel: 'Create',
    onPrimary: async (getValue) => {
      const viewName = getValue().trim();
      if (!viewName) {
        showFieldError('View name is required');
        return;
      }
      try {
        await request('createView', {
          viewName,
          stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
        });
        closeModal();
        setStatusMessage(`View "${viewName}" created.`);
      } catch (err) {
        showFieldError((err as Error).message);
      }
    }
  });
}

function showExportModal(): void {
  const languages = ['shell', 'javascript', 'typescript', 'python', 'java', 'csharp', 'go', 'php', 'ruby', 'rust', 'compass'];
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
      const result = (await request('exportToLanguage', {
        language: select.value,
        stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
      })) as { code: string };
      output.textContent = result.code;
    } catch (err) {
      output.textContent = (err as Error).message;
    }
  };
  select.addEventListener('change', () => void generate());

  openModal({
    title: 'Export pipeline to language',
    body,
    primaryLabel: 'Copy',
    onPrimary: async () => {
      try {
        const result = (await request('exportToLanguage', {
          language: select.value,
          stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
        })) as { code: string };
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

async function copyShell(): Promise<void> {
  try {
    await request('copyShellSnippet', {
      stages: state.stages.map((s) => ({ id: s.id, text: s.text, enabled: s.enabled }))
    });
    setStatusMessage('mongosh snippet copied to clipboard.');
  } catch (err) {
    setStatusMessage((err as Error).message, true);
  }
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
  statusTextEl.append(el('span', { className: isError ? 'error' : '', text: message }));
}
