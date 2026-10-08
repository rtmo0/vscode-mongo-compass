/* Shared client-side helpers bundled into every webview. */

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode = acquireVsCodeApi();

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<string, PendingRequest>();
const listeners = new Map<string, Set<(payload: unknown) => void>>();

let requestCounter = 0;

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as {
    type: string;
    requestId?: string;
    payload?: unknown;
    error?: { message: string; code?: number };
  };

  if (message.type === 'response' && message.requestId) {
    const entry = pending.get(message.requestId);
    if (entry) {
      pending.delete(message.requestId);
      if (message.error) {
        entry.reject(new Error(message.error.message));
      } else {
        entry.resolve(message.payload);
      }
    }
    return;
  }

  const handlers = listeners.get(message.type);
  if (handlers) {
    for (const handler of handlers) {
      handler(message.payload);
    }
  }
});

/** Send a request to the extension host and await the correlated response. */
export function request<T = unknown>(type: string, payload?: unknown): Promise<T> {
  const requestId = `req-${Date.now()}-${requestCounter++}`;
  return new Promise<T>((resolve, reject) => {
    pending.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject
    });
    vscode.postMessage({ type, requestId, payload });
  });
}

/** Subscribe to push messages from the extension host. */
export function on(type: string, handler: (payload: unknown) => void): void {
  let set = listeners.get(type);
  if (!set) {
    set = new Set();
    listeners.set(type, set);
  }
  set.add(handler);
}

/** Persist UI state across reloads (VS Code keeps webview state). */
export function getState<T>(fallback: T): T {
  return (vscode.getState() as T) ?? fallback;
}

export function setState<T>(state: T): void {
  vscode.setState(state);
}

// ───────────────────────────── DOM helpers ─────────────────────────────

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string; text?: string } = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  const { className, text, ...rest } = props;
  if (className !== undefined) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  Object.assign(node, rest);
  for (const child of children) {
    node.append(child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/** Escape a string for safe insertion into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BSON_CONSTRUCTORS = new Set([
  'ObjectId', 'ObjectID', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'Double', 'Int32',
  'Long', 'Decimal128', 'Binary', 'UUID', 'Timestamp', 'DBRef', 'MinKey', 'MaxKey', 'Code', 'RegExp', 'BSONRegExp', 'new'
]);

/** After these characters a `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', ':', '[', '{', '=', '!', '&', '|', '?', ';']);

/**
 * Syntax highlighter for JSON, Extended JSON and mongosh-style query source.
 * Each token is escaped on its own, so the output is safe HTML.
 */
export function highlightCode(text: string): string {
  let out = '';
  let i = 0;
  /** Last significant character, or 'v' after a value-like token. */
  let prev = '';
  const push = (cls: string, value: string): void => {
    out += cls ? `<span class="${cls}">${escapeHtml(value)}</span>` : escapeHtml(value);
  };
  const followedByColon = (from: number): boolean => /^\s*:(?!:)/.test(text.slice(from, from + 64));

  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);

    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      push('tok-comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      push('tok-comment', text.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch && text[j] !== '\n') {
        j += text[j] === '\\' ? 2 : 1;
      }
      if (text[j] === ch) {
        j += 1;
      }
      const token = text.slice(i, j);
      const content = token.slice(1, token.length > 1 && token.endsWith(ch) ? -1 : undefined);
      let cls = 'tok-string';
      if (followedByColon(j)) {
        cls = content.startsWith('$') ? 'tok-operator' : 'tok-key';
      } else if (content.startsWith('$$')) {
        cls = 'tok-variable';
      } else if (/^\$[A-Za-z_]/.test(content)) {
        cls = 'tok-fieldref';
      }
      push(cls, token);
      prev = 'v';
      i = j;
      continue;
    }
    if (ch === '/' && REGEX_PRECEDERS.has(prev)) {
      const match = /^\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuy]*/.exec(rest);
      if (match) {
        push('tok-regex', match[0]);
        prev = 'v';
        i += match[0].length;
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const word = /^[A-Za-z_$][\w$]*/.exec(rest)![0];
      let cls = '';
      if (followedByColon(i + word.length)) {
        cls = word.startsWith('$') ? 'tok-operator' : 'tok-key';
      } else if (word === 'true' || word === 'false') {
        cls = 'tok-boolean';
      } else if (word === 'null' || word === 'undefined') {
        cls = 'tok-null';
      } else if (word === 'NaN' || word === 'Infinity') {
        cls = 'tok-number';
      } else if (BSON_CONSTRUCTORS.has(word)) {
        cls = 'tok-bson';
      } else if (word.startsWith('$$')) {
        cls = 'tok-variable';
      } else if (word.startsWith('$')) {
        cls = 'tok-operator';
      }
      push(cls, word);
      prev = word === 'new' ? '(' : 'v';
      i += word.length;
      continue;
    }
    const number = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (number && (/\d/.test(ch) || prev !== 'v')) {
      push('tok-number', number[0]);
      prev = 'v';
      i += number[0].length;
      continue;
    }
    if ('{}[]():,'.includes(ch)) {
      push('tok-punct', ch);
      prev = ch;
      i += 1;
      continue;
    }
    push('', ch);
    if (!/\s/.test(ch)) {
      prev = ch;
    }
    i += 1;
  }
  return out;
}

