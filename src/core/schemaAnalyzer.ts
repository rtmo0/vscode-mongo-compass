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
  UUID
} from 'bson';
import type { Document } from 'mongodb';
import type { IndexInfo, SchemaField, SchemaType } from './types';

const MAX_UNIQUE_VALUES = 100;

/**
 * A dependency-free re-implementation of the parts of `@mongodb-js/mongodb-schema`
 * that Compass' Schema tab relies on: field paths, type distribution,
 * uniqueness, string/number statistics and nested document/array analysis.
 */
export function analyzeDocuments(
  documents: Document[],
  indexes: IndexInfo[] = []
): { fields: SchemaField[]; suggestions: string[] } {
  const total = documents.length;
  // A single accumulator tree keyed by full path. Top-level fields live at
  // their own key; nested fields are discovered while walking each document.
  const fields = new Map<string, FieldAccumulator>();

  for (const doc of documents) {
    collectFields(doc, '', fields);
  }

  const flat = [...fields.values()]
    .map((field) => field.toSchemaField(total))
    .sort((a, b) => a.path.localeCompare(b.path));
  const suggestions = buildSuggestions(flat, indexes);
  return { fields: flat, suggestions };
}

/** Walk a document and record every field path (top-level and nested) with
 * its value, so `count`/`probability` are computed per path. */
function collectFields(
  value: unknown,
  path: string,
  fields: Map<string, FieldAccumulator>,
  seen: Set<unknown> = new Set()
): void {
  if (value === null || value === undefined) {
    return;
  }
  // Only descend into true documents. BSON scalars (ObjectId, Binary, Date,
  // UUID, …) are objects too, but their internals must stay opaque.
  if (bsonTypeName(value) !== 'Document') {
    return;
  }
  if (seen.has(value)) {
    return; // guard against cyclic documents
  }
  seen.add(value);

  for (const [key, child] of Object.entries(value as Document)) {
    const childPath = path ? `${path}.${key}` : key;
    let field = fields.get(childPath);
    if (!field) {
      field = new FieldAccumulator(childPath, childPath);
      fields.set(childPath, field);
    }
    field.addValue(child);
    // Descend only into real subdocuments (not BSON scalars like UUID,
    // ObjectId or Binary, whose internal representation must stay opaque),
    // and into documents stored inside arrays, so paths like `meta.city`
    // and `tags.title` are discovered.
    const childType = bsonTypeName(child);
    if (childType === 'Document') {
      collectFields(child, childPath, fields, seen);
    } else if (childType === 'Array') {
      for (const item of child as unknown[]) {
        if (bsonTypeName(item) === 'Document') {
          collectFields(item, childPath, fields, seen);
        }
      }
    }
  }
}

class TypeAccumulator {
  count = 0;
  private readonly uniqueValues = new Set<string>();
  private valuesTruncated = false;
  private minLength = Number.POSITIVE_INFINITY;
  private maxLength = 0;
  private totalLength = 0;
  private min = Number.POSITIVE_INFINITY;
  private max = Number.NEGATIVE_INFINITY;
  private totalNumber = 0;

  constructor(public readonly name: string) {}

  /** Record one value's type statistics. No recursion — nested paths are
   * handled by `collectFields` so each value is visited exactly once. */
  add(value: unknown): void {
    this.count += 1;
    const typeName = bsonTypeName(value);

    if (typeName === 'String') {
      const str = value as string;
      this.minLength = Math.min(this.minLength, str.length);
      this.maxLength = Math.max(this.maxLength, str.length);
      this.totalLength += str.length;
    }

    if (isNumericType(typeName)) {
      const num = toNumber(value);
      if (num !== null) {
        this.min = Math.min(this.min, num);
        this.max = Math.max(this.max, num);
        this.totalNumber += num;
      }
    }

    if (!this.valuesTruncated) {
      const serialised = serialiseValue(value);
      if (this.uniqueValues.size < MAX_UNIQUE_VALUES) {
        this.uniqueValues.add(serialised);
      } else {
        this.valuesTruncated = true;
      }
    }
  }

  toSchemaType(total: number): SchemaType {
    const result: SchemaType = {
      name: this.name,
      count: this.count,
      probability: ratio(this.count, total)
    };

    if (!this.valuesTruncated && this.uniqueValues.size <= MAX_UNIQUE_VALUES) {
      result.unique = this.uniqueValues.size;
      if (this.uniqueValues.size <= 20) {
        result.values = [...this.uniqueValues].map(deserialiseValue);
      }
    }

    if (this.name === 'String' && this.count > 0) {
      result.minLength = this.minLength === Number.POSITIVE_INFINITY ? 0 : this.minLength;
      result.maxLength = this.maxLength;
      result.averageLength = round(this.totalLength / this.count);
    }

    if (isNumericType(this.name) && this.count > 0 && this.min !== Number.POSITIVE_INFINITY) {
      result.min = this.min;
      result.max = this.max;
      result.average = round(this.totalNumber / this.count);
    }

    return result;
  }
}

