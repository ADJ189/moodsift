import { expect, test } from '@playwright/test';
import worker, { type Env } from '../worker/index';
import { handleModelProxy, parseModelPath, type FetchLike } from '../worker/model-proxy';
import { MODELS } from '../src/lib/ai-policy';

// Regression tests for the same-origin `/models/` relay. The upstream is a
// deterministic fake, so these run without network access and without a real
// model download. The real Worker and the Vite dev/preview middleware both call
// handleModelProxy(), so this covers the routing logic used in all three places.

const ORIGIN = 'https://moodsift.example';
const MODEL = MODELS['smollm2-135m'];
const FILE_PATH = `/models/${MODEL.repo}/resolve/${MODEL.revision}/config.json`;

interface Recorded {
  url: string;
  init: RequestInit;
}

function mockFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push({ url: url.href, init });
      return await handler(url, init);
    },
  };
}

async function call(path: string, fetchImpl: FetchLike, init: RequestInit = {}): Promise<Response> {
  const request = new Request(`${ORIGIN}${path}`, init);
  return await handleModelProxy(request, new URL(request.url), { fetchImpl });
}

test.describe('same-origin model proxy', () => {
  test('serves an approved pinned file with the redirect followed server-side', async () => {
    const mock = mockFetch((url) => {
      if (url.hostname === 'huggingface.co') {
        return new Response(null, { status: 302, headers: { Location: 'https://cdn-lfs.hf.co/model/config.json' } });
      }
      return new Response('{"model_type":"smollm2"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Content-Length': '24', 'Set-Cookie': 'session=secret' },
      });
    });

    const res = await call(FILE_PATH, mock.fetch);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"model_type":"smollm2"}');
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[0]!.init.redirect).toBe('manual');
    expect(mock.calls[1]!.url).toBe('https://cdn-lfs.hf.co/model/config.json');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('rejects unknown repositories, mutable revisions and traversal before any upstream call', async () => {
    const mock = mockFetch(() => new Response('should not happen'));

    for (const path of [
      `/models/evil/private/resolve/${MODEL.revision}/config.json`,
      `/models/${MODEL.repo}/resolve/main/config.json`,
      `/models/${MODEL.repo}/resolve/${MODEL.revision}/%2e%2e/secret`,
    ]) {
      const res = await call(path, mock.fetch);
      expect(res.status, path).toBe(404);
    }
    expect(mock.calls).toHaveLength(0);
  });

  test('only GET and HEAD are accepted', async () => {
    const mock = mockFetch(() => new Response('nope'));
    const res = await call(FILE_PATH, mock.fetch, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
    expect(mock.calls).toHaveLength(0);
  });

  test('HEAD has no body; Range returns 206 and an invalid Range is 416', async () => {
    const mock = mockFetch((_url, init) => {
      const range = new Headers(init.headers).get('range');
      return new Response(init.method === 'HEAD' ? null : 'partial', {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '8',
          ...(range ? { 'Content-Range': 'bytes 0-7/100' } : {}),
        },
      });
    });

    const head = await call(FILE_PATH, mock.fetch, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();

    const ranged = await call(FILE_PATH, mock.fetch, { headers: { Range: 'bytes=0-7' } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 0-7/100');
    expect(await ranged.text()).toBe('partial');

    const invalid = await call(FILE_PATH, mock.fetch, { headers: { Range: 'bytes=0-7,9-10' } });
    expect(invalid.status).toBe(416);
  });

  test('parseModelPath only accepts the exact approved repo/revision shape', () => {
    expect(parseModelPath(FILE_PATH)).toEqual({ ok: true, route: { repo: MODEL.repo, revision: MODEL.revision, file: 'config.json' } });
    expect(parseModelPath(`/models/${MODEL.repo}/resolve/${MODEL.revision}/onnx/model_quantized.onnx`)).toMatchObject({
      ok: true,
      route: { file: 'onnx/model_quantized.onnx' },
    });
    expect(parseModelPath(`/models/${MODEL.repo}/resolve/${MODEL.revision}/`)).toMatchObject({ ok: false, status: 400 });
    expect(parseModelPath(`/models/${MODEL.repo}/resolve/${MODEL.revision}/..%2fsecret`)).toMatchObject({ ok: false, status: 400 });
  });

  test('the Worker routes /models/ before the static assets fallback', async () => {
    let assetCalls = 0;
    const env: Env = {
      ASSETS: {
        fetch: async () => {
          assetCalls++;
          return new Response('asset', { status: 200 });
        },
      },
    };
    const res = await worker.fetch(new Request(`${ORIGIN}/models/evil/private/resolve/${MODEL.revision}/config.json`), env);
    expect(res.status).toBe(404);
    expect(assetCalls).toBe(0);
  });
});