/** Highlight a value (serialised as indented JSON) or a source string. */
export function highlightJson(value: unknown, indent = 2): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, indent);
  return text === undefined ? '' : highlightCode(text);
}

/**
 * Colour a single-line `<input>` by drawing highlighted text over it.
 * The input keeps focus, caret, selection and events; only its own glyphs
 * are made transparent. Programmatic `value` assignments refresh the layer.
 */
export function attachInputHighlight(input: HTMLInputElement): void {
  const wrapper = el('span', { className: 'mc-hl-input' });
  const layer = el('span', { className: 'mc-hl-input-layer' });
  layer.setAttribute('aria-hidden', 'true');
  wrapper.style.flex = getComputedStyle(input).flex;
  input.replaceWith(wrapper);
  wrapper.append(input, layer);
  input.classList.add('mc-hl-input-field');

  const syncMetrics = (): void => {
    const style = getComputedStyle(input);
    const props = [
      'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'letterSpacing'
    ] as const;
    for (const prop of props) {
      layer.style[prop] = style[prop];
    }
    layer.style.borderStyle = 'solid';
    layer.style.borderColor = 'transparent';
    layer.style.lineHeight = `${input.clientHeight}px`;
  };
  const update = (): void => {
    layer.innerHTML = highlightCode(input.value);
    layer.scrollLeft = input.scrollLeft;
  };
  const syncScroll = (): void => {
    requestAnimationFrame(() => {
      layer.scrollLeft = input.scrollLeft;
    });
  };

  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
  Object.defineProperty(input, 'value', {
    configurable: true,
    get(this: HTMLInputElement) {
      return descriptor.get!.call(this);
    },
    set(this: HTMLInputElement, next: string) {
      descriptor.set!.call(this, next);
      update();
    }
  });

  input.addEventListener('input', update);
  for (const type of ['scroll', 'keydown', 'keyup', 'click', 'focus', 'blur', 'select', 'mousemove']) {
    input.addEventListener(type, syncScroll);
  }
  new ResizeObserver(syncMetrics).observe(input);
  syncMetrics();
  update();
}

/** Render an expandable canonical Extended JSON tree shared by document and aggregation views. */
export function createJsonTree(value: unknown, expanded = true): HTMLElement {
  return renderJsonNode(value, 0, expanded, false, true);
}

/** Render document fields as the collapsible tree used by list views. */
export function createFieldTree(value: Record<string, unknown>): HTMLElement {
  const tree = el('div', { className: 'mc-tree' });
  for (const [key, fieldValue] of Object.entries(value)) {
    tree.append(renderFieldTreeRow(key, fieldValue, 0));
  }
  return tree;
}

