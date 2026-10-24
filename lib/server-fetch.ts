import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { getApiUrl } from './api-config';

export const SERVER_RENDER_FETCH_TIMEOUT_MS = 1_000;
export const SERVER_RENDER_BUILD_FETCH_TIMEOUT_MS = 10_000;
/** Local dev often hits a remote API; keep SSR from failing on ~1.5s round trips. */
export const SERVER_RENDER_DEV_FETCH_TIMEOUT_MS = 5_000;

/**
 * Builds need enough time to create the first valid ISR entry from a healthy
 * cross-service API. Runtime requests keep the tighter tail-latency guard.
 * Development uses a longer budget because localhost → remote API is slower
 * than colocated production traffic.
 */
export function getServerRenderFetchTimeoutMs(): number {
  if (process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD) {
    return SERVER_RENDER_BUILD_FETCH_TIMEOUT_MS;
  }
  if (process.env.NODE_ENV === 'development') {
    return SERVER_RENDER_DEV_FETCH_TIMEOUT_MS;
  }
  return SERVER_RENDER_FETCH_TIMEOUT_MS;
}

export type NextFetchRequestInit = RequestInit & {
  next?: {
    revalidate?: number | false;
    tags?: string[];
  };
};

type FetchImplementation = (
  input: RequestInfo | URL,
  init?: NextFetchRequestInit,
) => Promise<Response>;

export function isServerRenderDeadlineError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

const SERVICE_API_KEY = process.env.SERVICE_API_KEY || '';

function getHttpOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch { return null; }
}

/** Limit the service credential to this deployment's configured API origin. */
function withServiceHeaders(inputUrl: string, requestHeaders: Headers | undefined, init: NextFetchRequestInit): NextFetchRequestInit {
  // RequestInit headers replace Request headers; otherwise retain the caller's
  // native Request headers without mutating either input collection.
  const headers = new Headers(init.headers === undefined ? requestHeaders : init.headers);
  let trusted = false;
  try {
    const apiOrigin = getHttpOrigin(getApiUrl());
    trusted = apiOrigin !== null && getHttpOrigin(inputUrl) === apiOrigin;
  } catch { trusted = false; }

  if (!trusted) headers.delete('x-service-key');
  else if (SERVICE_API_KEY && !headers.has('x-service-key')) headers.set('x-service-key', SERVICE_API_KEY);

  // Custom headers can survive cross-origin redirects in server fetch. Refuse
  // redirects whenever a service credential is present, including caller keys.
  return { ...init, headers, ...(headers.has('x-service-key') ? { redirect: 'error' as const } : {}) };
}

/**
 * Bound upstream work that is allowed to delay server-rendered HTML.
 *
 * Callers either return an unavailable state or throw an availability error,
 * so a slow API cannot hold the page response open until the platform timeout.
 *
 * Only the configured API origin receives the service-key header used by ISR
 * revalidation. Other origins have any caller-provided service key removed.
 */
export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: NextFetchRequestInit = {},
  timeoutMs = getServerRenderFetchTimeoutMs(),
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  // Snapshot URL inputs before checking and dispatching. Read native Request
  // properties so an own `url`/`headers` property cannot spoof its destination.
  const request = input instanceof Request ? input : undefined;
  const fetchInput = request ?? String(input);
  const inputUrl = request ? Reflect.get(Request.prototype, 'url', request) as string : fetchInput as string;
  const requestHeaders = request ? Reflect.get(Request.prototype, 'headers', request) as Headers : undefined;
  const mergedInit = withServiceHeaders(inputUrl, requestHeaders, init);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Server-render fetch deadline exceeded', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  const abortFromCaller = () => controller.abort(mergedInit.signal?.reason);

  if (mergedInit.signal?.aborted) abortFromCaller();
  else mergedInit.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    return await fetchImpl(fetchInput, { ...mergedInit, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    mergedInit.signal?.removeEventListener('abort', abortFromCaller);
  }
}
