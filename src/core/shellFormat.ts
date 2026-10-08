import {
  Binary,
  BSONRegExp,
  Code,
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

/**
 * Format a BSON value as mongosh-style source that `parseShellBSON` reads
 * back to the same types: `ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`,
 * unquoted identifier keys, short objects on one line.
 */
export function toShellSyntax(value: unknown, indent = 0, width = 72): string {
  const inline = formatValue(value, null, 0);
  if (inline.length + indent <= width) {
    return inline;
  }
  return formatValue(value, '  ', indent);
}

function formatValue(value: unknown, unit: string | null, depth: number): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : `Double(${String(value)})`;
  }
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'bigint') {
    return `NumberLong("${value.toString()}")`;
  }
  const scalar = formatBsonScalar(value);
  if (scalar !== null) {
    return scalar;
  }
  if (Array.isArray(value)) {
    return formatContainer('[', ']', value.map((item) => formatValue(item, unit, depth + 1)), unit, depth);
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => `${formatKey(key)}: ${formatValue(item, unit, depth + 1)}`
    );
    return formatContainer('{', '}', entries, unit, depth);
  }
  return String(value);
}

function formatContainer(open: string, close: string, items: string[], unit: string | null, depth: number): string {
  if (items.length === 0) {
    return `${open}${close}`;
  }
  const inline = open === '{' ? `{ ${items.join(', ')} }` : `[${items.join(', ')}]`;
  // Keep short, flat containers on one line even in multi-line mode.
  if (unit === null || (inline.length <= 60 && !inline.includes('\n'))) {
    return inline;
  }
  const pad = unit.repeat(depth + 1);
  return `${open}\n${items.map((item) => `${pad}${item}`).join(',\n')}\n${unit.repeat(depth)}${close}`;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function formatBsonScalar(value: unknown): string | null {
  if (value instanceof ObjectId) {
    return `ObjectId("${value.toHexString()}")`;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'ISODate("invalid")' : `ISODate("${value.toISOString()}")`;
  }
  if (value instanceof Int32) {
    return String(value.value);
  }
  if (value instanceof Double) {
    // Keep the Double type for integral values, which would otherwise be read back as Int32.
    return Number.isInteger(value.value) ? `Double(${value.value})` : String(value.value);
  }
  // Timestamp extends Long, so it must be checked first.
  if (value instanceof Timestamp) {
    return `Timestamp({ t: ${value.t}, i: ${value.i} })`;
  }
  if (value instanceof Long) {
    const text = value.toString();
    return Number.isSafeInteger(Number(text)) ? `NumberLong(${text})` : `NumberLong("${text}")`;
  }
  if (value instanceof Decimal128) {
    return `NumberDecimal("${value.toString()}")`;
  }
  if (value instanceof UUID) {
    return `UUID("${value.toHexString()}")`;
  }
  if (value instanceof Binary) {
    if (value.sub_type === Binary.SUBTYPE_UUID) {
      return `UUID("${value.toUUID().toHexString()}")`;
    }
    return `Binary.createFromBase64(${JSON.stringify(value.toString('base64'))}, ${value.sub_type})`;
  }
  if (value instanceof RegExp) {
    return `/${value.source}/${value.flags}`;
  }
  if (value instanceof BSONRegExp) {
    return `RegExp(${JSON.stringify(value.pattern)}, ${JSON.stringify(value.options)})`;
  }
  if (value instanceof MinKey) {
    return 'MinKey()';
  }
  if (value instanceof MaxKey) {
    return 'MaxKey()';
  }
  if (value instanceof Code) {
    return `new Code(${JSON.stringify(value.code)})`;
  }
  return null;
}