export interface DocumentViewOptions {
  startIndex?: number;
  actions?: (document: Record<string, unknown>, index: number) => HTMLElement[];
}

/** Render documents with the shared collapsible tree presentation. */
export function createDocumentList(
  documents: Record<string, unknown>[],
  options: DocumentViewOptions = {}
): HTMLElement {
  const container = el('div', { className: 'mc-document-list' });
  documents.forEach((document, index) => {
    const tree = createFieldTree(document);
    tree.classList.add('mc-doc-body');
    const header = el('div', { className: 'mc-doc-header' },
      el('span', { className: 'mc-chip', text: `#${(options.startIndex ?? 0) + index + 1}` }),
      el('span', { className: 'doc-id', text: formatDocumentId(document._id) }),
      el('span', { className: 'spacer' })
    );
    header.append(...(options.actions?.(document, index) ?? []));
    container.append(el('article', { className: 'mc-doc' }, header, tree));
  });
  return container;
}

/** Render documents with the shared expandable Extended JSON presentation. */
export function createDocumentJsonList(
  documents: Record<string, unknown>[],
  options: DocumentViewOptions = {}
): HTMLElement {
  const container = el('div', { className: 'mc-json-list' });
  documents.forEach((document, index) => {
    const header = el('div', {
      className: 'mc-json-document-number',
      text: `Document ${(options.startIndex ?? 0) + index + 1}`
    });
    header.append(...(options.actions?.(document, index) ?? []));
    container.append(el('article', { className: 'mc-json-document' }, header, createJsonTree(document)));
  });
  return container;
}

/** Format a value for a compact table cell while preserving EJSON scalar types. */
export function formatJsonCell(value: unknown, compact = false): string {
  if (value === undefined) return '—';
  if (value === null || typeof value !== 'object') return formatJsonTreeValue(value);
  const scalar = formatEjsonScalar(value);
  if (scalar !== undefined) return scalar;
  return compact ? jsonValueSummary(value as Record<string, unknown> | unknown[]) : JSON.stringify(value);
}

function renderFieldTreeRow(key: string, value: unknown, depth: number): HTMLElement {
  const branch = isJsonContainer(value);
  const row = el('div', { className: 'mc-tree-row' });
  row.style.setProperty('--tree-depth', String(depth));
  const toggle = el('button', {
    className: `mc-tree-toggle${branch ? '' : ' leaf'}`,
    text: branch ? '▸' : '',
    title: branch ? 'Expand field' : ''
  });
  row.append(
    toggle,
    el('span', { className: 'mc-tree-key', text: key }),
    el('span', { className: 'mc-tree-separator', text: ':' }),
    el('span', {
      className: `mc-tree-value ${jsonValueClass(value)}`,
      text: branch ? jsonValueSummary(value) : formatJsonTreeValue(value)
    })
  );

  const field = el('div', { className: 'mc-tree-field' }, row);
  if (!branch) return field;
  const children = el('div', { className: 'mc-tree-children' });
  children.hidden = true;
  for (const [childKey, childValue] of Object.entries(value)) {
    children.append(renderFieldTreeRow(childKey, childValue, depth + 1));
  }
  toggle.addEventListener('click', () => {
    children.hidden = !children.hidden;
    toggle.textContent = children.hidden ? '▸' : '▾';
    toggle.title = children.hidden ? 'Expand field' : 'Collapse field';
  });
  field.append(children);
  return field;
}

