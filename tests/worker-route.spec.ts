import { expect, test } from '@playwright/test';
import worker, { type Env } from '../worker/index';

const ORIGIN = 'https://moodsift.example';
const cand = (id: number) => ({ id, title: `T${id}`, year: 2000, genres: ['drama'], vibe: ['dark'] });
const body = (n: number) => JSON.stringify({ preferencesSummary: 'dark drama', candidates: Array.from({ length: n }, (_, i) => cand(i + 1)) });
const post = (b: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/recommend`, { method: 'POST', body: b, headers: { 'Content-Type': 'application/json', ...headers } });

function env(over: Partial<Env> = {}): Env {
  return {
    ASSETS: { fetch: async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) },
    AI: { run: async () => ({ response: JSON.stringify({ ranking: [{ id: 1, reason: 'Fits your mood.' }] }) }) },
    RECOMMEND_LIMITER: { limit: async () => ({ success: true }) },
    ...over,
  };
}

test.describe('Worker /api/recommend (v1.13.5 audit fixes)', () => {
  test('off when the AI binding is absent (the new default in wrangler.jsonc)', async () => {
    expect((await worker.fetch(post(body(3)), env({ AI: undefined }))).status).toBe(503);
  });

  test('fails closed without the shared rate-limit binding, unless explicitly allowed', async () => {
    expect((await worker.fetch(post(body(3)), env({ RECOMMEND_LIMITER: undefined }))).status).toBe(503);
    expect((await worker.fetch(post(body(3)), env({ RECOMMEND_LIMITER: undefined, ALLOW_UNSHARED_LIMIT: 'true' }))).status).toBe(200);
  });

  test('works with the shared limiter; a rejecting limiter yields 429', async () => {
    const res = await worker.fetch(post(body(3)), env());
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ranking: { id: number }[] };
    expect(json.ranking.map((r) => r.id).sort()).toEqual([1, 2, 3]); // every id exactly once
    expect((await worker.fetch(post(body(3)), env({ RECOMMEND_LIMITER: { limit: async () => ({ success: false }) } }))).status).toBe(429);
  });

  test('exactly 40 candidates is accepted; 41 is rejected rather than silently truncated', async () => {
    expect((await worker.fetch(post(body(40)), env())).status).toBe(200);
    const over = await worker.fetch(post(body(41)), env());
    expect(over.status).toBe(400);
  });

  test('foreign Origin is refused, same Origin and no Origin pass the origin check; wrong method is 405', async () => {
    expect((await worker.fetch(post(body(3), { Origin: 'https://evil.example' }), env())).status).toBe(403);
    expect((await worker.fetch(post(body(3), { Origin: ORIGIN }), env())).status).toBe(200);
    expect((await worker.fetch(new Request(`${ORIGIN}/api/recommend`), env())).status).toBe(405);
  });

  test('malformed / oversized / duplicate-id bodies are rejected', async () => {
    expect((await worker.fetch(post('{nope'), env())).status).toBe(400);
    expect((await worker.fetch(post('x'.repeat(20_000)), env())).status).toBe(413);
    const dup = JSON.stringify({ candidates: [cand(1), cand(1)] });
    expect((await worker.fetch(post(dup), env())).status).toBe(400);
  });

  test('provider errors are generic; malformed model JSON is 422', async () => {
    const boom = await worker.fetch(post(body(3)), env({ AI: { run: async () => { throw new Error('secret provider detail'); } } }));
    expect(boom.status).toBe(502);
    expect(await boom.text()).not.toContain('secret');
    const bad = await worker.fetch(post(body(3)), env({ AI: { run: async () => ({ response: 'not json' }) } }));
    expect(bad.status).toBe(422);
  });

  test('asset responses carry isolation, referrer, enforced frame-ancestors and report-only CSP headers', async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/`), env());
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('credentialless');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('Content-Security-Policy')).toBe("frame-ancestors 'self'");
    const ro = res.headers.get('Content-Security-Policy-Report-Only') ?? '';
    for (const host of ['https://api.themoviedb.org', 'https://image.tmdb.org', 'https://huggingface.co', 'https://esm.sh', 'https://cdn.jsdelivr.net', 'https://unpkg.com']) expect(ro).toContain(host);
    expect(ro).toContain("object-src 'none'");
    expect(ro).toContain("worker-src 'self' blob:");
  });
});
