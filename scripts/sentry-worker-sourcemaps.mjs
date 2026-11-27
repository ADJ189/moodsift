#!/usr/bin/env node
// scripts/sentry-worker-sourcemaps.mjs
//
// Bundles the Cloudflare Worker and manages Sentry source map verification or upload:
//
//   node scripts/sentry-worker-sourcemaps.mjs --check   # dry-run bundle + verify .map linkage
//   node scripts/sentry-worker-sourcemaps.mjs           # dry-run bundle + upload source maps to Sentry
//   node scripts/sentry-worker-sourcemaps.mjs --deploy  # wrangler deploy + upload source maps if SENTRY_AUTH_TOKEN is set
//
// Expects SENTRY_AUTH_TOKEN (or an active `sentry` CLI login) when uploading.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const OUT_DIR = '.wrangler/worker-dist';

const args = new Set(process.argv.slice(2));
const isCheck = args.has('--check');
const isDeploy = args.has('--deploy');
const release = process.env.SENTRY_RELEASE?.trim() || `moodsift@${PKG.version}`;

function run(bin, binArgs, extraEnv = {}) {
  const res = spawnSync(bin, binArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) throw res.error;
  if (res.status !== 0) process.exit(res.status ?? 1);
}

if (isDeploy) {
  run('npx', [
    'wrangler',
    'deploy',
    '--outdir',
    OUT_DIR,
    '--upload-source-maps',
    '--var',
    `SENTRY_RELEASE:${release}`,
  ]);
  if (!process.env.SENTRY_AUTH_TOKEN?.trim()) {
    console.log('Skipping Sentry Worker source map upload (SENTRY_AUTH_TOKEN not set).');
    process.exit(0);
  }
} else {
  run('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', OUT_DIR]);
}

const sentryEnv = {
  SENTRY_ORG: process.env.SENTRY_ORG || 'adj189',
  SENTRY_PROJECT: process.env.SENTRY_PROJECT || 'moodsift-worker',
};

if (isCheck) {
  run('npx', ['sentry', 'sourcemaps', 'resolve', OUT_DIR], sentryEnv);
} else {
  run('npx', ['sentry', 'sourcemaps', 'upload', OUT_DIR, '--release', release], sentryEnv);
}
