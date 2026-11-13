/// <reference lib="deno.ns" />
// Native Deno test: the /models/ relay remains strict (allow-list, pinning,
// methods, ranges, redirect hops) without making any network request.
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@1';
import {
  allowedModels,
  encodeFilePath,
  handleModelProxy,
  isAllowedUpstreamUrl,
  isValidRange,
  parseModelPath,
  upstreamUrlFor,
} from '../../worker/model-proxy.ts';

const [repo, sha] = [...allowedModels().entries()][0]!;
const okPath = `/models/${repo}/resolve/${sha}/config.json`;

Deno.test('the catalogue pins a full 40-character revision for every repo', () => {
  assertEquals(allowedModels().size > 0, true);
  for (const [r, rev] of allowedModels()) {
    assertEquals(/^[0-9a-f]{40}$/.test(rev), true, `${r} is pinned to a full SHA`);
  }
});

Deno.test('pinned GET path parses; mutable revisions and unknown repos do not', () => {
  const parsed = parseModelPath(okPath);
  assertEquals(parsed.ok, true);
  if (parsed.ok) {
    assertEquals(parsed.route.repo, repo);
    assertEquals(parsed.route.revision, sha);
    assertEquals(parsed.route.file, 'config.json');
  }
  assertEquals(parseModelPath(`/models/${repo}/resolve/main/config.json`), { ok: false, status: 404, message: 'Model revision not available.' });
  assertEquals(parseModelPath(`/models/${repo}/resolve/${'a'.repeat(40)}/config.json`), { ok: false, status: 404, message: 'Model revision not available.' });
  assertEquals(parseModelPath('/models/evil/repo/resolve/' + sha + '/config.json'), { ok: false, status: 404, message: 'Model not available.' });
  assertEquals(parseModelPath(`/models/${repo}/blob/${sha}/config.json`), { ok: false, status: 404, message: 'Not found.' });
});

Deno.test('encoded traversal and malformed escapes are rejected', () => {
  for (const file of ['%2e%2e/secret', 'a%2Fb', 'a%5Cb', '%zz', '..%2f..']) {
    const result = parseModelPath(`/models/${repo}/resolve/${sha}/${file}`);
    assertEquals(result.ok, false, file);
  }
  assertEquals(parseModelPath(`/models/${repo}/resolve/${sha}/`).ok, false);
});

Deno.test('range syntax accepts one bounded byte range only', () => {
  for (const good of ['bytes=0-', 'bytes=0-15', 'bytes=10-20']) assertEquals(isValidRange(good), true, good);
  for (const bad of ['', 'bytes=-', 'bytes=20-10', 'bytes=0-1,3-4', 'items=0-1', 'bytes=abc']) assertEquals(isValidRange(bad), false, bad);
});

Deno.test('upstream URLs must stay on the Hugging Face origin', () => {
  assertEquals(isAllowedUpstreamUrl(new URL('https://huggingface.co/a/b')), true);
  assertEquals(isAllowedUpstreamUrl(new URL('https://cdn-lfs.hf.co/a/b')), true);
  assertEquals(isAllowedUpstreamUrl(new URL('http://huggingface.co/a/b')), false);
  assertEquals(isAllowedUpstreamUrl(new URL('https://huggingface.co.evil.test/a/b')), false);
  assertEquals(isAllowedUpstreamUrl(new URL('https://evil.test/a/b')), false);
  assertEquals(isAllowedUpstreamUrl(new URL('https://user:pass@huggingface.co/a/b')), false);
  assertEquals(isAllowedUpstreamUrl(new URL('https://huggingface.co:8443/a/b')), false);
});

Deno.test('upstream URL is rebuilt from constants, not the request', () => {
  const parsed = parseModelPath(okPath);
  if (!parsed.ok) throw new Error('fixture must parse');
  const url = upstreamUrlFor(parsed.route);
  assertEquals(url.origin, 'https://huggingface.co');
  assertEquals(url.pathname, `/${repo}/resolve/${sha}/config.json`);
  assertEquals(encodeFilePath('onnx/model q8.onnx'), 'onnx/model%20q8.onnx');
});

Deno.test('handleModelProxy rejects non-GET/HEAD and bad ranges without fetching', async () => {
  let fetched = 0;
  const fetchImpl = () => {
    fetched++;
    return Promise.resolve(new Response('nope'));
  };
  const post = await handleModelProxy(new Request(`https://moodsift.test${okPath}`, { method: 'POST' }), undefined, { fetchImpl });
  assertEquals(post.status, 405);
  assertEquals(post.headers.get('allow'), 'GET, HEAD');
  const badRange = await handleModelProxy(new Request(`https://moodsift.test${okPath}`, { headers: { range: 'bytes=9-1' } }), undefined, { fetchImpl });
  assertEquals(badRange.status, 416);
  assertEquals(fetched, 0);
});

Deno.test('handleModelProxy streams an approved response and forwards Range', async () => {
  const seen: { url?: string; range?: string | null } = {};
  const fetchImpl = (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.url = url; seen.range = new Headers(init?.headers).get('range');
    return Promise.resolve(new Response('abcdef', { status: 206, headers: { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'content-range': 'bytes 0-5/10', 'set-cookie': 'nope' } }));
  };
  const res = await handleModelProxy(
    new Request(`https://moodsift.test${okPath}`, { headers: { range: 'bytes=0-5' } }),
    undefined,
    { fetchImpl }
  );
  assertEquals(res.status, 206);
  assertEquals(await res.text(), 'abcdef');
  assertEquals(seen.url?.startsWith(`https://huggingface.co/${repo}/resolve/${sha}/`), true);
  assertEquals(seen.range, 'bytes=0-5');
  assertEquals(res.headers.get('content-range'), 'bytes 0-5/10');
  // Upstream credentials must never be relayed to the browser.
  assertEquals(res.headers.get('set-cookie'), null);
});

Deno.test('handleModelProxy refuses redirects off the Hugging Face hosts', async () => {
  const fetchImpl = () =>
    Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.test/model.bin' } }));
  const res = await handleModelProxy(new Request(`https://moodsift.test${okPath}`), undefined, { fetchImpl });
  assertEquals(res.status, 502);
  assertNotEquals(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
});

Deno.test('HEAD never carries a body, including errors', async () => {
  const fetchImpl = () => Promise.resolve(new Response(null, { status: 200, headers: { 'content-type': 'text/plain' } }));
  const ok = await handleModelProxy(new Request(`https://moodsift.test${okPath}`, { method: 'HEAD' }), undefined, { fetchImpl });
  assertEquals(ok.status, 200);
  assertEquals(ok.body, null);
  const missing = await handleModelProxy(new Request('https://moodsift.test/models/nope/resolve/main/x', { method: 'HEAD' }));
  assertEquals(missing.body, null);
});
