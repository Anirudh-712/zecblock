import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { readApiData } from '@/lib/api-client';

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

/** Merge the service-key header into the request so server-side fetches
 *  bypass the per-IP rate limiter on the API server. */
function withServiceHeaders(init: NextFetchRequestInit): NextFetchRequestInit {
  if (!SERVICE_API_KEY) return init;
  const headers = new Headers(init.headers);
  if (!headers.has('x-service-key')) headers.set('x-service-key', SERVICE_API_KEY);
  return { ...init, headers };
}

/**
 * Bound upstream work that is allowed to delay server-rendered HTML.
 *
 * Callers either return an unavailable state or throw an availability error,
 * so a slow API cannot hold the page response open until the platform timeout.
 *
 * Automatically injects the SERVICE_API_KEY header so ISR revalidation
 * bypasses the API server's per-IP rate limiter.
 */
async function fetchAndConsumeWithDeadline<T>(
  input: RequestInfo | URL,
  init: NextFetchRequestInit,
  timeoutMs: number,
  fetchImpl: FetchImplementation,
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const mergedInit = withServiceHeaders(init);
  const controller = new AbortController();
  let rejectAbort: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('Server-render fetch deadline exceeded', 'TimeoutError'));
  }, Math.max(1, timeoutMs));
  const abortFromCaller = () => controller.abort(mergedInit.signal?.reason);
  if (mergedInit.signal?.aborted) abortFromCaller();
  else mergedInit.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const work = async () => {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(input, { ...mergedInit, signal: controller.signal });
    controller.signal.throwIfAborted();
    return consume(response, controller.signal);
  };
  try {
    return await Promise.race([work(), interrupted]);
  } catch (error) {
    controller.abort(error);
    throw error;
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener('abort', rejectAbort!);
    mergedInit.signal?.removeEventListener('abort', abortFromCaller);
  }
}

export async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: NextFetchRequestInit = {},
  timeoutMs = getServerRenderFetchTimeoutMs(),
  fetchImpl: FetchImplementation = fetch,
): Promise<Response> {
  return fetchAndConsumeWithDeadline(input, init, timeoutMs, fetchImpl, async response => response);
}

/** Parse a bounded v1 JSON body within the same existing SSR deadline. */
export async function fetchApiDataWithDeadline<T = unknown>(
  input: RequestInfo | URL,
  init: NextFetchRequestInit = {},
  timeoutMs = getServerRenderFetchTimeoutMs(),
  fetchImpl: FetchImplementation = fetch,
): Promise<T> {
  const maxBytes = 1024 * 1024;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    return await fetchAndConsumeWithDeadline(input, init, timeoutMs, fetchImpl, async (response, signal) => {
      reader = response.body?.getReader();
      const declared = response.headers.get('content-length');
      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('Server-render JSON response is too large');
      if (!reader) throw new Error('Server-render JSON response is unavailable');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > maxBytes) throw new Error('Server-render JSON response is too large');
        chunks.push(part.value);
      }
      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      return readApiData<T>(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }));
    });
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
