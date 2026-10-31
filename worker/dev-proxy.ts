// worker/dev-proxy.ts
//
// Vite development/preview middleware for the same-origin /models/ route.
//
// Why not Vite's built-in `server.proxy`? A proxy that forwards Hugging Face's
// 3xx `Location` to the browser lets the browser follow the redirect directly
// to the file-storage host, which is exactly the CORS dependency the production
// Worker removes. This middleware calls the real worker/model-proxy.ts handler
// instead, so local dev and preview use the same allow-list, redirect checks,
// range handling and streaming logic as production.
//
// It is development tooling only. In production the request reaches
// worker/index.ts via Cloudflare's static-asset routing.

import { once } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { handleModelProxy, MODEL_PREFIX } from './model-proxy';

type Next = (err?: unknown) => void;

/** Copies Node request headers into the Fetch API shape used by the handler. */
function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/** Streams a Fetch API body to the Node response with backpressure. */
async function pump(body: ReadableStream<Uint8Array>, res: ServerResponse): Promise<void> {
  const reader = body.getReader();
  const onClose = (): void => {
    // Only cancel for an aborted client, not for the normal close after end().
    if (!res.writableEnded) void reader.cancel().catch(() => {});
  };
  res.once('close', onClose);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await once(res, 'drain');
    }
    res.end();
  } catch (err) {
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  } finally {
    res.off('close', onClose);
    try {
      reader.releaseLock();
    } catch {
      // Already released by cancellation.
    }
  }
}

async function modelMiddleware(req: IncomingMessage, res: ServerResponse, next: Next): Promise<void> {
  const raw = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(raw, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    next();
    return;
  }
  if (!url.pathname.startsWith(MODEL_PREFIX)) {
    next();
    return;
  }

  try {
    const request = new Request(url, {
      method: (req.method ?? 'GET').toUpperCase(),
      headers: requestHeaders(req),
    });
    const response = await handleModelProxy(request, url);

    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));

    if (request.method === 'HEAD' || !response.body) {
      res.end();
      return;
    }
    await pump(response.body, res);
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.destroy(err instanceof Error ? err : new Error(String(err)));
  }
}

/** Registers the /models/ relay on both `vite` and `vite preview`. */
export function modelProxyPlugin(): Plugin {
  const install = (server: { middlewares: { use(fn: typeof modelMiddleware): void } }): void => {
    server.middlewares.use(modelMiddleware);
  };
  return {
    name: 'moodsift-model-proxy',
    configureServer: (server) => install(server),
    configurePreviewServer: (server) => install(server),
  };
}
