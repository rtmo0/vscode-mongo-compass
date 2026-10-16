/**
 * A small YAML emitter for exported definitions (docker-compose files and
 * Kubernetes manifests). Handles plain objects, arrays, strings, numbers,
 * booleans and null — everything those files need. Strings are quoted
 * whenever a plain scalar could be misread.
 */
export function toYaml(value: unknown, indent = 0): string {
  return emit(value, indent).replace(/^\n/, '') + '\n';
}

/** Several documents separated by `---`. */
export function toYamlDocuments(values: unknown[]): string {
  return values.map((v) => toYaml(v)).join('---\n');
}

function emit(value: unknown, indent: number): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ' []';
    }
    return value
      .map((item) => {
        if (isObject(item) && Object.keys(item).length > 0) {
          const inner = emit(item, indent + 2).replace(/^\n/, '');
          return `\n${pad}- ${inner.slice(indent + 2)}`;
        }
        return `\n${pad}-${emit(item, indent + 2)}`;
      })
      .join('');
  }
  if (isObject(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return ' {}';
    }
    return entries
      .map(([key, v]) => {
        const k = scalar(key);
        if (Array.isArray(v) || (isObject(v) && Object.keys(v).length > 0)) {
          return `\n${pad}${k}:${emit(v, Array.isArray(v) ? indent : indent + 2)}`;
        }
        if (typeof v === 'string' && v.includes('\n')) {
          const body = v.replace(/\n$/, '').split('\n').map((line) => `${pad}  ${line}`).join('\n');
          return `\n${pad}${k}: |\n${body}`;
        }
        return `\n${pad}${k}:${emit(v, indent + 2)}`;
      })
      .join('');
  }
  return ` ${scalar(value)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const text = String(value);
  const needsQuotes =
    text === '' ||
    /^[\s-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /[:#]\s|\s$|:$/.test(text) ||
    /^(true|false|yes|no|on|off|null|~)$/i.test(text) ||
    /^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(text) ||
    /^0[xo]/i.test(text);
  return needsQuotes ? JSON.stringify(text) : text;
}
