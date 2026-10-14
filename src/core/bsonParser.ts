import {
  Binary,
  BSONRegExp,
  Code,
  DBRef,
  Decimal128,
  Double,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  UUID,
  EJSON,
  type Document
} from 'bson';
import {
  parseExpressionAt,
  tokenizer,
  tokTypes,
  type CallExpression,
  type Expression,
  type NewExpression,
  type Property
} from 'acorn';

/**
 * Make a BSON class usable the way mongosh allows: both `ObjectId("…")` and
 * `new ObjectId("…")`. ES classes throw when called without `new`, so wrap
 * them in a plain function that keeps statics (`Binary.createFromBase64`)
 * and `instanceof` working.
 */
function callable<T extends abstract new (...args: never[]) => unknown>(Cls: T): T {
  const Ctor = Cls as unknown as new (...args: unknown[]) => unknown;
  function wrapper(...args: unknown[]): unknown {
    return new Ctor(...args);
  }
  Object.setPrototypeOf(wrapper, Cls);
  wrapper.prototype = Cls.prototype;
  return wrapper as unknown as T;
}

/**
 * Wrap a factory so `new Factory(…)` behaves like `Factory(…)`. A plain
 * function returning an object yields that object when called with `new`.
 */
function factory<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return function (...args: A): R {
    return fn(...args);
  };
}

/**
 * Compass' query bar accepts *shell* syntax, not strict JSON:
 *   { _id: ObjectId("…"), when: ISODate("…"), n: NumberLong(12) }
 *
 * The text is parsed into a syntax tree and evaluated node by node. Only
 * literals, objects, arrays, arithmetic, the BSON helpers below and the
 * methods in `ALLOWED_STATICS` / `isAllowedInstanceMethod` are understood;
 * nothing is ever run as code, so text from any source is safe to parse.
 */
const BSON_GLOBALS: Record<string, unknown> = {
  ObjectId: callable(ObjectId),
  ObjectID: callable(ObjectId),
  ISODate: factory((value?: string | number | Date) => (value === undefined ? new Date() : new Date(value))),
  // `Date(…)` without `new` returns a Date, not a string; statics such as `Date.now()` keep working.
  Date: callable(Date),
  NumberLong: factory((value: string | number = 0) =>
    typeof value === 'string' ? Long.fromString(value) : Long.fromNumber(value)
  ),
  NumberInt: factory((value: string | number = 0) => new Int32(Number(value))),
  NumberDecimal: factory((value: string | number = 0) => Decimal128.fromString(String(value))),
  Double: factory((value: number | string = 0) => new Double(Number(value))),
  Int32: callable(Int32),
  Long: callable(Long),
  Decimal128: callable(Decimal128),
  Binary: callable(Binary),
  UUID: factory((value?: string) => (value === undefined ? new UUID() : new UUID(value))),
  Timestamp: factory((value: { t: number; i: number }) => new Timestamp(value)),
  DBRef: callable(DBRef),
  MinKey: factory(() => new MinKey()),
  MaxKey: factory(() => new MaxKey()),
  Code: callable(Code),
  // Patterns or options only MongoDB's PCRE dialect accepts (`(?i)…`, `x`) stay BSON regexes.
  RegExp: factory((pattern: string, flags?: string) => {
    try {
      return new RegExp(pattern, flags);
    } catch {
      return new BSONRegExp(pattern, flags);
    }
  }),
  Symbol: factory((value: string) => value)
};

const CONSTANTS: Record<string, unknown> = { undefined, NaN, Infinity };

/** Static methods that may be called as `Name.method(…)`. */
const ALLOWED_STATICS: Record<string, readonly string[]> = {
  Date: ['now', 'UTC', 'parse'],
  ObjectId: ['createFromHexString', 'createFromBase64', 'createFromTime', 'isValid'],
  ObjectID: ['createFromHexString', 'createFromBase64', 'createFromTime', 'isValid'],
  Long: ['fromString', 'fromNumber', 'fromBits', 'fromBigInt'],
  Decimal128: ['fromString'],
  Binary: ['createFromBase64', 'createFromHexString'],
  UUID: ['createFromHexString', 'createFromBase64', 'isValid'],
  Math: ['abs', 'ceil', 'floor', 'max', 'min', 'pow', 'random', 'round', 'sign', 'trunc']
};

const STATIC_TARGETS: Record<string, unknown> = { ...BSON_GLOBALS, Math };

const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**']);