function renderJsonNode(value: unknown, depth: number, expanded: boolean, trailingComma: boolean, canonical = false): HTMLElement {
  if (!isJsonContainer(value, canonical)) {
    return el('span', {
      className: `mc-json-value ${jsonValueClass(value)}`,
      text: formatJsonTreeValue(value)
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
  const preview = el('span', {
    className: 'mc-json-preview',
    text: expanded ? '' : `${jsonValueSummary(value)} ${close}${trailingComma ? ',' : ''}`
  });
  line.append(toggle, el('span', { className: 'mc-json-punctuation', text: open }), preview);

  const children = el('div', { className: 'mc-json-children' });
  children.hidden = !expanded;
  entries.forEach(([key, childValue], index) => {
    children.append(renderJsonProperty(key, childValue, depth + 1, isArray, index < entries.length - 1, canonical));
  });

  const closing = el('div', {
    className: 'mc-json-closing',
    text: `${close}${trailingComma ? ',' : ''}`
  });
  closing.style.setProperty('--json-depth', String(depth));
  closing.hidden = !expanded;

  toggle.addEventListener('click', () => {
    expanded = children.hidden;
    children.hidden = !expanded;
    closing.hidden = !expanded;
    preview.textContent = expanded ? '' : `${jsonValueSummary(value)} ${close}${trailingComma ? ',' : ''}`;
    toggle.textContent = expanded ? '▾' : '▸';
    toggle.title = expanded ? 'Collapse value' : 'Expand value';
  });

  wrapper.append(line, children, closing);
  return wrapper;
}

function renderJsonProperty(key: string, value: unknown, depth: number, parentIsArray: boolean, trailingComma: boolean, canonical: boolean): HTMLElement {
  const property = el('div', { className: 'mc-json-property' });
  property.style.setProperty('--json-depth', String(depth));
  property.append(
    el('span', { className: 'mc-json-key', text: parentIsArray ? key : JSON.stringify(key) }),
    el('span', { className: 'mc-json-colon', text: ': ' })
  );

  if (!isJsonContainer(value, canonical)) {
    property.append(renderJsonNode(value, depth, false, false, canonical));
    if (trailingComma) property.append(el('span', { className: 'mc-json-punctuation', text: ',' }));
    return property;
  }

  const nested = renderJsonNode(value, depth, false, trailingComma, canonical);
  nested.classList.add('mc-json-nested-node');
  property.append(nested.querySelector('.mc-json-line') as HTMLElement);
  const wrapper = el('div', { className: 'mc-json-property-node' }, property);
  const children = nested.querySelector('.mc-json-children') as HTMLElement;
  const closing = nested.querySelector('.mc-json-closing') as HTMLElement;
  wrapper.append(children, closing);
  return wrapper;
}

function isJsonContainer(value: unknown, canonical = false): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object' && (canonical || formatEjsonScalar(value) === undefined);
}

function jsonValueSummary(value: Record<string, unknown> | unknown[]): string {
  return Array.isArray(value) ? `Array (${value.length})` : `Object (${Object.keys(value).length})`;
}

function formatDocumentId(value: unknown): string {
  if (value === undefined) return '(no _id)';
  if (value !== null && typeof value === 'object') {
    const oid = (value as Record<string, unknown>).$oid;
    return typeof oid === 'string' ? `ObjectId(${oid})` : JSON.stringify(value);
  }
  return String(value);
}

function formatJsonTreeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return formatEjsonScalar(value) ?? String(value);
  return String(value);
}

function jsonValueClass(value: unknown): string {
  if (value === null) return 'tok-null';
  if (typeof value === 'string') return 'tok-string';
  if (typeof value === 'number' || typeof value === 'bigint') return 'tok-number';
  if (typeof value === 'boolean') return 'tok-boolean';
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if ('$numberLong' in obj || '$numberInt' in obj || '$numberDouble' in obj || '$numberDecimal' in obj) {
      return 'tok-number';
    }
    return 'tok-bson';
  }
  return '';
}

