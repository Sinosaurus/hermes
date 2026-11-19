import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { Manifest } from '../src/core/types.js';
import { bundleCoverage } from '../src/cli/coverage.js';

const report = 'platform.json';
const fixture = {
  packages: [
    { name: 'shared', version: '1.0.0' },
    { name: 'win-arm64', version: '1.0.0' },
    { name: 'linux-musl', version: '1.0.0' },
    { name: 'linux-glibc', version: '1.0.0' },
    { name: 'darwin-x64', version: '1.0.0' },
    { name: 'playwright-core', version: '1.0.0' },
  ],
  resources: [{ id: 'browser-cache', version: '1', targets: [{ os: 'win32', cpu: 'arm64' }] }],
  resourceReview: { status: 'pending' },
  files: { [report]: 'fixture' },
} as Manifest;

test('报告常用平台的已收录声明，而非运行或缺失结论', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hermes-cli-coverage-'));
  t.onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const meta = (name: string, fields = {}) => ({ name, version: '1.0.0', ...fields });
  await writeFile(
    path.join(dir, report),
    JSON.stringify({
      platformMetadata: [
        meta('shared'),
        meta('win-arm64', { os: ['win32'], cpu: ['arm64'] }),
        meta('linux-musl', { os: ['linux'], cpu: ['x64', 'arm64'], libc: ['musl'] }),
        meta('linux-glibc', { os: ['linux'], cpu: ['x64'], libc: ['!musl'] }),
        meta('darwin-x64', { os: ['darwin'], cpu: ['x64'] }),
        meta('uncaptured', { os: ['win32'], cpu: ['x64'] }),
      ],
    }),
  );
  const coverage = await bundleCoverage(dir, {
    ...fixture,
    collection: { optionalClosure: 'registry-expanded', report },
  });
  expect(coverage.npm.status).toBe('metadata-only-not-runtime-tested');
  expect(coverage.npm.profiles).toHaveLength(8);
  expect(
    coverage.npm.profiles.map(({ matchingPlatformPackages }) => matchingPlatformPackages),
  ).toEqual([0, 1, 1, 1, 1, 0, 0, 1]);
  expect(coverage.static.entries).toEqual(fixture.resources);
  expect(coverage.static.knownRuntimePackages).toEqual(['playwright-core']);
  expect(coverage.static.automaticDetection).toBe('not-performed');
  expect(coverage.static.missing).toBe('not-assessed');
});

test('无跨平台报告、无资源配置时不声称无缺失', async () => {
  const coverage = await bundleCoverage('.', {
    ...fixture,
    resources: [],
    collection: { optionalClosure: 'lock-only' },
  });
  expect(coverage.npm.status).toBe('not-assessed');
  expect(coverage.npm.profiles.every((profile) => profile.matchingPlatformPackages === null)).toBe(
    true,
  );
  expect(coverage.static.entries).toEqual([]);
  expect(coverage.static.missing).toBe('not-assessed');
});
