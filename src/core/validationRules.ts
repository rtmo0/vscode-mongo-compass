import type { SchemaField, SchemaType } from './types';

/**
 * Converts the flat field list produced by `analyzeDocuments` into a MongoDB
 * `$jsonSchema` document. Mirrors Compass' `internalToMongoDB` converter:
 * nested documents become `bsonType: "object"` with `properties`/`required`,
 * arrays of documents become `bsonType: "array"` with `items`, and fields
 * present in every sampled document become `required`.
 */

// Maps our `bsonTypeName` output to MongoDB JSON Schema bsonType names.
const BSON_TYPE_MAP: Record<string, string> = {
  String: 'string',
  Double: 'double',
  Int32: 'int',
  Int64: 'long',
  Decimal128: 'decimal',
  Boolean: 'bool',
  Date: 'date',
  ObjectId: 'objectId',
  Binary: 'binData',
  UUID: 'binData',
  Timestamp: 'timestamp',
  DBRef: 'dbPointer',
  JavaScript: 'javascript',
  MinKey: 'minKey',
  MaxKey: 'maxKey',
  RegularExpression: 'regex',
  Array: 'array',
  Document: 'object',
  Null: 'null'
};

interface SchemaTreeNode {
  name: string;
  /** Field data when this path exists as a standalone field. */
  field?: SchemaField;
  children: Map<string, SchemaTreeNode>;
}

export function convertFieldsToJsonSchema(fields: SchemaField[]): Record<string, unknown> {
  const root = new Map<string, SchemaTreeNode>();

  for (const field of fields) {
    const parts = field.path.split('.');
    let level = root;
    let fullPath = '';
    for (let i = 0; i < parts.length; i += 1) {
      const segment = parts[i];
      fullPath = fullPath ? `${fullPath}.${segment}` : segment;
      let node = level.get(segment);
      if (!node) {
        node = { name: segment, children: new Map() };
        level.set(segment, node);
      }
      // The flat list contains an entry for every path, so the leaf entry for
      // this exact path carries the type information.
      if (fullPath === field.path) {
        node.field = field;
      }
      level = node.children;
    }
  }

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, node] of root) {
    properties[name] = nodeToSchema(node);
    // Root fields present in 100% of documents are required (Compass behaviour).
    if ((node.field?.probability ?? 0) >= 1) {
      required.push(name);
    }
  }

  const schema: Record<string, unknown> = {
    bsonType: 'object',
    properties
  };
  if (required.length > 0) {
    schema.required = required;
  }
  return schema;
}

function nodeToSchema(node: SchemaTreeNode): Record<string, unknown> {
  if (node.children.size === 0) {
    // Leaf: describe it by its observed types.
    return typesToSchema(node.field?.types ?? []);
  }

  // A node with children is a container. Determine whether it is an array of
  // documents or a nested document from the field's own observed types.
  const observed = node.field?.types ?? [];
  const isArray = observed.some((t) => t.name === 'Array');
  const childSchema = buildObjectSchema(node.children);

  if (isArray) {
    const items: Record<string, unknown> = {
      properties: childSchema.properties
    };
    if (childSchema.required.length > 0) {
      items.required = childSchema.required;
    }
    return {
      bsonType: 'array',
      items
    };
  }

  // Nested document.
  const result: Record<string, unknown> = {
    bsonType: 'object',
    properties: childSchema.properties
  };
  if (childSchema.required.length > 0) {
    result.required = childSchema.required;
  }
  return result;
}

function buildObjectSchema(
  children: Map<string, SchemaTreeNode>
): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, child] of children) {
    properties[name] = nodeToSchema(child);
    if ((child.field?.probability ?? 0) >= 1) {
      required.push(name);
    }
  }
  return { properties, required };
}

function typesToSchema(types: SchemaType[]): Record<string, unknown> {
  // Ignore "Undefined" and "Null" only when other types exist — they are
  // implied. But keep "Null" as a standalone type when it's the only one.
  const meaningful = types.filter((t) => t.name !== 'Undefined');
  const defined = meaningful.filter((t) => t.name !== 'Null');
  const source = defined.length > 0 ? defined : meaningful;

  if (source.length === 0) {
    return { bsonType: 'object' };
  }

  if (source.length === 1) {
    const type = source[0];
    const mapped = mapType(type.name);
    if (type.name === 'Array') {
      // Arrays of primitives (or unknown items) — no item schema available in
      // the flat representation, so emit a plain array type.
      return { bsonType: mapped };
    }
    if (type.name === 'Document') {
      return { bsonType: mapped };
    }
    return { bsonType: mapped };
  }

  // Multiple types: produce a bsonType array (valid JSON Schema union).
  const mapped = source.map((t) => mapType(t.name)).filter(Boolean);
  if (mapped.length === 0) {
    return { bsonType: 'object' };
  }
  return { bsonType: mapped };
}

function mapType(name: string): string {
  return BSON_TYPE_MAP[name] ?? 'string';
}
