import { request, el, clear, createDocumentList, createSyntaxEditor, debounce } from '../shared/client';
import {
  attachQueryAutocomplete,
  stageTemplates,
  toFieldInfo,
  type FieldInfo,
  type FieldPathSample,
  type QueryInputKind
} from '../shared/queryAutocomplete';

/**
 * Visual pipeline builder: one card per stage, with structured forms for
 * `$lookup` and `$graphLookup` and a shell-syntax body editor for the rest.
 *
 * The pipeline *text* stays the source of truth. The builder is loaded from
 * the text (parsed by the extension host) and every edit regenerates the
 * text, so Run / Explain / Save / Export keep working unchanged.
 */

export interface BuilderHost {
  getPipelineText(): string;
  setPipelineText(text: string): void;
  /** Fields flowing into a stage, given the pipeline text of the stages before it. */
  fieldsForPrefix(prefixText: string): FieldInfo[] | Promise<FieldInfo[]>;
  run(): void;
}

interface OptionText {
  text: string;
  string?: string;
}

interface ParsedStage {
  operator: string;
  body: string;
  options: Record<string, OptionText>;
}

type LookupMode = 'equality' | 'pipeline' | 'both';

interface GenericStage {
  kind: 'generic';
  id: number;
  operator: string;
  body: string;
}

interface LookupStage {
  kind: 'lookup';
  id: number;
  from: string;
  mode: LookupMode;
  localField: string;
  foreignField: string;
  letVars: string;
  pipeline: string;
  as: string;
  /** Options the form does not model, kept verbatim (shell source). */
  extra: Record<string, string>;
}

interface GraphLookupStage {
  kind: 'graphLookup';
  id: number;
  from: string;
  startWith: string;
  connectFromField: string;
  connectToField: string;
  as: string;
  maxDepth: string;
  depthField: string;
  restrictSearchWithMatch: string;
  extra: Record<string, string>;
}

type StageModel = GenericStage | LookupStage | GraphLookupStage;

interface PreviewState {
  open: boolean;
  loading: boolean;
  documents: Record<string, unknown>[];
  error: string | null;
  elapsedMS: number;
}

const TEMPLATES = stageTemplates();
const QUICK_STAGES = ['$match', '$lookup', '$graphLookup', '$unwind', '$group', '$project', '$addFields', '$sort', '$limit'];
const LOOKUP_KEYS = new Set(['from', 'localField', 'foreignField', 'let', 'pipeline', 'as']);
const GRAPH_LOOKUP_KEYS = new Set([
  'from', 'startWith', 'connectFromField', 'connectToField', 'as', 'maxDepth', 'depthField', 'restrictSearchWithMatch'
]);

let nextId = 1;

// ───────────────────────────── model ⇄ text ─────────────────────────────

function fromParsed(stage: ParsedStage): StageModel {
  const id = nextId++;
  const opts = stage.options;
  const str = (key: string): string => opts[key]?.string ?? (opts[key] ? opts[key].text : '');
  const extra = (known: Set<string>): Record<string, string> =>
    Object.fromEntries(Object.entries(opts).filter(([key]) => !known.has(key)).map(([key, value]) => [key, value.text]));
  const isObjectBody = stage.body.trim().startsWith('{');

  if (stage.operator === '$lookup' && isObjectBody) {
    const hasPipeline = 'pipeline' in opts || 'let' in opts;
    const hasFields = 'localField' in opts || 'foreignField' in opts;
    return {
      kind: 'lookup',
      id,
      from: str('from'),
      mode: hasPipeline ? (hasFields ? 'both' : 'pipeline') : 'equality',
      localField: str('localField'),
      foreignField: str('foreignField'),
      letVars: opts.let?.text ?? '',
      pipeline: opts.pipeline?.text ?? '',
      as: str('as'),
      extra: extra(LOOKUP_KEYS)
    };
  }
  if (stage.operator === '$graphLookup' && isObjectBody) {
    return {
      kind: 'graphLookup',
      id,
      from: str('from'),
      startWith: opts.startWith?.text ?? '',
      connectFromField: str('connectFromField'),
      connectToField: str('connectToField'),
      as: str('as'),
      maxDepth: opts.maxDepth?.text ?? '',
      depthField: str('depthField'),
      restrictSearchWithMatch: opts.restrictSearchWithMatch?.text ?? '',
      extra: extra(GRAPH_LOOKUP_KEYS)
    };
  }
  return { kind: 'generic', id, operator: stage.operator, body: stage.body };
}

