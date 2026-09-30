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

/**
 * Lightweight EJSON syntax highlighter. Produces safe HTML (input escaped).
 */
export function highlightJson(value: unknown, indent = 2): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value, null, indent);
  if (json === undefined) {
    return '';
  }
  const escaped = escapeHtml(json);
  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|\b(?:ObjectId|ISODate|NumberLong|NumberInt|NumberDecimal|UUID|Timestamp|DBRef|Binary)\b)/g,
    (match) => {
      let cls = 'tok-number';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'tok-key' : 'tok-string';
      } else if (/true|false/.test(match)) {
        cls = 'tok-boolean';
      } else if (/null/.test(match)) {
        cls = 'tok-null';
      } else if (/ObjectId|ISODate|NumberLong|NumberInt|NumberDecimal|UUID|Timestamp|DBRef|Binary/.test(match)) {
        cls = 'tok-bson';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
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
    highlight.innerHTML = `${highlightJson(textarea.value)}\n`;
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
