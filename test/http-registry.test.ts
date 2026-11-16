import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeRegistry,
  withHttpRegistries,
  allowedHttpUrl,
  anonymousHttpMode,
} from '../src/lib/security.js';
import { npmJson, npmCommand } from '../src/lib/npm.js';
import { validateDownload } from '../src/core/collection/resource-download.js';

test('HTTP opt-in is exact, scoped and does not authorize external resources', async () => {
  const endpoint = 'http://registry.example:4873/hosted/';
  assert.throws(() => normalizeRegistry(endpoint));
  await withHttpRegistries([endpoint], async () => {
    assert.equal(normalizeRegistry(endpoint), endpoint);
    assert.equal(normalizeRegistry('http://registry.example:4873/hosted'), endpoint);
    assert.throws(() => normalizeRegistry('http://registry.example:4873/'));
    assert.throws(() => normalizeRegistry('http://registry.example:4874/hosted/'));
    assert.equal(allowedHttpUrl(new URL(endpoint + 'package/-/package.tgz')), true);
    assert.equal(allowedHttpUrl(new URL('http://registry.example:4873/hosted-evil/p.tgz')), false);
    assert.throws(() =>
      validateDownload({
        url: endpoint + 'vendor.zip',
        filename: 'vendor.zip',
        sha256: '0'.repeat(64),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(anonymousHttpMode(), true);
  });
  assert.equal(anonymousHttpMode(), false);
  assert.throws(() => normalizeRegistry(endpoint));
  for (const url of [
    'https://registry.example/',
    'http://user:secret@registry.example/',
    endpoint + '?token=x',
  ])
    assert.throws(() => withHttpRegistries([url], () => {}));
});

test('parallel operations cannot inherit another request HTTP permission', async () => {
  await Promise.all([
    withHttpRegistries(['http://one.example/'], async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(normalizeRegistry('http://one.example/'), 'http://one.example/');
      assert.throws(() => normalizeRegistry('http://two.example/'));
    }),
    withHttpRegistries(['http://two.example/'], async () => {
      assert.equal(normalizeRegistry('http://two.example/'), 'http://two.example/');
      assert.throws(() => normalizeRegistry('http://one.example/'));
    }),
  ]);
});

test('HTTP npm mode ignores user credentials and environment, rejects project config', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-http-test-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const headers: unknown[] = [];
  const server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        name: 'example',
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name: 'example', version: '1.0.0' } },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const registry = `http://127.0.0.1:${address.port}/`;
  const userconfig = path.join(root, 'secret.npmrc');
  await writeFile(userconfig, `//127.0.0.1:${address.port}/:_authToken=fixture-secret\n`);
  const clean = path.join(root, 'clean');
  await mkdir(clean);
  await withHttpRegistries([registry], async () => {
    const result = await npmJson(['view', 'example@1.0.0'], {
      registry,
      cwd: clean,
      env: {
        ...process.env,
        npm_config_userconfig: userconfig,
        NPM_TOKEN: 'fixture-secret',
        NODE_AUTH_TOKEN: 'fixture-secret',
      },
    });
    assert.equal((result as any).version, '1.0.0');
    assert.ok(headers.length);
    assert.ok(headers.every((header) => header === undefined));
    await writeFile(
      path.join(root, '.npmrc'),
      `//127.0.0.1:${address.port}/:_authToken=fixture-project-secret\n`,
    );
    const before = headers.length;
    await assert.rejects(
      npmCommand(['view', 'example'], { registry, cwd: clean }),
      /refuses project .npmrc/,
    );
    assert.equal(headers.length, before);
  });
}, 30_000);

test('HTTP mode rejects authenticated proxies and package publishConfig', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hermes-http-publish-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'package'));
  await writeFile(
    path.join(root, 'package/package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      publishConfig: { _authToken: 'fixture-secret' },
    }),
  );
  const { command } = await import('../src/lib/npm.js');
  const file = path.join(root, 'fixture.tgz');
  await command('tar', ['-czf', file, '-C', root, 'package']);
  await withHttpRegistries(['http://registry.example/'], async () => {
    await assert.rejects(
      npmCommand(['--version'], {
        cwd: root,
        env: { ...process.env, HTTP_PROXY: 'http://user:fixture-secret@proxy.example/' },
      }),
      /refuses authenticated/,
    );
    await assert.rejects(
      npmCommand(['publish', file], { cwd: root }),
      /refuses package publishConfig/,
    );
  });
});
