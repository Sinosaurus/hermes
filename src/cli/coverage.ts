// 文件职责：从冻结批次读取覆盖证据，不把元数据声明当作目标环境验收。
import path from 'node:path';
import type { Manifest, Target } from '../core/types.js';
import type { PlatformClosureReport } from '../core/collection/platforms.js';
import { readJson } from '../lib/index.js';

const profiles: Target[] = ['x64', 'arm64'].flatMap((cpu) => [
  { os: 'win32', cpu },
  { os: 'darwin', cpu },
  { os: 'linux', cpu, libc: 'glibc' },
  { os: 'linux', cpu, libc: 'musl' },
]);

function accepts(values: unknown, value?: string) {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.some((item) => typeof item !== 'string')) return false;
  if (!values.length) return true;
  return (
    !values.includes(`!${value}`) &&
    (values.includes('any') ||
      values.includes(value) ||
      values.every((item) => item.startsWith('!')))
  );
}

export async function bundleCoverage(directory: string, manifest: Manifest) {
  const mode = manifest.collection?.optionalClosure ?? 'inventory-only';
  const report = manifest.collection?.report;
  const platformMetadata =
    mode === 'registry-expanded' && report && Object.hasOwn(manifest.files, report)
      ? (await readJson<PlatformClosureReport>(path.join(directory, report)).catch(() => null))
          ?.platformMetadata
      : undefined;
  const packaged = new Set(manifest.packages.map(({ name, version }) => `${name}@${version}`));
  const scoped = new Map(
    (Array.isArray(platformMetadata) ? platformMetadata : [])
      .filter(
        (entry) =>
          entry &&
          (entry.os?.length || entry.cpu?.length || entry.libc?.length) &&
          packaged.has(`${entry.name}@${entry.version}`),
      )
      .map((entry) => [`${entry.name}@${entry.version}`, entry] as const),
  );
  const knownRuntimePackages = [
    ...new Set(
      manifest.packages
        .map(({ name }) => name)
        .filter((name) =>
          ['electron', 'playwright', 'playwright-core', '@playwright/test'].includes(name),
        ),
    ),
  ].sort();
  return {
    npm: {
      mode,
      report,
      status: Array.isArray(platformMetadata) ? 'metadata-only-not-runtime-tested' : 'not-assessed',
      profiles: profiles.map((profile) => ({
        ...profile,
        matchingPlatformPackages: Array.isArray(platformMetadata)
          ? [...scoped.values()].filter(
              (entry) =>
                accepts(entry.os, profile.os) &&
                accepts(entry.cpu, profile.cpu) &&
                (entry.libc === undefined ||
                  (profile.os === 'linux' && accepts(entry.libc, profile.libc))),
            ).length
          : null,
      })),
    },
    static: {
      entries: manifest.resources.map(({ id, version, targets }) => ({ id, version, targets })),
      review: manifest.resourceReview?.status ?? 'pending',
      knownRuntimePackages,
      automaticDetection: 'not-performed',
      missing: 'not-assessed',
    },
  };
}
