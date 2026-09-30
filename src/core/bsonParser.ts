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
 * Compass' query bar accepts *shell* syntax, not strict JSON:
 *   { _id: ObjectId("…"), when: ISODate("…"), n: NumberLong(12) }
 *
 * We evaluate the expression inside a sandboxed function whose scope only
 * exposes the BSON constructors, then normalise the result.
 */
const BSON_GLOBALS = {
  ObjectId,
  ObjectID: ObjectId,
  ISODate: (value?: string | Date) => (value === undefined ? new Date() : new Date(value as string)),
  Date: (value?: string | number) => new Date(value as string | number),
  NumberLong: (value?: string | number) => Long.fromValue(value as string | number),
  NumberInt: (value: string | number) => new Int32(Number(value)),
  NumberDecimal: (value: string | number) => Decimal128.fromString(String(value)),
  Double: (value: number) => new Double(value),
  Int32,
  Long,
  Decimal128,
  Binary,
  UUID: (value?: string) => (value === undefined ? new UUID() : new UUID(value)),
  Timestamp: (value: { t: number; i: number }) => new Timestamp(value),
  DBRef,
  MinKey: () => new MinKey(),
  MaxKey: () => new MaxKey(),
  Code,
  RegExp: (pattern: string, flags?: string) => new RegExp(pattern, flags),
  Symbol: (value: string) => value,
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
    throw new QueryParseError('A stage must contain exactly one aggregation operator', trimmed);
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
