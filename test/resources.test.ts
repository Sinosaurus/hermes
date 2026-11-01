// 文件职责：显式外部资源下载、安全边界及本地资源兼容回归。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { downloadResource, validateDownload } from '../src/core/collection/resource-download.js';
import { addResources } from '../src/core/collection/resources.js';

const content = Buffer.from('reviewed offline binary fixture');
const sha256 = createHash('sha256').update(content).digest('hex');

async function fixture(t, redirectTo?: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-resource-'));
  const server = createServer((req, res) => {
    if (req.url === '/approved') {
      res.writeHead(302, { location: redirectTo }).end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/binary?signature=do-not-record' }).end();
    } else if (req.url === '/external') {
      res
        .writeHead(302, { location: 'https://unapproved.example/binary?signature=do-not-record' })
        .end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (req.url === '/slow') {
      setTimeout(() => res.end(content), 100);
    } else if (req.url === '/stream') {
      res.writeHead(200);
      res.write(content.subarray(0, 5));
      res.end(content.subarray(5));
    } else if (req.url === '/missing') {
      res.writeHead(404).end('no');
    } else res.end(content);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  t.onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, url: `http://127.0.0.1:${address.port}` };
}

function config(url: string, rest = {}) {
  return { url, sha256, filename: 'binary.zip', ...rest };
}

test('downloads expected bytes with provenance and refuses overwrite', async (t) => {
  const { root, url } = await fixture(t);
  const result = await downloadResource(config(url), root);
  assert.deepEqual(result, {
    url: `${url}/`,
    filename: 'binary.zip',
    sha256,
    size: content.length,
  });
  assert.deepEqual(await fs.readFile(path.join(root, 'binary.zip')), content);
  await assert.rejects(downloadResource(config(url), root), /already exists/);
  assert.deepEqual(await fs.readdir(root), ['binary.zip']);
});

test('signed redirect query is consumed but never persisted', async (t) => {
  const { root, url } = await fixture(t);
  const result = await downloadResource(config(`${url}/redirect`), root);
  assert.equal(result.url, `${url}/redirect`);
  assert.doesNotMatch(JSON.stringify(result), /signature|do-not-record/);
});

test('redirects require explicit hosts and errors do not expose signed URLs', async (t) => {
  const { root, url } = await fixture(t);
  await assert.rejects(downloadResource(config(`${url}/external`), root), (error: Error) => {
    assert.match(error.message, /not explicitly allowed/);
    assert.doesNotMatch(error.message, /signature|do-not-record/);
    return true;
  });
  assert.deepEqual(await fs.readdir(root), []);
});

test('cross-host redirect succeeds only with exact explicitly allowed host', async (t) => {
  const target = await fixture(t);
  const source = await fixture(t, `${target.url}/binary?signature=private-value`);
  const result = await downloadResource(
    config(`${source.url}/approved`, {
      allowHosts: [new URL(target.url).host],
      sha256: sha256.toUpperCase(),
    }),
    source.root,
  );
  assert.equal(result.sha256, sha256);
  assert.equal(result.url, `${source.url}/approved`);
  assert.doesNotMatch(JSON.stringify(result), /private-value/);
});

test('bad hash never leaves a file or partial download', async (t) => {
  const { root, url } = await fixture(t);
  await assert.rejects(
    downloadResource(config(url, { sha256: '0'.repeat(64) }), root),
    /SHA-256 mismatch/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('declared and streamed size limits are enforced', async (t) => {
  const { root, url } = await fixture(t);
  for (const endpoint of ['', '/stream'])
    await assert.rejects(
      downloadResource(config(`${url}${endpoint}`, { maxBytes: 10 }), root),
      /maxBytes/,
    );
  assert.deepEqual(await fs.readdir(root), []);
});

test('timeout, HTTP error and redirect loops stop cleanly', async (t) => {
  const { root, url } = await fixture(t);
  await assert.rejects(
    downloadResource(config(`${url}/slow`, { timeoutMs: 10 }), root),
    /timed out/,
  );
  await assert.rejects(downloadResource(config(`${url}/missing`), root), /HTTP 404/);
  await assert.rejects(
    downloadResource(config(`${url}/loop`), root),
    /Too many resource redirects/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});

test('resource configuration rejects unsafe URL, filename, hash and limits', () => {
  for (const url of [
    'http://example.com/a',
    'file:///tmp/a',
    'https://u:secret@example.com/a',
    'https://example.com/a?secret=1',
    'https://example.com/a#x',
  ])
    assert.throws(() => validateDownload(config(url)));
  for (const filename of [
    '../escape',
    'a/b',
    'a\\b',
    'CON',
    'aux.zip',
    'file.',
    '.hidden',
    'a:stream',
  ])
    assert.throws(() => validateDownload(config('https://example.com/a', { filename })));
  for (const rest of [
    { sha256: 'short' },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { timeoutMs: 0 },
    { allowHosts: ['https://other.example'] },
    { allowHosts: ['other.example/path'] },
  ])
    assert.throws(() => validateDownload(config('https://example.com/a', rest)));
});

test('addResources keeps local inputs and explicit download metadata', async (t) => {
  const { root, url } = await fixture(t);
  await fs.writeFile(path.join(root, 'local.bin'), 'local');
  const file = path.join(root, 'resources.json');
  const targets = [{ os: 'win32', cpu: 'x64', nodeAbi: '137' }];
  const resources = [
    { id: 'local', source: 'local.bin', targets, instructions: '复制到专用缓存' },
    {
      id: 'remote',
      download: config(`${url}/redirect`),
      targets,
      version: '1.0.0',
      environment: { TOOL_MIRROR: '{{baseUrl}}/resources/remote' },
      instructions: '上传静态服务器后配置镜像地址',
    },
  ];
  await fs.writeFile(file, JSON.stringify({ resources }));
  const bundle = {
    out: path.join(root, 'bundle'),
    manifest: { resources: [], resourceReview: { status: 'pending' } },
  } as any;
  await addResources(bundle, file);
  assert.equal(bundle.manifest.resources.length, 2);
  assert.deepEqual(bundle.manifest.resources[0].files, ['resources/local/local.bin']);
  assert.equal(bundle.manifest.resources[1].download.sha256, sha256);
  assert.equal(bundle.manifest.resources[1].version, '1.0.0');
  assert.equal(
    bundle.manifest.resources[1].environment.TOOL_MIRROR,
    '{{baseUrl}}/resources/remote',
  );
  assert.equal(bundle.manifest.resourceReview.status, 'pending');
  assert.doesNotMatch(JSON.stringify(bundle.manifest), /do-not-record/);
});

test('addResources rejects ambiguous sources, invalid targets and environment hints', async (t) => {
  const { root, url } = await fixture(t);
  const base = { id: 'example', targets: [{ os: 'linux', cpu: 'x64' }], instructions: 'Review' };
  const invalid = [
    base,
    { ...base, source: 'a', download: config(url) },
    { ...base, source: 'a', targets: [{}] },
    { ...base, id: 'CON', source: 'a' },
    { ...base, id: 'nul', source: 'a' },
    { ...base, source: 'a', environment: { 'BAD-KEY': 'value' } },
    { ...base, source: 'a', environment: { OK: 'value\ncommand' } },
  ];
  const file = path.join(root, 'resources.json');
  for (const resource of invalid) {
    await fs.writeFile(file, JSON.stringify({ resources: [resource] }));
    await assert.rejects(
      addResources({ out: root, manifest: { resources: [] } } as any, file),
      /Invalid resource/,
    );
  }
});

test('local resource root symlink is rejected', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'actual'), 'bytes');
  await fs.symlink(path.join(root, 'actual'), path.join(root, 'link'));
  const file = path.join(root, 'resources.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      resources: [
        {
          id: 'link',
          source: 'link',
          targets: [{ os: 'linux', cpu: 'x64' }],
          instructions: 'Review',
        },
      ],
    }),
  );
  await assert.rejects(
    addResources({ out: root, manifest: { resources: [] } } as any, file),
    /file or directory/,
  );
});

test('resource ids cannot collide on case-insensitive filesystems', async (t) => {
  const { root } = await fixture(t);
  await fs.writeFile(path.join(root, 'local.bin'), 'bytes');
  const file = path.join(root, 'resources.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      resources: ['Tool', 'tool'].map((id) => ({
        id,
        source: 'local.bin',
        targets: [{ os: 'win32', cpu: 'x64' }],
        instructions: 'Review',
      })),
    }),
  );
  await assert.rejects(
    addResources({ out: path.join(root, 'out'), manifest: { resources: [] } } as any, file),
    /Invalid resource/,
  );
});