function newStage(operator: string): StageModel {
  const id = nextId++;
  if (operator === '$lookup') {
    return { kind: 'lookup', id, from: '', mode: 'equality', localField: '', foreignField: '', letVars: '', pipeline: '', as: '', extra: {} };
  }
  if (operator === '$graphLookup') {
    return {
      kind: 'graphLookup', id, from: '', startWith: '', connectFromField: '', connectToField: '', as: '',
      maxDepth: '', depthField: '', restrictSearchWithMatch: '', extra: {}
    };
  }
  const template = TEMPLATES.find((item) => item.name === operator);
  return { kind: 'generic', id, operator, body: template?.body ?? '{}' };
}

function operatorOf(stage: StageModel): string {
  return stage.kind === 'generic' ? stage.operator : stage.kind === 'lookup' ? '$lookup' : '$graphLookup';
}

/** Indent every line after the first by `pad`. */
function indentTail(text: string, pad: string): string {
  return text.replace(/\n/g, `\n${pad}`);
}

function objectText(entries: Array<[string, string]>): string {
  if (entries.length === 0) {
    return '{}';
  }
  return `{\n${entries.map(([key, value]) => `  ${key}: ${indentTail(value, '  ')}`).join(',\n')}\n}`;
}

const quote = (value: string): string => JSON.stringify(value.trim());

/** `"$path"` for a bare field path, otherwise the expression as written. */
function expressionText(value: string): string {
  const trimmed = value.trim();
  if (/^\$?[A-Za-z_][\w.]*$/.test(trimmed)) {
    return JSON.stringify(trimmed.startsWith('$') ? trimmed : `$${trimmed}`);
  }
  return trimmed;
}

function stageBodyText(stage: StageModel): string {
  if (stage.kind === 'generic') {
    return stage.body.trim() || '{}';
  }
  const entries: Array<[string, string]> = [['from', quote(stage.from)]];
  if (stage.kind === 'lookup') {
    if (stage.mode !== 'pipeline') {
      entries.push(['localField', quote(stage.localField)], ['foreignField', quote(stage.foreignField)]);
    }
    if (stage.mode !== 'equality') {
      if (stage.letVars.trim()) {
        entries.push(['let', stage.letVars.trim()]);
      }
      entries.push(['pipeline', stage.pipeline.trim() || '[]']);
    }
    entries.push(['as', quote(stage.as)]);
  } else {
    entries.push(
      ['startWith', expressionText(stage.startWith) || '""'],
      ['connectFromField', quote(stage.connectFromField)],
      ['connectToField', quote(stage.connectToField)],
      ['as', quote(stage.as)]
    );
    if (stage.maxDepth.trim()) {
      entries.push(['maxDepth', stage.maxDepth.trim()]);
    }
    if (stage.depthField.trim()) {
      entries.push(['depthField', quote(stage.depthField)]);
    }
    if (stage.restrictSearchWithMatch.trim()) {
      entries.push(['restrictSearchWithMatch', stage.restrictSearchWithMatch.trim()]);
    }
  }
  entries.push(...Object.entries(stage.extra));
  return objectText(entries);
}

function stageText(stage: StageModel): string {
  const body = stageBodyText(stage);
  const operator = operatorOf(stage);
  return body.includes('\n') || body.length > 50
    ? `{\n  ${operator}: ${indentTail(body, '  ')}\n}`
    : `{ ${operator}: ${body} }`;
}