function formatEjsonScalar(value: object): string | undefined {
  if (Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const date = formatEjsonDate(value);
  if (date !== undefined) return date;
  if (typeof obj.$oid === 'string') return `ObjectId('${obj.$oid}')`;
  if (typeof obj.$numberLong === 'string') return `NumberLong('${obj.$numberLong}')`;
  if (typeof obj.$numberInt === 'string') return `NumberInt('${obj.$numberInt}')`;
  if (typeof obj.$numberDouble === 'string') return `NumberDouble('${obj.$numberDouble}')`;
  if (typeof obj.$numberDecimal === 'string') return `Decimal128('${obj.$numberDecimal}')`;
  if (obj.$timestamp !== null && typeof obj.$timestamp === 'object') {
    const timestamp = obj.$timestamp as Record<string, unknown>;
    return `Timestamp(${String(timestamp.t ?? '?')}, ${String(timestamp.i ?? '?')})`;
  }
  if (obj.$binary !== null && typeof obj.$binary === 'object') {
    const binary = obj.$binary as Record<string, unknown>;
    if (typeof binary.base64 === 'string') {
      const subtype = typeof binary.subType === 'string' ? Number.parseInt(binary.subType, 16) : 0;
      const preview = binary.base64.length > 96 ? `${binary.base64.slice(0, 96)}…` : binary.base64;
      return `Binary.createFromBase64('${preview}', ${Number.isNaN(subtype) ? 0 : subtype})`;
    }
  }
  if (obj.$regularExpression !== null && typeof obj.$regularExpression === 'object') {
    const regex = obj.$regularExpression as Record<string, unknown>;
    return `/${String(regex.pattern ?? '')}/${String(regex.options ?? '')}`;
  }
  if (typeof obj.$minKey === 'number') return 'MinKey()';
  if (typeof obj.$maxKey === 'number') return 'MaxKey()';
  if (obj.$undefined === true) return 'undefined';
  return undefined;
}

function formatEjsonDate(value: object): string | undefined {
  if (Array.isArray(value)) return undefined;
  const dateValue = (value as Record<string, unknown>).$date;
  let raw: string | number | undefined;

  if (typeof dateValue === 'string' || typeof dateValue === 'number') {
    raw = dateValue;
  } else if (dateValue !== null && typeof dateValue === 'object') {
    const numberLong = (dateValue as Record<string, unknown>).$numberLong;
    if (typeof numberLong === 'string') raw = numberLong;
  }

  if (raw === undefined) return undefined;
  const date = new Date(typeof raw === 'number' ? raw : /^-?\d+$/.test(raw) ? Number(raw) : raw);
  return Number.isNaN(date.getTime())
    ? `ISODate('${String(raw)}')`
    : `ISODate('${date.toISOString().replace('Z', '+00:00')}')`;
}

/** Create an editable textarea with a synchronized BSON/EJSON highlight layer. */
export function createSyntaxEditor(value: string, rows: number): {
  element: HTMLElement;
  textarea: HTMLTextAreaElement;
} {
  const element = el('div', { className: 'mc-syntax-editor' });
  const highlight = el('pre', { className: 'mc-syntax-editor-highlight' });
  const textarea = el('textarea', {
    className: 'mc-textarea mc-syntax-editor-input',
    rows
  }) as HTMLTextAreaElement;
  textarea.value = value;
  textarea.spellcheck = false;

  const update = (): void => {
    highlight.innerHTML = `${highlightCode(textarea.value)}\n`;
  };
  textarea.addEventListener('input', update);
  textarea.addEventListener('scroll', () => {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  });
  update();
  element.append(highlight, textarea);
  return { element, textarea };
}

export interface ExplainViewData {
  tree: ExplainViewNode[];
  insights: string[];
  executionStats?: Record<string, unknown>;
  raw: Record<string, unknown>;
  elapsedMS?: number;
}

interface ExplainViewNode {
  stage: string;
  description: string;
  details: Record<string, string>;
  children: ExplainViewNode[];
}

/** Render a compact Compass-style explain plan with visual and raw tabs. */
export function createExplainView(data: ExplainViewData): HTMLElement {
  const root = el('div', { className: 'mc-explain-view' });
  const tabs = el('div', { className: 'mc-explain-tabs' });
  const visualButton = el('button', { className: 'mc-btn active', text: 'Visual Tree' });
  const rawButton = el('button', { className: 'mc-btn', text: 'Raw Output' });
  tabs.append(visualButton, rawButton);

  const visual = el('div', { className: 'mc-explain-visual' });
  const raw = el('pre', { className: 'mc-mono mc-explain-raw' });
  raw.innerHTML = highlightJson(data.raw);
  raw.hidden = true;

  const canvas = el('div', { className: 'mc-explain-canvas' });
  const tree = el('div', { className: 'mc-explain-tree' });
  for (const node of data.tree) tree.append(renderExplainBranch(node));
  if (!data.tree.length) tree.append(el('div', { className: 'mc-muted', text: 'No execution stages returned.' }));
  canvas.append(tree, renderExplainSummary(data));

  const insights = el('div', { className: 'mc-explain-insights' });
  for (const insight of data.insights) {
    insights.append(el('div', { className: explainInsightClass(insight), text: stripInsightMarkdown(insight) }));
  }
  visual.append(canvas, insights);

  const select = (showRaw: boolean): void => {
    visual.hidden = showRaw;
    raw.hidden = !showRaw;
    visualButton.classList.toggle('active', !showRaw);
    rawButton.classList.toggle('active', showRaw);
  };
  visualButton.addEventListener('click', () => select(false));
  rawButton.addEventListener('click', () => select(true));
  root.append(tabs, visual, raw);
  return root;
}

function renderExplainBranch(node: ExplainViewNode): HTMLElement {
  const branch = el('div', { className: 'mc-explain-branch' });
  const card = el('section', { className: `mc-explain-stage mc-explain-stage-${node.stage.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` });
  card.append(el('div', { className: 'mc-explain-stage-name', text: node.stage }));
  const metrics = el('dl', { className: 'mc-explain-stage-metrics' });
  for (const [key, value] of Object.entries(node.details).slice(0, 6)) {
    metrics.append(el('dt', { text: key }), el('dd', { text: value }));
  }
  if (metrics.children.length) card.append(metrics);
  card.title = node.description;
  branch.append(card);
  if (node.children.length) {
    const children = el('div', { className: 'mc-explain-children' });
    for (const child of node.children) children.append(renderExplainBranch(child));
    branch.append(children);
  }
  return branch;
}

function renderExplainSummary(data: ExplainViewData): HTMLElement {
  const stats = data.executionStats ?? {};
  const returned = Number(stats.nReturned ?? 0);
  const examined = Number(stats.totalDocsExamined ?? 0);
  const keys = Number(stats.totalKeysExamined ?? 0);
  const millis = Number(stats.executionTimeMillis ?? data.elapsedMS ?? 0);
  const stages = flattenExplainStages(data.tree);
  const summary = el('aside', { className: 'mc-explain-summary' });
  summary.append(el('div', { className: 'mc-explain-summary-title', text: 'Query Performance Summary' }));
  const list = el('dl');
  list.append(
    el('dt', { text: 'Documents returned' }), el('dd', { text: formatNumber(returned) }),
    el('dt', { text: 'Documents examined' }), el('dd', { text: formatNumber(examined) }),
    el('dt', { text: 'Execution time' }), el('dd', { text: `${formatNumber(millis)} ms` }),
    el('dt', { text: 'Index keys examined' }), el('dd', { text: formatNumber(keys) }),
    el('dt', { text: 'Index used' }), el('dd', { text: stages.includes('IXSCAN') ? 'Yes' : 'No' })
  );
  summary.append(list);
  if (stages.includes('COLLSCAN')) {
    summary.append(el('div', { className: 'mc-explain-warning', text: 'No index available for this query.' }));
  }
  return summary;
}

function flattenExplainStages(nodes: ExplainViewNode[]): string[] {
  return nodes.flatMap((node) => [node.stage, ...flattenExplainStages(node.children)]);
}

function explainInsightClass(insight: string): string {
  if (/⚠|🔴|collection scan|spilled/i.test(insight)) return 'mc-explain-insight warning';
  if (/✅|covered|index was used/i.test(insight)) return 'mc-explain-insight success';
  return 'mc-explain-insight';
}

function stripInsightMarkdown(insight: string): string {
  return insight.replace(/[✅⚠️🔴ℹ️⏱️]/gu, '').replace(/\*\*|`/g, '').trim();
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  return value.toLocaleString();
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}
