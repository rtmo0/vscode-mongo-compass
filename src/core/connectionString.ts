import { ConnectionString } from 'mongodb-connection-string-url';

/**
 * Helpers around MongoDB connection strings.
 *
 * The WHATWG `URL` parser rejects valid MongoDB seed-list URIs such as
 *   mongodb://user:pass@host1:27017,host2:27017,host3:27017/db?authSource=admin
 * because commas are not allowed in a URL host. The driver's own parser
 * (`mongodb-connection-string-url`) handles them correctly, so we use it
 * everywhere instead of `new URL()`.
 */

export interface ParsedConnectionString {
  /** All hosts in the seed list. */
  hosts: string[];
  /** First host (used for display). */
  host: string;
  /** Database from the path (without the leading slash). */
  database: string;
  username?: string;
  hasPassword: boolean;
  isSrv: boolean;
  /** Query options as a plain object. */
  options: Record<string, string>;
}

/** Parse a connection string. Throws on a genuinely malformed URI. */
export function parseConnectionString(uri: string): ParsedConnectionString {
  const cs = new ConnectionString(uri.trim());
  const hosts = cs.hosts.length > 0 ? cs.hosts : ['localhost:27017'];
  const options: Record<string, string> = {};
  for (const [key, value] of cs.searchParams.entries()) {
    options[key] = value;
  }
  return {
    hosts,
    host: hosts[0],
    database: (cs.pathname ?? '').replace(/^\//, ''),
    username: cs.username || undefined,
    hasPassword: Boolean(cs.password),
    isSrv: uri.trim().startsWith('mongodb+srv://'),
    options
  };
}

/** Validate a connection string. Returns an error message or `null` when valid. */
export function validateConnectionString(uri: string): string | null {
  const trimmed = (uri ?? '').trim();
  if (!trimmed) {
    return 'Connection string is required';
  }
  if (!/^mongodb(\+srv)?:\/\//i.test(trimmed)) {
    return 'Connection string must start with mongodb:// or mongodb+srv://';
  }
  try {
    // The driver parser accepts seed lists, SRV records and all auth options.
    // A username without a password is allowed (prompted at connect time).
    new ConnectionString(trimmed);
  } catch (err) {
    return `Connection string is not valid: ${(err as Error).message}`;
  }
  return null;
}

/** A short, human-readable host summary (handles multi-host seed lists). */
export function hostSummary(uri: string): string {
  try {
    const parsed = parseConnectionString(uri);
    if (parsed.hosts.length === 1) {
      return parsed.host;
    }
    return `${parsed.host} (+${parsed.hosts.length - 1} more)`;
  } catch {
    const match = /@([^/?]+)/.exec(uri);
    return match ? match[1] : uri.slice(0, 40);
  }
}

/** A friendly default name derived from the connection string. */
export function deriveConnectionName(uri: string): string {
  try {
    const parsed = parseConnectionString(uri);
    const base = parsed.host.split(':')[0];
    // Use the first DNS label cluster as a readable name.
    return base || 'Connection';
  } catch {
    return 'Connection';
  }
}

/** Replace the password (if any) with bullets, preserving multi-host lists. */
export function redactConnectionString(uri: string): string {
  try {
    const cs = new ConnectionString(uri.trim());
    if (cs.password) {
      cs.password = '••••••';
    }
    return cs.toString();
  } catch {
    // Fallback regex redaction for anything the parser rejects.
    return uri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:••••••@');
  }
}

/** Return the connection string with its path set to the selected database. */
export function connectionStringForDatabase(uri: string, database: string): string {
  const cs = new ConnectionString(uri.trim());
  cs.pathname = `/${encodeURIComponent(database)}`;
  return cs.toString();
}
