import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { EJSON, ObjectId, Double, Int32, Long, Decimal128, Binary, type Document } from 'bson';
import type { DataService } from './dataService';
import { Namespace } from './dataService';
import { getConfig } from './config';
import { logger } from './logger';

export type ExportFormat = 'json' | 'jsonl' | 'csv';
export type ImportFormat = 'json' | 'jsonl' | 'csv';

export interface ExportOptions {
  format: ExportFormat;
  /** Restrict exported documents with a filter. */
  filter?: Document;
  /** Flatten nested documents into `a.b.c` columns (CSV only). */
  flatten?: boolean;
  /** Explicit field list; empty = all fields. */
  fields?: string[];
  /** Export as relaxed EJSON (plain JSON types) instead of canonical. */
  relaxed?: boolean;
  batchSize?: number;
}

export interface ImportOptions {
  format: ImportFormat;
  /** Insert or upsert on `_id`. */
  mode: 'insert' | 'upsert';
  /** Stop on the first malformed row. */
  stopOnError: boolean;
  /** Treat CSV header row as field names. */
  headerRow?: boolean;
  delimiter?: string;
  /** Parse CSV values that look like numbers/booleans/dates. */
  inferTypes?: boolean;
  batchSize?: number;
}

export interface TransferProgress {
  processed: number;
  total: number | null;
}

/**
 * Import/Export feature — the equivalent of Compass' `compass-import-export`
 * package. Supports JSON, JSON Lines and CSV in both directions.
 */
export class ImportExportService {
  constructor(private readonly dataService: DataService) {}

  // ───────────────────────────── export ─────────────────────────────

