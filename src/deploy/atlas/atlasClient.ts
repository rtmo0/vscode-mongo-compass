import * as crypto from 'crypto';
import { logger } from '../../core/logger';

export type AtlasCredentials =
  | { kind: 'serviceAccount'; clientId: string; clientSecret: string }
  | { kind: 'apiKey'; publicKey: string; privateKey: string };

export const ATLAS_BASE_URL = 'https://cloud.mongodb.com';

/** Versions to try, newest first; Atlas answers 406 to a version an endpoint does not serve. */
export const VERSIONS = {
  clusters: ['2024-10-23', '2024-08-05', '2023-02-01'],
  flex: ['2024-11-13'],
  legacy: ['2023-01-01', '2023-02-01'],
  restart: ['2023-02-01', '2023-01-01'],
  logs: ['2023-02-01', '2023-01-01']
};

export class AtlasApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string
  ) {
    super(message);
  }
}

interface RequestOptions {
  versions: string[];
  body?: unknown;
  /** `gzip` returns the raw bytes (log downloads). */
  accept?: 'json' | 'gzip';
}

/**
 * Minimal client for the Atlas Administration API v2.
 *
 * Service accounts (recommended) use the OAuth client-credentials flow; API
 * keys use HTTP digest authentication, implemented here so the extension
 * needs no extra dependency.
 */
export class AtlasClient {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly credentials: AtlasCredentials,
    private readonly baseUrl = ATLAS_BASE_URL
  ) {}

  get<T>(path: string, versions: string[]): Promise<T> {
    return this.request<T>('GET', path, { versions });
  }

  post<T>(path: string, body: unknown, versions: string[]): Promise<T> {
    return this.request<T>('POST', path, { versions, body });
  }

  patch<T>(path: string, body: unknown, versions: string[]): Promise<T> {
    return this.request<T>('PATCH', path, { versions, body });
  }

  delete<T>(path: string, versions: string[]): Promise<T> {
    return this.request<T>('DELETE', path, { versions });
  }

  async download(path: string, versions: string[]): Promise<Buffer> {
    return this.request<Buffer>('GET', path, { versions, accept: 'gzip' });
  }

  /** Every page of a paginated list endpoint. */
  async list<T>(path: string, versions: string[]): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; page < 50; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.get<{ results?: T[]; totalCount?: number }>(`${path}${separator}itemsPerPage=500&pageNum=${page}`, versions);
      results.push(...(response.results ?? []));
      if (!response.results?.length || results.length >= (response.totalCount ?? results.length)) {
        break;
      }
    }
    return results;
  }

  private async request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    let lastError: Error | undefined;
    for (const version of options.versions) {
      try {
        return await this.send<T>(method, path, version, options);
      } catch (err) {
        lastError = err as Error;
        if (!(err instanceof AtlasApiError) || (err.status !== 406 && err.errorCode !== 'INVALID_VERSION_DATE' && err.errorCode !== 'UNSUPPORTED_VERSION')) {
          throw err;
        }
      }
    }
    throw lastError ?? new Error('No API version accepted');
  }

  private async send<T>(method: string, path: string, version: string, options: RequestOptions): Promise<T> {
    const url = `${this.baseUrl}/api/atlas/v2${path}`;
    const accept = `application/vnd.atlas.${version}+${options.accept === 'gzip' ? 'gzip' : 'json'}`;
    const headers: Record<string, string> = { Accept: accept };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) {
      headers['Content-Type'] = `application/vnd.atlas.${version}+json`;
    }

    let response: Response;
    if (this.credentials.kind === 'serviceAccount') {
      headers.Authorization = `Bearer ${await this.accessToken()}`;
      response = await fetch(url, { method, headers, body });
    } else {
      response = await fetch(url, { method, headers, body });
      if (response.status === 401) {
        const challenge = response.headers.get('www-authenticate') ?? '';
        headers.Authorization = this.digestHeader(challenge, method, new URL(url).pathname + new URL(url).search);
        response = await fetch(url, { method, headers, body });
      }
    }

    if (!response.ok) {
      const text = await response.text();
      let detail = text;
      let errorCode: string | undefined;
      try {
        const parsed = JSON.parse(text) as { detail?: string; errorCode?: string; reason?: string };
        detail = parsed.detail ?? parsed.reason ?? text;
        errorCode = parsed.errorCode;
      } catch {
        // not JSON
      }
      logger.warn('Atlas API error', { method, path, status: response.status, errorCode });
      throw new AtlasApiError(`Atlas API ${method} ${path} failed (${response.status}${errorCode ? ` ${errorCode}` : ''}): ${detail}`, response.status, errorCode);
    }
    if (options.accept === 'gzip') {
      return Buffer.from(await response.arrayBuffer()) as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) {
      return this.token.value;
    }
    const creds = this.credentials as Extract<AtlasCredentials, { kind: 'serviceAccount' }>;
    const response = await fetch(`${this.baseUrl}/api/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json'
      },
      body: 'grant_type=client_credentials'
    });
    if (!response.ok) {
      throw new AtlasApiError(`Atlas sign-in failed (${response.status}): ${await response.text()}`, response.status);
    }
    const token = (await response.json()) as { access_token: string; expires_in?: number };
    this.token = { value: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000 };
    return token.access_token;
  }

  /** RFC 7616 digest response (MD5, qop=auth), as Atlas API keys require. */
  private digestHeader(challenge: string, method: string, uri: string): string {
    const creds = this.credentials as Extract<AtlasCredentials, { kind: 'apiKey' }>;
    const params = new Map<string, string>();
    for (const match of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) {
      params.set(match[1].toLowerCase(), match[2] ?? match[3]);
    }
    const realm = params.get('realm') ?? '';
    const nonce = params.get('nonce') ?? '';
    const qop = (params.get('qop') ?? 'auth').split(',')[0].trim();
    const md5 = (value: string): string => crypto.createHash('md5').update(value).digest('hex');
    const cnonce = crypto.randomBytes(8).toString('hex');
    const nc = '00000001';
    const ha1 = md5(`${creds.publicKey}:${realm}:${creds.privateKey}`);
    const ha2 = md5(`${method}:${uri}`);
    const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    return `Digest username="${creds.publicKey}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}", algorithm=MD5`;
  }
}