function pipelineText(stages: StageModel[]): string {
  if (stages.length === 0) {
    return '[\n  \n]';
  }
  return `[\n${stages.map((stage) => `  ${indentTail(stageText(stage), '  ')}`).join(',\n')}\n]`;
}

// ───────────────────────────── shared lookups ─────────────────────────────

let collectionsPromise: Promise<string[]> | null = null;
function loadCollections(): Promise<string[]> {
  collectionsPromise ??= request<{ collections: Array<{ name: string }> }>('listCollections')
    .then((result) => result.collections.map((c) => c.name))
    .catch(() => {
      collectionsPromise = null;
      return [];
    });
  return collectionsPromise;
}

const foreignFieldCache = new Map<string, FieldInfo[]>();
const foreignFieldRequests = new Map<string, Promise<FieldInfo[]>>();
function foreignFields(collection: string): FieldInfo[] | Promise<FieldInfo[]> {
  const name = collection.trim();
  if (!name) {
    return [];
  }
  const cached = foreignFieldCache.get(name);
  if (cached) {
    return cached;
  }
  let pending = foreignFieldRequests.get(name);
  if (!pending) {
    pending = request<FieldPathSample>('collectionFields', { collection: name })
      .then(toFieldInfo)
      .catch(() => [] as FieldInfo[])
      .then((fields) => {
        foreignFieldCache.set(name, fields);
        foreignFieldRequests.delete(name);
        return fields;
      });
    foreignFieldRequests.set(name, pending);
  }
  return pending;
}

// ───────────────────────────── builder ─────────────────────────────

