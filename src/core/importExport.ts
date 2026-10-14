import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { once } from 'events';
import { EJSON, ObjectId, Double, Int32, Long, Decimal128, Binary, type Document } from 'bson';
import type { DataService } from './dataService';
import { Namespace } from './dataService';
import { getConfig } from './config';
import { logger } from './logger';

export type ExportFormat = 'json' | 'jsonl' | 'csv';

export interface ExportOptions {
  format: ExportFormat;
  /** Restrict exported documents with a filter. */
  filter?: Document;
  /** Export the results of an aggregation pipeline instead of a find query. */
  pipeline?: Document[];
  /** Flatten nested documents into `a.b.c` columns (CSV only). */
  flatten?: boolean;
  /** Explicit field list; empty = all fields. */
  fields?: string[];
  /**
   * Export as relaxed EJSON (plain JSON numbers) instead of canonical. Relaxed
   * output does not round-trip: Int64/Double types are lost and Int64 values
   * beyond 2^53 lose precision, so canonical is the default.
   */
  relaxed?: boolean;
  batchSize?: number;
}

export interface TransferProgress {
  processed: number;
  total: number | null;
}

/**
 * Export feature — the export half of Compass' `compass-import-export`
 * package. Writes JSON, JSON Lines and CSV. Imports go through mongorestore.
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

    const total = options.pipeline
      ? null
      : await collection.countDocuments(options.filter ?? {}).catch(() => null);

    // CSV writes plain values; JSON keeps the numeric BSON types (see `relaxed`).
    const cursorOptions = { promoteValues: options.format === 'csv' };
    const cursor = options.pipeline
      ? collection.aggregate(options.pipeline, cursorOptions).batchSize(batchSize)
      : collection.find(options.filter ?? {}, cursorOptions).batchSize(batchSize);

    await fs.promises.mkdir(path.dirname(targetFile), { recursive: true });

    let exported = 0;
    const writer = new FileWriter(targetFile);

    try {
      if (options.format === 'csv') {
        exported = await this.exportCsv(cursor, writer, options, total, onProgress, token);
      } else if (options.format === 'jsonl') {
        exported = await this.exportJsonLines(cursor, writer, options, total, onProgress, token);
      } else {
        exported = await this.exportJson(cursor, writer, options, total, onProgress, token);
      }
    } finally {
      await writer.close();
    }

    logger.info('Export finished', { ns: ns.toString(), exported, file: targetFile });
    return { exported, file: targetFile };
  }

  private async exportJson(
    cursor: AsyncIterable<Document>,
    writer: FileWriter,
    options: ExportOptions,
    total: number | null,
    onProgress?: (p: TransferProgress) => void,
    token?: vscode.CancellationToken
  ): Promise<number> {
    await writer.write('[\n');
    let count = 0;
    for await (const doc of cursor) {
      if (token?.isCancellationRequested) {
        break;
      }
      const projected = projectDocument(doc, options);
      const text = EJSON.stringify(projected, undefined, 2, { relaxed: options.relaxed ?? false });
      await writer.write(count === 0 ? text : `,\n${text}`);
      count += 1;
      onProgress?.({ processed: count, total });
    }
    await writer.write('\n]\n');
    return count;
  }

  private async exportJsonLines(
    cursor: AsyncIterable<Document>,
    writer: FileWriter,
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
      await writer.write(`${EJSON.stringify(projected, { relaxed: options.relaxed ?? false })}\n`);
      count += 1;
      onProgress?.({ processed: count, total });
    }
    return count;
  }

  private async exportCsv(
    cursor: AsyncIterable<Document>,
    writer: FileWriter,
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

    await writer.write(`${headers.map(csvEscape).join(',')}\n`);
    for (const row of buffered) {
      const line = headers.map((h) => csvEscape(formatCsvValue(row[h]))).join(',');
      await writer.write(`${line}\n`);
    }
    return buffered.length;
  }
}

/**
 * Appends text to a file, waiting for the disk whenever the stream's buffer
 * is full, so a cursor that is faster than the disk cannot fill up memory.
 */
class FileWriter {
  private readonly stream: fs.WriteStream;
  private error: Error | undefined;

  constructor(file: string) {
    this.stream = fs.createWriteStream(file, { encoding: 'utf8' });
    // Keep the error for the next write instead of crashing on an unhandled 'error' event.
    this.stream.on('error', (err) => {
      this.error = err;
    });
  }

  async write(chunk: string): Promise<void> {
    if (this.error) {
      throw this.error;
    }
    if (!this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.end((err?: Error | null) => {
        // The stream's own error explains a failure better than end()'s follow-up error.
        const failure = this.error ?? err;
        if (failure) {
          reject(failure);
        } else {
          resolve();
        }
      });
    });
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
