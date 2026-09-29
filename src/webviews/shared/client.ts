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
