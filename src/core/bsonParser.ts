import {
  Binary,
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
 * The expression is evaluated by a function whose parameters shadow the
 * BSON constructors below. This is not a security sandbox: it runs in the
 * extension host, so it must only ever receive text the user typed.
 */
const BSON_GLOBALS = {
  ObjectId: callable(ObjectId),
  ObjectID: callable(ObjectId),
  ISODate: factory((value?: string | number | Date) => (value === undefined ? new Date() : new Date(value))),
  Date: factory((value?: string | number) => (value === undefined ? new Date() : new Date(value))),
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
  RegExp: factory((pattern: string, flags?: string) => new RegExp(pattern, flags)),
  Symbol: factory((value: string) => value),
  undefinedValue: undefined
};

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

  const names = Object.keys(BSON_GLOBALS);
  const values = names.map((name) => (BSON_GLOBALS as Record<string, unknown>)[name]);

  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(...names, `"use strict"; return (${trimmed});`) as (
      ...args: unknown[]
    ) => unknown;
    const result = factory(...values);
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