/** Side-effect-free methods allowed on values, e.g. `new Date().getTime()`. */
function isAllowedInstanceMethod(target: unknown, method: string): boolean {
  if (target instanceof Date) {
    return /^(get|to)[A-Z]\w*$/.test(method) || method === 'valueOf';
  }
  if (target instanceof ObjectId) {
    return method === 'getTimestamp' || method === 'toHexString';
  }
  return false;
}

export class QueryParseError extends Error {
  constructor(message: string, public readonly source: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * Parse a shell-style BSON expression into a plain JS/BSON object.
 * Empty input yields `{}`.
 */
export function parseShellBSON(text: string, fallback: Document = {}): Document {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  // Fast path: strict JSON / EJSON.
  try {
    const parsed = EJSON.parse(trimmed, { relaxed: false });
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as Document;
    }
  } catch {
    // fall through to shell parsing
  }

  try {
    const expression = parseExpressionAt(trimmed, 0, { ecmaVersion: 'latest' });
    // Comments may follow the expression, anything else may not.
    const rest = tokenizer(trimmed.slice(expression.end), { ecmaVersion: 'latest' }).getToken();
    if (rest.type !== tokTypes.eof) {
      throw new Error(`Unexpected "${trimmed.slice(expression.end).trim().slice(0, 20)}" after the expression`);
    }
    const result = evaluate(expression);
    if (result === undefined || result === null) {
      return fallback;
    }
    if (typeof result !== 'object') {
      throw new QueryParseError('Expression must evaluate to an object', trimmed);
    }
    return result as Document;
  } catch (err) {
    if (err instanceof QueryParseError) {
      throw err;
    }
    throw new QueryParseError(
      `Could not parse expression: ${(err as Error).message}`,
      trimmed
    );
  }
}

function evaluate(node: Expression): unknown {
  switch (node.type) {
    case 'Literal':
      if (node.regex) {
        return new RegExp(node.regex.pattern, node.regex.flags);
      }
      return node.bigint !== undefined ? BigInt(node.bigint) : node.value;
    case 'TemplateLiteral':
      return node.quasis
        .map((quasi, i) => (quasi.value.cooked ?? quasi.value.raw) + (i < node.expressions.length ? String(evaluate(node.expressions[i])) : ''))
        .join('');
    case 'Identifier':
      if (Object.hasOwn(CONSTANTS, node.name)) {
        return CONSTANTS[node.name];
      }
      if (Object.hasOwn(BSON_GLOBALS, node.name)) {
        return BSON_GLOBALS[node.name];
      }
      throw new Error(`Unknown identifier "${node.name}"`);
    case 'ArrayExpression': {
      const items: unknown[] = [];
      for (const element of node.elements) {
        if (element === null) {
          throw new Error('Empty array slots are not supported');
        }
        if (element.type === 'SpreadElement') {
          const spread = evaluate(element.argument);
          if (!Array.isArray(spread)) {
            throw new Error('Only arrays can be spread into an array');
          }
          items.push(...spread);
        } else {
          items.push(evaluate(element));
        }
      }
      return items;
    }
    case 'ObjectExpression': {
      const object: Record<string, unknown> = {};
      for (const property of node.properties) {
        if (property.type === 'SpreadElement') {
          const spread = evaluate(property.argument);
          if (spread !== null && typeof spread === 'object') {
            for (const [key, value] of Object.entries(spread)) {
              defineField(object, key, value);
            }
          }
          continue;
        }
        if (property.kind !== 'init' || property.method) {
          throw new Error('Getters, setters and methods are not supported');
        }
        defineField(object, propertyKey(property), evaluate(property.value));
      }
      return object;
    }
    case 'UnaryExpression': {
      const value = evaluate(node.argument);
      switch (node.operator) {
        case '-':
          return value instanceof Long ? value.negate() : -toNumber(value);
        case '+':
          return toNumber(value);
        case '!':
          return !value;
        case 'void':
          return undefined;
        default:
          throw new Error(`Operator "${node.operator}" is not supported`);
      }
    }
    case 'BinaryExpression': {
      if (!ARITHMETIC.has(node.operator)) {
        throw new Error(`Operator "${node.operator}" is not supported`);
      }
      return arithmetic(node.operator, evaluate(node.left as Expression), evaluate(node.right));
    }
    case 'CallExpression':
    case 'NewExpression':
      return evaluateCall(node);
    default:
      throw new Error(`Unsupported syntax (${node.type})`);
  }
}

function evaluateCall(node: CallExpression | NewExpression): unknown {
  const args = node.arguments.flatMap((arg) => {
    if (arg.type !== 'SpreadElement') {
      return [evaluate(arg)];
    }
    const spread = evaluate(arg.argument);
    if (!Array.isArray(spread)) {
      throw new Error('Only arrays can be spread into arguments');
    }
    return spread;
  });
  const callee = node.callee;

  if (callee.type === 'Identifier') {
    const helper = Object.hasOwn(BSON_GLOBALS, callee.name) ? BSON_GLOBALS[callee.name] : undefined;
    if (typeof helper !== 'function') {
      throw new Error(`"${callee.name}" is not a known function`);
    }
    // Every helper behaves the same with or without `new`.
    return (helper as (...a: unknown[]) => unknown)(...args);
  }

  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    const method = callee.property.name;
    if (callee.object.type === 'Identifier' && Object.hasOwn(ALLOWED_STATICS, callee.object.name)) {
      if (!ALLOWED_STATICS[callee.object.name].includes(method)) {
        throw new Error(`${callee.object.name}.${method}() is not supported`);
      }
      return callMethod(STATIC_TARGETS[callee.object.name], method, args);
    }
    const target = evaluate(callee.object as Expression);
    if (!isAllowedInstanceMethod(target, method)) {
      throw new Error(`.${method}() is not supported here`);
    }
    return callMethod(target, method, args);
  }