class FieldAccumulator {
  count = 0;
  private readonly types = new Map<string, TypeAccumulator>();

  constructor(
    public readonly name: string,
    public readonly relativePath: string
  ) {}

  /** Record one field occurrence (one document). */
  addValue(value: unknown): void {
    this.count += 1;
    const typeName = bsonTypeName(value);
    let acc = this.types.get(typeName);
    if (!acc) {
      acc = new TypeAccumulator(typeName);
      this.types.set(typeName, acc);
    }
    acc.add(value);
  }

  toSchemaField(total: number): SchemaField {
    return {
      path: this.relativePath || this.name,
      name: this.name,
      count: this.count,
      probability: ratio(this.count, total),
      types: [...this.types.values()]
        .map((acc) => acc.toSchemaType(this.count))
        .sort((a, b) => b.count - a.count)
    };
  }
}

function buildSuggestions(fields: SchemaField[], indexes: IndexInfo[]): string[] {
  const suggestions: string[] = [];
  const indexedPaths = new Set<string>();
  for (const index of indexes) {
    for (const key of Object.keys(index.key ?? {})) {
      indexedPaths.add(key);
    }
  }

  const highCardinality = fields.filter(
    (f) =>
      f.probability > 0.9 &&
      f.types.some((t) => t.unique !== undefined && t.unique > 20) &&
      !indexedPaths.has(f.path) &&
      f.path !== '_id'
  );

  for (const field of highCardinality.slice(0, 5)) {
    suggestions.push(
      `Field "${field.path}" is present in ${Math.round(field.probability * 100)}% of documents and looks high-cardinality but is not indexed. Consider creating an index if you query on it.`
    );
  }

  const multiType = fields.filter((f) => f.types.length > 1);
  for (const field of multiType.slice(0, 5)) {
    suggestions.push(
      `Field "${field.path}" has ${field.types.length} different types (${field.types
        .map((t) => t.name)
        .join(', ')}). Mixed types make queries and indexes less predictable.`
    );
  }

  const largeArrays = fields.filter((f) => f.types.some((t) => t.name === 'Array' && (t.count ?? 0) > 0));
  if (largeArrays.length > 3) {
    suggestions.push(
      `${largeArrays.length} array fields detected. Watch out for unbounded array growth (16 MB document limit).`
    );
  }

  return suggestions;
}

// ───────────────────────────── type helpers ─────────────────────────────

export function bsonTypeName(value: unknown): string {
  if (value === null) {
    return 'Null';
  }
  if (value === undefined) {
    return 'Undefined';
  }
  if (value instanceof ObjectId) {
    return 'ObjectId';
  }
  if (value instanceof Long) {
    return 'Int64';
  }
  if (value instanceof Int32) {
    return 'Int32';
  }
  if (value instanceof Double) {
    return 'Double';
  }
  if (value instanceof Decimal128) {
    return 'Decimal128';
  }
  if (value instanceof Binary) {
    return value.sub_type === Binary.SUBTYPE_UUID ? 'UUID' : 'Binary';
  }
  if (value instanceof UUID) {
    return 'UUID';
  }
  if (isBinaryLike(value)) {
    // A de-serialised BSON Binary (e.g. `{ sub_type, buffer, position }`).
    return 'Binary';
  }
  if (value instanceof Timestamp) {
    return 'Timestamp';
  }
  if (value instanceof DBRef) {
    return 'DBRef';
  }
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    // Byte arrays (e.g. raw `_id` from other drivers, ThumbnailPhoto payloads)
    // must be treated as an opaque binary value, never as a nested document.
    return 'Binary';
  }
  if (value instanceof Code) {
    return 'JavaScript';
  }
  if (value instanceof MinKey) {
    return 'MinKey';
  }
  if (value instanceof MaxKey) {
    return 'MaxKey';
  }
  if (value instanceof Date) {
    return 'Date';
  }
  if (value instanceof RegExp) {
    return 'RegularExpression';
  }
  if (Array.isArray(value)) {
    return 'Array';
  }
  switch (typeof value) {
    case 'string':
      return 'String';
    case 'boolean':
      return 'Boolean';
    case 'number':
      return Number.isInteger(value) ? 'Int32' : 'Double';
    case 'bigint':
      return 'Int64';
    case 'object':
      return 'Document';
    default:
      return 'Unknown';
  }
}

