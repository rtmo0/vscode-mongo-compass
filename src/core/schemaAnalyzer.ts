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
  const root = new FieldAccumulator('_id', '');

  for (const doc of documents) {
    root.visit(doc, total);
  }

  const fields = root.flatten(total);
  const suggestions = buildSuggestions(fields, indexes);
  return { fields, suggestions };
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
  private readonly arrayItems = new Map<string, TypeAccumulator>();
  private readonly objectFields = new Map<string, FieldAccumulator>();

  constructor(public readonly name: string) {}

  add(value: unknown): void {
    this.count += 1;
    const typeName = bsonTypeName(value);

    if (typeName === 'String') {
      const str = value as string;
      this.minLength = Math.min(this.minLength, str.length);
      this.maxLength = Math.max(this.maxLength, str.length);
      this.totalLength += str.length;
    }

    if (typeName === 'Int32' || typeName === 'Int64' || typeName === 'Double' || typeName === 'Decimal128') {
      const num = toNumber(value);
      if (num !== null) {
        this.min = Math.min(this.min, num);
        this.max = Math.max(this.max, num);
        this.totalNumber += num;
      }
    }

    if (typeName === 'Array' && Array.isArray(value)) {
      for (const item of value) {
        const itemName = bsonTypeName(item);
        let acc = this.arrayItems.get(itemName);
        if (!acc) {
          acc = new TypeAccumulator(itemName);
          this.arrayItems.set(itemName, acc);
        }
        acc.add(item);
      }
    }

    if (typeName === 'Document' && isPlainObject(value)) {
      for (const [key, child] of Object.entries(value as Document)) {
        let field = this.objectFields.get(key);
        if (!field) {
          field = new FieldAccumulator(key, key);
          this.objectFields.set(key, field);
        }
        field.addValue(child, this.count);
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

    if (this.arrayItems.size > 0) {
      result.arrayItems = [...this.arrayItems.values()]
        .map((acc) => acc.toSchemaType(this.count))
        .sort((a, b) => b.count - a.count);
    }

    if (this.objectFields.size > 0) {
      result.fields = [...this.objectFields.values()]
        .map((field) => field.toSchemaField(this.count))
        .sort((a, b) => a.name.localeCompare(b.name));
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

  visit(doc: Document, _total: number): void {
    for (const [key, value] of Object.entries(doc)) {
      this.addValue(value, 1, key);
    }
  }

  addValue(value: unknown, _docCount: number, key?: string): void {
    this.count += 1;
    const typeName = bsonTypeName(value);
    let acc = this.types.get(typeName);
    if (!acc) {
      acc = new TypeAccumulator(typeName);
      this.types.set(typeName, acc);
    }
    acc.add(value);

    // Recurse into embedded documents so nested paths appear in the tree.
    if (typeName === 'Document' && isPlainObject(value)) {
      for (const [childKey, childValue] of Object.entries(value as Document)) {
        const child = this.child(key ?? childKey, childKey);
        child.addValue(childValue, 1);
      }
    }
    if (typeName === 'Array' && Array.isArray(value)) {
      for (const item of value) {
        if (bsonTypeName(item) === 'Document' && isPlainObject(item)) {
          for (const [childKey, childValue] of Object.entries(item as Document)) {
            const child = this.child(key ?? childKey, childKey);
            child.addValue(childValue, 1);
          }
        }
      }
    }
  }

  private readonly children = new Map<string, FieldAccumulator>();

  private child(parentPath: string, key: string): FieldAccumulator {
    const path = parentPath ? `${parentPath}.${key}` : key;
    let child = this.children.get(path);
    if (!child) {
      child = new FieldAccumulator(key, path);
      this.children.set(path, child);
    }
    return child;
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

  flatten(total: number): SchemaField[] {
    const result: SchemaField[] = [];
    for (const [typeName, acc] of this.types) {
      // Root-level pseudo field per type is not useful; skip.
      void typeName;
      void acc;
    }
    for (const child of this.children.values()) {
      result.push(child.toSchemaField(total));
      result.push(...child.flatten(total));
    }
    return result;
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
  if (value instanceof Timestamp) {
    return 'Timestamp';
  }
  if (value instanceof DBRef) {
    return 'DBRef';
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