  async exportCollection(
    ns: Namespace,
    targetFile: string,
    options: ExportOptions,
    onProgress?: (progress: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<{ exported: number; file: string }> {
    const config = getConfig();
    const batchSize = options.batchSize ?? config.exportBatchSize;
    const collection = this.dataService.collection(ns);

    const total = await collection
      .countDocuments(options.filter ?? {})
      .catch(() => null);

    const cursor = collection.find(options.filter ?? {}).batchSize(batchSize);

    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });

    let exported = 0;
    const writeStream = fs.createWriteStream(targetFile, { encoding: 'utf8' });

    try {
      if (options.format === 'csv') {
        exported = await this.exportCsv(cursor, writeStream, options, total, onProgress, token);
      } else if (options.format === 'jsonl') {
        exported = await this.exportJsonLines(cursor, writeStream, options, total, onProgress, token);
      } else {
        exported = await this.exportJson(cursor, writeStream, options, total, onProgress, token);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        writeStream.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }

    logger.info('Export finished', { ns: ns.toString(), exported, file: targetFile });
    return { exported, file: targetFile };
  }

  private async exportJson(
    cursor: AsyncIterable<Document>,
    stream: fs.WriteStream,
    options: ExportOptions,
    total: number | null,
    onProgress?: (p: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    stream.write('[\n');
    let count = 0;
    for await (const doc of cursor) {
      if (token?.isCancellationRequested) {
        break;
      }
      const projected = projectDocument(doc, options);
      const text = EJSON.stringify(projected, undefined, 2, { relaxed: options.relaxed ?? true });
      stream.write(count === 0 ? text : `,\n${text}`);
      count += 1;
      onProgress?.({ processed: count, total });
    }
    stream.write('\n]\n');
    return count;
  }

  private async exportJsonLines(
    cursor: AsyncIterable<Document>,
    stream: fs.WriteStream,
    options: ExportOptions,
    total: number | null,
    onProgress?: (p: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    let count = 0;
    for await (const doc of cursor) {
      if (token?.isCancellationRequested) {
        break;
      }
      const projected = projectDocument(doc, options);
      stream.write(`${EJSON.stringify(projected, { relaxed: options.relaxed ?? true })}\n`);
      count += 1;
      onProgress?.({ processed: count, total });
    }
    return count;
  }

  private async exportCsv(
    cursor: AsyncIterable<Document>,
    stream: fs.WriteStream,
    options: ExportOptions,
    total: number | null,
    onProgress?: (p: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    const flatten = options.flatten ?? true;
    let headers: string[] | undefined = options.fields?.length ? [...options.fields] : undefined;
    let count = 0;
    const buffered: Document[] = [];

    // First pass: discover headers when not explicitly provided.
    for await (const doc of cursor) {
      if (token?.isCancellationRequested) {
        break;
      }
      const projected = projectDocument(doc, options);
      const flat = flatten ? flattenDocument(projected) : projected;
      if (!headers) {
        headers = Object.keys(flat);
      } else {
        for (const key of Object.keys(flat)) {
          if (!headers.includes(key)) {
            headers.push(key);
          }
        }
      }
      buffered.push(flat);
      count += 1;
      onProgress?.({ processed: count, total });
    }

    if (!headers || buffered.length === 0) {
      return 0;
    }

    stream.write(`${headers.map(csvEscape).join(',')}\n`);
    for (const row of buffered) {
      const line = headers.map((h) => csvEscape(formatCsvValue(row[h]))).join(',');
      stream.write(`${line}\n`);
    }
    return buffered.length;
  }

  // ───────────────────────────── import ─────────────────────────────

  async importFile(
    ns: Namespace,
    sourceFile: string,
    options: ImportOptions,
    onProgress?: (p: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<{ imported: number; errors: string[] }> {
    const config = getConfig();
    const batchSize = options.batchSize ?? config.exportBatchSize;
    const content = await fs.promises.readFile(sourceFile, 'utf8');

    let documents: Document[];
    const errors: string[] = [];

    if (options.format === 'csv') {
      const parsed = parseCsv(content, {
        delimiter: options.delimiter ?? ',',
        headerRow: options.headerRow ?? true,
        inferTypes: options.inferTypes ?? true
      });
      documents = parsed.rows;
      errors.push(...parsed.errors);
    } else if (options.format === 'jsonl') {
      documents = [];
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i].trim();
        if (!line) {
          continue;
        }
        try {
          documents.push(EJSON.parse(line, { relaxed: false }) as Document);
        } catch (err) {
          errors.push(`Line ${i + 1}: ${(err as Error).message}`);
          if (options.stopOnError) {
            break;
          }
        }
      }
    } else {
      try {
        const parsed = EJSON.parse(content, { relaxed: false });
        documents = Array.isArray(parsed) ? (parsed as Document[]) : [parsed as Document];
      } catch (err) {
        throw new Error(`Could not parse JSON file: ${(err as Error).message}`);
      }
    }

    const total = documents.length;
    let imported = 0;
    const collection = this.dataService.collection(ns);

    for (let i = 0; i < documents.length; i += batchSize) {
      if (token?.isCancellationRequested) {
        break;
      }
      const batch = documents.slice(i, i + batchSize);
      const operations = batch.map((doc) => {
        if (options.mode === 'upsert' && doc._id !== undefined) {
          return {
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: doc },
              upsert: true
            }
          };
        }
        return { insertOne: { document: doc } };
      });

      try {
        const result = await collection.bulkWrite(operations as never, { ordered: options.stopOnError });
        imported +=
          (result.insertedCount ?? 0) +
          (result.upsertedCount ?? 0) +
          (result.modifiedCount ?? 0);
      } catch (err) {
        errors.push(`Batch ${Math.floor(i / batchSize) + 1}: ${(err as Error).message}`);
        if (options.stopOnError) {
          break;
        }
      }
      onProgress?.({ processed: Math.min(i + batchSize, total), total });
    }

    logger.info('Import finished', { ns: ns.toString(), imported, errors: errors.length });
    return { imported, errors };
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function projectDocument(doc: Document, options: ExportOptions): Document {
  if (!options.fields?.length) {
    return doc;
  }
  const result: Document = {};
  for (const field of options.fields) {
    const value = getNestedValue(doc, field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

function getNestedValue(doc: Document, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = doc;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Document)[part];
  }
  return current;
}

function flattenDocument(doc: Document, prefix = ''): Document {
  const result: Document = {};
  for (const [key, value] of Object.entries(doc)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !isBsonValue(value)) {
      Object.assign(result, flattenDocument(value as Document, fullKey));
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

function isBsonValue(value: unknown): boolean {
  return (
    value instanceof ObjectId ||
    value instanceof Double ||
    value instanceof Int32 ||
    value instanceof Long ||
    value instanceof Decimal128 ||
    value instanceof Binary ||
    value instanceof Date
  );
}

function formatCsvValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  if (isBsonValue(value)) {
    return String(value);
  }
  if (typeof value === 'object') {
    return EJSON.stringify(value, { relaxed: true });
  }
  return String(value);
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

interface CsvParseResult {
  rows: Document[];
  errors: string[];
}

function parseCsv(
  content: string,
  options: { delimiter: string; headerRow: boolean; inferTypes: boolean }
): CsvParseResult {
  const rows: Document[] = [];
  const errors: string[] = [];
  const records = splitCsvRecords(content, options.delimiter);
  if (records.length === 0) {
    return { rows, errors };
  }

  let headers: string[];
  let dataStart = 0;
  if (options.headerRow) {
    headers = records[0];
    dataStart = 1;
  } else {
    headers = records[0].map((_, i) => `field${i + 1}`);
  }

  for (let r = dataStart; r < records.length; r += 1) {
    const record = records[r];
    if (record.length === 1 && record[0].trim() === '') {
      continue;
    }
    const doc: Document = {};
    for (let c = 0; c < headers.length; c += 1) {
      const raw = record[c] ?? '';
      doc[headers[c]] = options.inferTypes ? inferCsvValue(raw) : raw;
    }
    rows.push(doc);
  }

  return { rows, errors };
}

function splitCsvRecords(content: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];
    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === delimiter) {
      current.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (char === '\n') {
      current.push(field);
      records.push(current);
      current = [];
      field = '';
      i += 1;
      continue;
    }
    if (char === '\r') {
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }

  if (field.length > 0 || current.length > 0) {
    current.push(field);
    records.push(current);
  }
  return records;
}

function inferCsvValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return null;
  }
  if (trimmed === 'true') {
    return true;
  }
  if (trimmed === 'false') {
    return false;
  }
  if (trimmed === 'null') {
    return null;
  }
  // ObjectId hex
  if (/^[0-9a-fA-F]{24}$/.test(trimmed)) {
    return new ObjectId(trimmed);
  }
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!Number.isNaN(date.getTime())) {
      return date;
    }
  }
  // Number
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isSafeInteger(num)) {
      return num;
    }
  }
  if (/^-?\d*\.\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Embedded JSON
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return EJSON.parse(trimmed, { relaxed: true });
    } catch {
      return raw;
    }
  }
  return raw;
}
