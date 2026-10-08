import type { Document } from 'bson';
import { bsonTypeName } from './schemaAnalyzer';

export interface FieldPathSample {
  /** Sorted field paths (dotted for nested documents). */
  fields: string[];
  /** BSON type names seen at each path. */
  fieldTypes: Record<string, string[]>;
  /** For array fields: BSON type names of their scalar (non-document) elements. */
  elementTypes: Record<string, string[]>;
}

/** Collect every field path of `docs` together with the BSON types seen at it. */
export function collectFieldPaths(docs: Document[]): FieldPathSample {
  const paths = new Map<string, Set<string>>();
  const elements = new Map<string, Set<string>>();
  for (const doc of docs) {
    collectPaths(doc, '', paths, elements);
  }
  return {
    fields: [...paths.keys()].sort(),
    fieldTypes: toSortedRecord(paths),
    elementTypes: toSortedRecord(elements)
  };
}

function toSortedRecord(map: Map<string, Set<string>>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [field, types] of map) {
    out[field] = [...types].sort();
  }
  return out;
}

function addType(map: Map<string, Set<string>>, path: string, type: string): void {
  let types = map.get(path);
  if (!types) {
    types = new Set();
    map.set(path, types);
  }
  types.add(type);
}

function collectPaths(
  doc: Document,
  prefix: string,
  out: Map<string, Set<string>>,
  elements: Map<string, Set<string>>
): void {
  for (const [key, value] of Object.entries(doc)) {
    const path = prefix ? `${prefix}.${key}` : key;
    // Descend only into real subdocuments and into documents stored inside
    // arrays. Byte arrays (Buffer / Uint8Array / Binary) stay opaque so they
    // are not expanded into `buffer.0`, `buffer.1`, … pseudo-fields.
    const type = bsonTypeName(value);
    addType(out, path, type);
    if (type === 'Document') {
      collectPaths(value as Document, path, out, elements);
    } else if (type === 'Array') {
      for (const item of value as unknown[]) {
        const itemType = bsonTypeName(item);
        if (itemType === 'Document') {
          collectPaths(item as Document, path, out, elements);
        } else {
          addType(elements, path, itemType);
        }
      }
    }
  }
}
