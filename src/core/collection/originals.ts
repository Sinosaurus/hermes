// 文件职责：回源取得原始 tarball，验证身份和完整性，记录实例与源 tag。
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { SourceEntry, Tags, PackageJson, BundlePackage } from '../types.js';
import type { Bundle } from './bundle.js';
import {
  npmJson,
  packageSpec,
  packArtifact,
  assertIntegrity,
  publicUrl,
  validateIdentity,
  writeJson,
} from '../../lib/index.js';

function assertSourceUrl(value: string, registry: string, allowHosts: string[]) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
  )
    throw new Error(
      'Tarball source must use HTTPS without embedded credentials (localhost HTTP is allowed)',
    );
  if (![new URL(registry).host, ...allowHosts].includes(url.host))
    throw new Error(`Unapproved tarball host: ${url.host}; declare --allow-host explicitly`);
  return url.href;
}

export async function addOriginal(
  bundle: Bundle,
  entry: SourceEntry,
  {
    registry,
    allowHosts = [],
    snapshots,
    context,
  }: { registry: string; allowHosts?: string[]; snapshots: Map<string, Tags>; context: string },
) {
  const progress = () =>
    bundle.report({
      phase: 'download',
      completed: bundle.manifest.packages.length,
      total: bundle.stats.total,
      name: entry.name,
      version: entry.version,
    });
  progress();
  const { metadata, url, sourceIntegrity } = await resolveSource(entry, registry, allowHosts);
  const existing = bundle.manifest.packages.find((pkg) => packageSpec(pkg) === packageSpec(entry));
  if (existing) {
    await assertIntegrity(path.join(bundle.out, existing.file), sourceIntegrity);
    existing.instances!.push({ context, location: entry.location || entry.name });
    bundle.stats.reused++;
    progress();
    return;
  }
  const id = String(bundle.manifest.packages.length + 1).padStart(6, '0');
  const scratch = await mkdtemp(path.join(tmpdir(), 'offline-npm-pack-'));
  try {
    const artifact = await packArtifact(url, scratch, { registry, packageName: entry.name });
    if (packageSpec(artifact.packageJson) !== packageSpec(entry))
      throw new Error('Downloaded tarball identity differs from lockfile');
    await assertIntegrity(artifact.file, sourceIntegrity);
    await mkdir(path.join(bundle.out, 'packages'), { recursive: true });
    const file = `packages/${id}.tgz`;
    await rename(artifact.file, path.join(bundle.out, file));
    const pkg = await recordOriginal(bundle, entry, metadata, artifact, {
      id,
      file,
      registry,
      url,
      sourceIntegrity,
      context,
    });
    bundle.manifest.packages.push(pkg);
    bundle.stats.downloaded++;
    bundle.stats.downloadBytes += artifact.size;
    await captureTags(pkg, registry, snapshots);
    progress();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** 先核对 registry 身份和来源许可，再选择可信摘要。 */
async function resolveSource(entry: SourceEntry, registry: string, allowHosts: string[]) {
  const metadata = await npmJson<PackageJson>(['view', packageSpec(entry)], {
    registry,
    packageName: entry.name,
  });
  validateIdentity(metadata);
  if (packageSpec(metadata) !== packageSpec(entry))
    throw new Error('Registry returned a different package identity');
  const url = assertSourceUrl(entry.resolved || metadata.dist?.tarball || '', registry, allowHosts);
  const sourceIntegrity =
    entry.integrity ||
    metadata.dist?.integrity ||
    (metadata.dist?.shasum
      ? `sha1-${Buffer.from(metadata.dist.shasum, 'hex').toString('base64')}`
      : null);
  if (!sourceIntegrity) throw new Error(`No trusted source integrity: ${packageSpec(entry)}`);
  return { metadata, url, sourceIntegrity };
}

async function captureTags(pkg: BundlePackage, registry: string, snapshots: Map<string, Tags>) {
  if (snapshots.has(pkg.name)) return;
  const tags = await npmJson(['view', packageSpec(pkg), 'dist-tags'], {
    registry,
    packageName: pkg.name,
  });
  if (
    !tags ||
    typeof tags !== 'object' ||
    Array.isArray(tags) ||
    Object.values(tags).some((value) => typeof value !== 'string')
  )
    throw new Error(`Invalid tags snapshot: ${pkg.name}`);
  snapshots.set(pkg.name, tags as Tags);
}

/** 只记录脱敏来源和冻结身份，原始制品内容保持不变。 */
async function recordOriginal(
  bundle: Bundle,
  entry: SourceEntry,
  metadata: PackageJson,
  artifact: Awaited<ReturnType<typeof packArtifact>>,
  {
    id,
    file,
    registry,
    url,
    sourceIntegrity,
    context,
  }: {
    id: string;
    file: string;
    registry: string;
    url: string;
    sourceIntegrity: string;
    context: string;
  },
) {
  const metadataFile = `metadata/${id}.json`;
  const safeMetadata = {
    name: metadata.name,
    version: metadata.version,
    dependencies: metadata.dependencies,
    optionalDependencies: metadata.optionalDependencies,
    peerDependencies: metadata.peerDependencies,
    deprecated: metadata.deprecated,
    scripts: artifact.packageJson.scripts,
    dist: { tarball: publicUrl(url), integrity: sourceIntegrity },
    sourceTags: metadata['dist-tags'] || {},
  };
  await writeJson(path.join(bundle.out, metadataFile), safeMetadata);
  const pkg: BundlePackage = {
    id,
    artifactKind: 'registry-original',
    name: entry.name,
    version: entry.version,
    file,
    sha256: artifact.sha256,
    artifactIntegrity: artifact.artifactIntegrity,
    sourceIntegrity,
    sourceRegistry: registry,
    sourceTarball: publicUrl(url),
    metadataFile,
    instances: [{ context, location: entry.location || entry.name }],
  };
  return pkg;
}