  throw new Error('Only BSON helpers such as ObjectId(…) can be called');
}

function callMethod(target: unknown, method: string, args: unknown[]): unknown {
  const fn = (target as Record<string, unknown>)[method];
  if (typeof fn !== 'function') {
    throw new Error(`${method} is not a function`);
  }
  return (fn as (...a: unknown[]) => unknown).apply(target, args);
}

function propertyKey(property: Property): string {
  if (property.computed) {
    const key = evaluate(property.key);
    if (typeof key !== 'string' && typeof key !== 'number') {
      throw new Error('Computed keys must be strings or numbers');
    }
    return String(key);
  }
  if (property.key.type === 'Identifier') {
    return property.key.name;
  }
  if (property.key.type === 'Literal') {
    return String(property.key.value);
  }
  throw new Error('Unsupported object key');
}

/** `defineProperty` keeps a field named "__proto__" a plain field instead of replacing the prototype. */
function defineField(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value instanceof Int32 || value instanceof Double) {
    return value.valueOf();
  }
  if (value instanceof Long) {
    return value.toNumber();
  }
  throw new Error(`Arithmetic needs numbers, got ${value === null ? 'null' : typeof value}`);
}

function arithmetic(operator: string, left: unknown, right: unknown): unknown {
  if (operator === '+' && (typeof left === 'string' || typeof right === 'string')) {
    return `${String(left)}${String(right)}`;
  }
  const a = toNumber(left);
  const b = toNumber(right);
  switch (operator) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    default: return a ** b;
  }
}

/** Parse a pipeline written as `[ { $match: … }, … ]` or as separate stage objects. */
export function parsePipeline(text: string): Document[] {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return [];
  }
  const result = parseShellBSON(trimmed, []);
  if (Array.isArray(result)) {
    return result as Document[];
  }
  throw new QueryParseError('A pipeline must be an array of stage documents', trimmed);
}

/** Parse a single stage document such as `{ $match: { a: 1 } }`. */
export function parseStage(text: string): Document | null {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  const parsed = parseShellBSON(trimmed);
  if (Array.isArray(parsed)) {
    throw new QueryParseError('A stage must be a single document, not an array', trimmed);
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    return null;
  }
  if (keys.length !== 1 || !keys[0].startsWith('$')) {
    const found = keys.length > 1 ? ` but has ${keys.length}: ${keys.join(', ')}` : ` but has "${keys[0]}"`;
    const hint = keys.length > 1 ? ' Put each stage in its own { } object: [{ $match: … }, { $project: … }].' : '';
    throw new QueryParseError(
      `A stage must contain exactly one aggregation operator${found}.${hint}`,
      trimmed
    );
  }
  return parsed;
}

/** Parse a sort spec that may be given as `{a: 1}` or `"a"` / `"-a"`. */
export function parseSort(text: string): Document {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return {};
  }
  if (/^-?[\w.]+$/.test(trimmed)) {
    const descending = trimmed.startsWith('-');
    return { [descending ? trimmed.slice(1) : trimmed]: descending ? -1 : 1 };
  }
  return parseShellBSON(trimmed);
}

/** Parse a positive integer option (skip / limit). */
export function parseNumberOption(text: string | number | undefined, fallback = 0): number {
  if (text === undefined || text === null || text === '') {
    return fallback;
  }
  const value = typeof text === 'number' ? text : Number(String(text).trim());
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(value));
}