export function createPipelineBuilder(host: BuilderHost): { element: HTMLElement; load(): Promise<boolean> } {
  const element = el('div', { className: 'mc-builder' });
  let stages: StageModel[] = [];
  const previews = new Map<number, PreviewState>();
  /** Focus to restore after a re-render: stage id + control name. */
  let pendingFocus: { id: number; name: string } | null = null;
  /** Autocomplete instances of the current render, removed before the next one. */
  let disposers: Array<() => void> = [];

  const prefixText = (index: number): string => pipelineText(stages.slice(0, index));
  const localFields = (index: number) => (): FieldInfo[] | Promise<FieldInfo[]> =>
    index === 0 ? host.fieldsForPrefix('') : host.fieldsForPrefix(prefixText(index));

  const refreshOpenPreviews = debounce((fromIndex: number) => {
    stages.forEach((stage, index) => {
      if (index >= fromIndex && previews.get(stage.id)?.open) {
        void loadPreview(stage);
      }
    });
  }, 700);

  /** Model changed: regenerate the text and refresh affected previews. */
  const commit = (index: number, rerender = false): void => {
    host.setPipelineText(pipelineText(stages));
    refreshOpenPreviews(index);
    if (rerender) {
      render();
    }
  };

  async function loadPreview(stage: StageModel): Promise<void> {
    const index = stages.indexOf(stage);
    if (index < 0) {
      return;
    }
    const preview = previews.get(stage.id) ?? { open: true, loading: false, documents: [], error: null, elapsedMS: 0 };
    preview.open = true;
    preview.loading = true;
    previews.set(stage.id, preview);
    renderPreview(stage);
    try {
      const result = await request<{ documents: string[]; elapsedMS?: number; warning?: string }>('previewStage', {
        pipelineText: pipelineText(stages.slice(0, index + 1))
      });
      preview.documents = result.documents.map((doc) => JSON.parse(doc) as Record<string, unknown>);
      preview.error = result.warning ?? null;
      preview.elapsedMS = result.elapsedMS ?? 0;
    } catch (err) {
      preview.documents = [];
      preview.error = (err as Error).message;
    } finally {
      preview.loading = false;
      renderPreview(stage);
    }
  }

  function renderPreview(stage: StageModel): void {
    const host = element.querySelector<HTMLElement>(`[data-preview="${stage.id}"]`);
    const preview = previews.get(stage.id);
    if (!host) {
      return;
    }
    clear(host);
    host.hidden = !preview?.open;
    if (!preview?.open) {
      return;
    }
    if (preview.loading) {
      host.append(el('div', { className: 'mc-empty' }, el('span', { className: 'mc-spinner' }), ' Running stages…'));
      return;
    }
    if (preview.error) {
      host.append(el('div', { className: 'mc-stage-preview-error error', text: preview.error }));
      return;
    }
    host.append(
      el('div', {
        className: 'mc-muted mc-stage-preview-info',
        text: preview.documents.length
          ? `Output of this stage · first ${preview.documents.length} document(s) · ${preview.elapsedMS} ms`
          : 'This stage outputs no documents.'
      }),
      createDocumentList(preview.documents)
    );
  }

  // ── controls ──

  function textInput(
    stage: StageModel,
    index: number,
    name: string,
    value: string,
    placeholder: string,
    onChange: (value: string) => void,
    suggestions?: () => Promise<string[]> | string[]
  ): HTMLElement {
    const input = el('input', { className: 'mc-input', value, placeholder, spellcheck: false }) as HTMLInputElement;
    input.dataset.control = name;
    let list: HTMLDataListElement | null = null;
    if (suggestions) {
      // Filled on focus, so suggestions follow e.g. a changed `from` collection.
      list = el('datalist', { id: `mc-list-${stage.id}-${name}` }) as HTMLDataListElement;
      input.setAttribute('list', list.id);
      input.addEventListener('focus', () => {
        void Promise.resolve(suggestions()).then((items) => {
          clear(list!);
          for (const item of items) {
            list!.append(el('option', { value: item }) as HTMLOptionElement);
          }
        });
      });
    }
    input.addEventListener('input', () => {
      onChange(input.value);
      commit(index);
    });
    input.addEventListener('focus', () => {
      pendingFocus = { id: stage.id, name };
    });
    return list ? el('div', { className: 'mc-stage-control' }, input, list) : input;
  }

  function codeEditor(
    stage: StageModel,
    index: number,
    name: string,
    value: string,
    kind: QueryInputKind,
    contextPrefix: string,
    fields: () => FieldInfo[] | Promise<FieldInfo[]>,
    onChange: (value: string) => void,
    placeholder = ''
  ): HTMLElement {
    const lines = value.split('\n').length;
    const editor = createSyntaxEditor(value, Math.min(Math.max(lines + 1, 2), 14));
    const textarea = editor.textarea;
    textarea.dataset.control = name;
    textarea.placeholder = placeholder;
    editor.element.classList.add('mc-stage-editor');
    textarea.addEventListener('input', () => {
      textarea.rows = Math.min(Math.max(textarea.value.split('\n').length + 1, 2), 14);
      onChange(textarea.value);
      commit(index);
    });
    textarea.addEventListener('focus', () => {
      pendingFocus = { id: stage.id, name };
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        host.run();
      }
    });
    disposers.push(attachQueryAutocomplete(textarea, { kind, fields, contextPrefix: () => contextPrefix }));
    return editor.element;
  }

  const fieldPaths = (source: FieldInfo[] | Promise<FieldInfo[]>): Promise<string[]> =>
    Promise.resolve(source).then((fields) => fields.map((field) => field.path));

  function row(label: string, control: HTMLElement, hint = ''): HTMLElement {
    // A <div>, not a <label>: a label would forward clicks to its first button.
    const wrap = el('div', { className: 'mc-stage-row' });
    wrap.append(el('span', { className: 'mc-stage-label', text: label }), control);
    if (hint) {
      wrap.append(el('span', { className: 'mc-stage-hint mc-muted', text: hint }));
    }
    return wrap;
  }

  function collectionInput(stage: LookupStage | GraphLookupStage, index: number): HTMLElement {
    return textInput(stage, index, 'from', stage.from, 'collection name', (value) => {
      const previousFrom = stage.from;
      stage.from = value;
      // Default the output field to the joined collection's name.
      if (!stage.as || stage.as === previousFrom) {
        stage.as = value;
        const asInput = element.querySelector<HTMLInputElement>(`[data-stage="${stage.id}"] [data-control="as"]`);
        if (asInput) {
          asInput.value = value;
        }
      }
    }, loadCollections);
  }

  function lookupForm(stage: LookupStage, index: number): HTMLElement {
    const form = el('div', { className: 'mc-stage-form' });
    const local = localFields(index);
    const foreign = (): FieldInfo[] | Promise<FieldInfo[]> => foreignFields(stage.from);

    const modes: Array<[LookupMode, string, string]> = [
      ['equality', 'Equality', 'localField = foreignField'],
      ['pipeline', 'Pipeline', 'let + sub-pipeline on the joined collection'],
      ['both', 'Both', 'equality match, then a sub-pipeline (MongoDB 5.0+)']
    ];
    const segment = el('div', { className: 'mc-segment' });
    segment.setAttribute('role', 'radiogroup');
    for (const [mode, label, title] of modes) {
      const button = el('button', { className: `mc-btn${stage.mode === mode ? ' active' : ''}`, text: label, title }) as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => {
        stage.mode = mode;
        commit(index, true);
      });
      segment.append(button);
    }

    form.append(row('From', collectionInput(stage, index), 'Collection in this database to join'));
    form.append(row('Join', segment));
    if (stage.mode !== 'pipeline') {
      form.append(
        row('Local field', textInput(stage, index, 'localField', stage.localField, 'field in the input documents',
          (v) => (stage.localField = v), () => fieldPaths(local()))),
        row('Foreign field', textInput(stage, index, 'foreignField', stage.foreignField, 'field in the joined collection',
          (v) => (stage.foreignField = v), () => fieldPaths(foreign())))
      );
    }
    if (stage.mode !== 'equality') {
      form.append(
        row('Let', codeEditor(stage, index, 'let', stage.letVars, 'pipeline', '[{ $addFields: ', local, (v) => (stage.letVars = v),
          '{ orderId: "$_id" }'), 'Variables for the sub-pipeline, used there as "$$name"'),
        row('Pipeline', codeEditor(stage, index, 'pipeline', stage.pipeline, 'pipeline', '', foreign, (v) => (stage.pipeline = v),
          '[{ $match: { $expr: { $eq: ["$orderId", "$$orderId"] } } }]'), 'Runs on the joined collection')
      );
    }
    const asInput = textInput(stage, index, 'as', stage.as, 'output array field', (v) => (stage.as = v)) as HTMLInputElement;
    const unwind = el('button', { className: 'mc-btn', text: '＋ $unwind', title: 'Add an $unwind stage for this array right after' }) as HTMLButtonElement;
    unwind.type = 'button';
    unwind.addEventListener('click', () => {
      const field = stage.as.trim() || 'joined';
      stages.splice(index + 1, 0, {
        kind: 'generic',
        id: nextId++,
        operator: '$unwind',
        body: `{ path: ${JSON.stringify(`$${field}`)}, preserveNullAndEmptyArrays: true }`
      });
      commit(index + 1, true);
    });
    form.append(row('As', el('div', { className: 'mc-stage-control inline' }, asInput, unwind)));
    return form;
  }

  function graphLookupForm(stage: GraphLookupStage, index: number): HTMLElement {
    const form = el('div', { className: 'mc-stage-form' });
    const local = localFields(index);
    const foreign = (): FieldInfo[] | Promise<FieldInfo[]> => foreignFields(stage.from);
    form.append(
      row('From', collectionInput(stage, index), 'Collection to search recursively'),
      row('Start with', codeEditor(stage, index, 'startWith', stage.startWith, 'pipeline', '[{ $addFields: { startWith: ',
        local, (v) => (stage.startWith = v), '"$reportsTo"'), 'Expression on the input document; a bare field name becomes "$field"'),
      row('Connect from', textInput(stage, index, 'connectFromField', stage.connectFromField, 'field in the searched collection',
        (v) => (stage.connectFromField = v), () => fieldPaths(foreign())), 'Its value is matched against "Connect to" in the next step'),
      row('Connect to', textInput(stage, index, 'connectToField', stage.connectToField, 'field in the searched collection',
        (v) => (stage.connectToField = v), () => fieldPaths(foreign()))),
      row('As', textInput(stage, index, 'as', stage.as, 'output array field', (v) => (stage.as = v))),
      row('Max depth', textInput(stage, index, 'maxDepth', stage.maxDepth, 'unlimited', (v) => (stage.maxDepth = v)), '0 = only direct matches'),
      row('Depth field', textInput(stage, index, 'depthField', stage.depthField, 'optional', (v) => (stage.depthField = v)), 'Adds the recursion depth to each match'),
      row('Restrict search', codeEditor(stage, index, 'restrictSearchWithMatch', stage.restrictSearchWithMatch, 'filter', '',
        foreign, (v) => (stage.restrictSearchWithMatch = v), '{ active: true }'), 'Optional filter on the searched documents')
    );
    return form;
  }

  function operatorSelect(stage: StageModel, index: number): HTMLSelectElement {
    const select = el('select', { className: 'mc-select mc-stage-operator' }) as HTMLSelectElement;
    for (const template of TEMPLATES) {
      const option = el('option', { value: template.name, text: template.name, title: template.detail }) as HTMLOptionElement;
      select.append(option);
    }
    const operator = operatorOf(stage);
    if (!TEMPLATES.some((template) => template.name === operator)) {
      select.append(el('option', { value: operator, text: operator }) as HTMLOptionElement);
    }
    select.value = operator;
    select.addEventListener('change', () => {
      const replacement = newStage(select.value);
      replacement.id = stage.id;
      stages[index] = replacement;
      commit(index, true);
    });
    return select;
  }

  function iconButton(text: string, title: string, onClick: () => void, disabled = false): HTMLButtonElement {
    const button = el('button', { className: 'mc-btn icon-only', text, title }) as HTMLButtonElement;
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function stageCard(stage: StageModel, index: number): HTMLElement {
    const card = el('section', { className: 'mc-stage-card' });
    card.dataset.stage = String(stage.id);
    const preview = previews.get(stage.id);

    const header = el('div', { className: 'mc-stage-header' },
      el('span', { className: 'mc-chip', text: String(index + 1) }),
      operatorSelect(stage, index),
      el('span', { className: 'mc-stage-detail mc-muted', text: TEMPLATES.find((t) => t.name === operatorOf(stage))?.detail ?? '' }),
      el('span', { className: 'spacer' })
    );
    const previewButton = el('button', {
      className: `mc-btn${preview?.open ? ' active' : ''}`,
      text: preview?.open ? '▾ Output' : '▸ Output',
      title: 'Show the documents this stage outputs'
    }) as HTMLButtonElement;
    previewButton.type = 'button';
    previewButton.addEventListener('click', () => {
      if (preview?.open) {
        preview.open = false;
        render();
      } else {
        void loadPreview(stage).then(render);
      }
    });
    header.append(
      previewButton,
      iconButton('↑', 'Move up', () => {
        [stages[index - 1], stages[index]] = [stages[index], stages[index - 1]];
        commit(index - 1, true);
      }, index === 0),
      iconButton('↓', 'Move down', () => {
        [stages[index], stages[index + 1]] = [stages[index + 1], stages[index]];
        commit(index, true);
      }, index === stages.length - 1),
      iconButton('⧉', 'Duplicate', () => {
        stages.splice(index + 1, 0, { ...structuredClone(stage), id: nextId++ });
        commit(index + 1, true);
      }),
      iconButton('✕', 'Delete stage', () => {
        stages.splice(index, 1);
        previews.delete(stage.id);
        commit(index, true);
      })
    );
    card.append(header);

    const body = el('div', { className: 'mc-stage-body' });
    if (stage.kind === 'lookup') {
      body.append(lookupForm(stage, index));
    } else if (stage.kind === 'graphLookup') {
      body.append(graphLookupForm(stage, index));
    } else {
      const kind: QueryInputKind = 'pipeline';
      body.append(codeEditor(stage, index, 'body', stage.body, kind, `[{ ${stage.operator}: `, localFields(index), (v) => (stage.body = v)));
    }
    card.append(body);

    const previewHost = el('div', { className: 'mc-stage-preview' });
    previewHost.dataset.preview = String(stage.id);
    previewHost.hidden = !preview?.open;
    card.append(previewHost);
    return card;
  }

  function addStageBar(): HTMLElement {
    const bar = el('div', { className: 'mc-builder-add' });
    bar.append(el('span', { className: 'mc-muted', text: 'Add stage:' }));
    for (const name of QUICK_STAGES) {
      const button = el('button', { className: 'mc-btn', text: name }) as HTMLButtonElement;
      button.type = 'button';
      button.addEventListener('click', () => addStage(name));
      bar.append(button);
    }
    const more = el('select', { className: 'mc-select', title: 'All stages' }) as HTMLSelectElement;
    more.append(el('option', { value: '', text: 'More…' }) as HTMLOptionElement);
    for (const template of TEMPLATES.filter((t) => !QUICK_STAGES.includes(t.name))) {
      more.append(el('option', { value: template.name, text: `${template.name} — ${template.detail}` }) as HTMLOptionElement);
    }
    more.addEventListener('change', () => {
      if (more.value) {
        addStage(more.value);
      }
    });
    bar.append(more);
    return bar;
  }

  function addStage(operator: string): void {
    const stage = newStage(operator);
    stages.push(stage);
    pendingFocus = { id: stage.id, name: stage.kind === 'generic' ? 'body' : 'from' };
    commit(stages.length - 1, true);
    element.querySelector(`[data-stage="${stage.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function render(): void {
    const scrollTop = element.scrollTop;
    disposers.forEach((dispose) => dispose());
    disposers = [];
    clear(element);
    if (stages.length === 0) {
      element.append(el('div', { className: 'mc-empty', text: 'No stages yet. Add the first stage below.' }));
    }
    stages.forEach((stage, index) => element.append(stageCard(stage, index)));
    element.append(addStageBar());
    stages.forEach((stage) => renderPreview(stage));
    element.scrollTop = scrollTop;
    if (pendingFocus) {
      const target = element.querySelector<HTMLElement>(
        `[data-stage="${pendingFocus.id}"] [data-control="${pendingFocus.name}"]`
      );
      target?.focus();
    }
  }

  /** (Re)build the model from the pipeline text. Returns false when the text cannot be parsed. */
  async function load(): Promise<boolean> {
    try {
      const result = await request<{ stages: ParsedStage[] }>('parseStages', { pipelineText: host.getPipelineText() || '[]' });
      stages = result.stages.map(fromParsed);
      previews.clear();
      pendingFocus = null;
      render();
      return true;
    } catch (err) {
      disposers.forEach((dispose) => dispose());
      disposers = [];
      clear(element);
      element.append(
        el('div', { className: 'mc-builder-error' },
          el('strong', { text: 'The pipeline text cannot be shown in the builder.' }),
          el('span', { className: 'error', text: (err as Error).message }),
          el('span', { className: 'mc-muted', text: 'Fix it in Text mode, then switch back.' })
        )
      );
      return false;
    }
  }

  return { element, load };
}

/** Pure model helpers, exported for tests. */
export const builderModel = { fromParsed, newStage, pipelineText, stageText };