function isNumericType(name: string): boolean {
  return name === 'Int32' || name === 'Int64' || name === 'Double' || name === 'Decimal128';
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return value;
  }
  if (value instanceof Long) {
    return value.toNumber();
  }
  if (value instanceof Int32 || value instanceof Double) {
    return value.valueOf();
  }
  if (value instanceof Decimal128) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A raw byte buffer in any of the shapes it can arrive in. */
function isByteBuffer(value: unknown): boolean {
  if (Buffer.isBuffer(value)) {
    return true;
  }
  if (ArrayBuffer.isView(value)) {
    return true;
  }
  if (value instanceof ArrayBuffer) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'number');
  }
  if (isPlainObject(value)) {
    return isNumericIndexedObject(value);
  }
  return false;
}

/** A BSON Binary instance, detected by shape rather than `instanceof` (the
 * bundle can contain two copies of bson, one from the driver and one direct). */
function isBinaryInstance(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.sub_type === 'number' && 'buffer' in obj && isByteBuffer(obj.buffer);
}

/** Detect a Binary in any of the shapes produced by drivers/serialisation:
 *  - canonical `{ sub_type, buffer, position }`
 *  - a wrapper object whose only key is `buffer`, holding bytes or a Binary
 *    (e.g. `_id` = `{ buffer: Binary }` returned by some drivers). */
function isBinaryLike(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  if (isBinaryInstance(value)) {
    return true;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && 'buffer' in obj) {
    const buffer = obj.buffer;
    if (isByteBuffer(buffer) || isBinaryInstance(buffer)) {
      return true;
    }
  }
  return false;
}

/** True when the value looks like a `{ "0": …, "1": …, … }` byte buffer. */
function isNumericIndexedObject(value: unknown): boolean {
  if (!isPlainObject(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) {
    return false;
  }
  return keys.every((key) => /^\d+$/.test(key));
}

function serialiseValue(value: unknown): string {
  try {
    if (value instanceof ObjectId) {
      return `ObjectId(${value.toHexString()})`;
    }
    if (value instanceof Date) {
      return `Date(${value.toISOString()})`;
    }
    if (value instanceof Long || value instanceof Int32 || value instanceof Double) {
      return `${bsonTypeName(value)}(${value.toString()})`;
    }
    if (value instanceof Decimal128) {
      return `Decimal128(${value.toString()})`;
    }
    if (value instanceof Binary) {
      return `Binary(${value.toString('base64')})`;
    }
    if (Buffer.isBuffer(value)) {
      return `Binary(${value.toString('base64')})`;
    }
    if (ArrayBuffer.isView(value)) {
      return `Binary(${Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64')})`;
    }
    if (value instanceof ArrayBuffer) {
      return `Binary(${Buffer.from(value).toString('base64')})`;
    }
    if (isBinaryLike(value)) {
      const obj = value as Record<string, unknown>;
      const buf = Buffer.isBuffer(obj.buffer)
        ? obj.buffer
        : ArrayBuffer.isView(obj.buffer)
          ? Buffer.from((obj.buffer as ArrayBufferView).buffer, (obj.buffer as ArrayBufferView).byteOffset, (obj.buffer as ArrayBufferView).byteLength)
          : obj.buffer instanceof ArrayBuffer
            ? Buffer.from(obj.buffer)
            : Array.isArray(obj.buffer)
              ? Buffer.from(obj.buffer as number[])
              : isNumericIndexedObject(obj.buffer)
                ? Buffer.from(Object.values(obj.buffer as Record<string, unknown>) as number[])
                : undefined;
      return buf ? `Binary(${buf.toString('base64')})` : 'Binary';
    }
    if (isPlainObject(value) || Array.isArray(value)) {
      return JSON.stringify(value);
    }
    return `${typeof value}:${String(value)}`;
  } catch {
    return `unserialisable:${Math.random()}`;
  }
}

function deserialiseValue(serialised: string): unknown {
  const objectIdMatch = /^ObjectId\((.*)\)$/.exec(serialised);
  if (objectIdMatch) {
    return { $oid: objectIdMatch[1] };
  }
  const dateMatch = /^Date\((.*)\)$/.exec(serialised);
  if (dateMatch) {
    return { $date: dateMatch[1] };
  }
  if (serialised.startsWith('{') || serialised.startsWith('[')) {
    try {
      return JSON.parse(serialised);
    } catch {
      return serialised;
    }
  }
  const primitiveMatch = /^[a-z]+:(.*)$/.exec(serialised);
  if (primitiveMatch) {
    return primitiveMatch[1];
  }
  return serialised;
}

function ratio(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return round(part / total, 4);
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
