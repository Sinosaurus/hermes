// 文件职责：制品校验：检查 tarball、禁钩子打包及验证冻结 bundle。
import type { Manifest, PackageJson, VerifiedBundle } from '../core/types.js';
import type { NpmOptions } from './npm.js';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { command, assertPackToolchain, npmJson } from './npm.js';
import { validateIdentity, packageSpec } from './packages.js';
import { safePath, readJson, fileHash, listFiles, assertIntegrity } from './files.js';

export async function readArtifact(file: string) {
  const listing = (await command('tar', ['-tzf', file])).trim().split('\n');
  for (const entry of listing) {
    const parts = entry.replace(/\/$/, '').split('/');
    if (
      parts[0] !== 'package' ||
      parts.some((part) => part === '..' || part === '.') ||
      entry.includes('\\') ||
      entry.includes('\0')
    )
      throw new Error('Unsafe tarball member');
  }
  if (listing.filter((entry) => entry === 'package/package.json').length !== 1)
    throw new Error('Tarball needs exactly one package/package.json');
  // 仅读取归档，不解压；拒绝链接和设备文件，防止消费安装时越界。
  const verbose = await command('tar', ['-tvzf', file]);
  if (
    verbose
      .trim()
      .split('\n')
      .some((line) => !['-', 'd'].includes(line[0]))
  )
    throw new Error('Tarball links and special files are not supported');
  const packageJson: PackageJson = JSON.parse(
    await command('tar', ['-xOf', file, 'package/package.json']),
  );
  validateIdentity(packageJson);
  return { packageJson, members: listing };
}

export async function packArtifact(spec: string, destination: string, options: NpmOptions = {}) {
  await assertPackToolchain(options);
  await mkdir(destination, { recursive: true });
  // 每次使用新缓存，避免相同 URL 的历史内容干扰远端字节比对。
  const output = await npmJson(
    ['pack', spec, '--ignore-scripts', '--pack-destination', path.resolve(destination)],
    { ...options, cache: path.join(path.resolve(destination), '.npm-cache') },
  );
  if (
    !Array.isArray(output) ||
    output.length !== 1 ||
    typeof output[0].filename !== 'string' ||
    path.basename(output[0].filename) !== output[0].filename
  )
    throw new Error('Unexpected npm pack output');
  const file = await safePath(destination, output[0].filename);
  const { packageJson } = await readArtifact(file);
  return {
    file,
    packageJson,
    sha256: await fileHash(file),
    artifactIntegrity: `sha512-${await fileHash(file, 'sha512', 'base64')}`,
    size: (await stat(file)).size,
  };
}

async function verifyPackages(directory: string, manifest: Manifest) {
  const identities = new Set(),
    ids = new Set();
  for (const pkg of manifest.packages) {
    validateIdentity(pkg);
    const identity = packageSpec(pkg);
    if (
      typeof pkg.id !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(pkg.id) ||
      identities.has(identity) ||
      ids.has(pkg.id) ||
      !['registry-original', 'installed-repack'].includes(pkg.artifactKind)
    )
      throw new Error('Duplicate/invalid package identity');
    identities.add(identity);
    ids.add(pkg.id);
    if (manifest.files[pkg.file] !== pkg.sha256)
      throw new Error(`Missing package checksum: ${identity}`);
    const file = await safePath(directory, pkg.file);
    await assertIntegrity(file, pkg.artifactIntegrity);
    if (pkg.artifactKind === 'registry-original') await assertIntegrity(file, pkg.sourceIntegrity);
    const { packageJson } = await readArtifact(file);
    if (packageSpec(packageJson) !== identity)
      throw new Error(`Tarball identity mismatch: ${identity}`);
    if (pkg.metadataFile && !Object.hasOwn(manifest.files, pkg.metadataFile))
      throw new Error('Unregistered metadata file');
  }
}

function verifyDeclarations(manifest: Manifest) {
  if (
    !Array.isArray(manifest.tagPlan) ||
    !Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.targets) ||
    !manifest.targets.length
  )
    throw new Error('Missing tag/resource/target declarations');
  if (
    manifest.targets.some(
      (target) => !target || typeof target !== 'object' || Array.isArray(target),
    )
  )
    throw new Error('Invalid target declaration');
  for (const plan of manifest.tagPlan) {
    if (
      !plan ||
      typeof plan.name !== 'string' ||
      !plan.set ||
      typeof plan.set !== 'object' ||
      Array.isArray(plan.set) ||
      Object.values(plan.set).some((version) => typeof version !== 'string')
    )
      throw new Error('Invalid tag plan');
  }
  const resourceIds = new Set();
  for (const resource of manifest.resources) {
    if (
      !resource ||
      typeof resource.id !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(resource.id) ||
      resourceIds.has(resource.id) ||
      typeof resource.instructions !== 'string' ||
      !resource.instructions.trim() ||
      !Array.isArray(resource.targets) ||
      !resource.targets.length ||
      !Array.isArray(resource.files) ||
      !resource.files.length ||
      resource.files.some(
        (file) => typeof file !== 'string' || !Object.hasOwn(manifest.files, file),
      )
    )
      throw new Error('Invalid resource declaration or missing file');
    resourceIds.add(resource.id);
  }
  const review = manifest.resourceReview;
  if (
    !review ||
    !['pending', 'reviewed'].includes(review.status) ||
    (review.status === 'reviewed' &&
      (!Array.isArray(review.evidence) ||
        !review.evidence.length ||
        review.evidence.some((item) => typeof item !== 'string' || !item.trim())))
  )
    throw new Error('Invalid resource review');
}

export async function verifyBundle(directory: string): Promise<VerifiedBundle> {
  const manifestFile = await safePath(directory, 'manifest.json');
  const manifest = await readJson<Manifest>(manifestFile);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.status !== 'complete' ||
    !Array.isArray(manifest.packages) ||
    !manifest.packages.length ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  )
    throw new Error('Invalid/incomplete bundle manifest');
  const expectedFiles = Object.keys(manifest.files).sort();
  if (
    JSON.stringify(await listFiles(directory)) !==
    JSON.stringify([...expectedFiles, 'manifest.json', 'checksums.sha256'].sort())
  )
    throw new Error('Bundle file set differs from manifest');
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (
      !/^[0-9a-f]{64}$/.test(hash) ||
      (await fileHash(await safePath(directory, relative))) !== hash
    )
      throw new Error(`File checksum mismatch: ${relative}`);
  }
  const manifestDigest = await fileHash(manifestFile);
  const expectedChecksums =
    [...expectedFiles, 'manifest.json']
      .sort()
      .map(
        (relative) =>
          `${relative === 'manifest.json' ? manifestDigest : manifest.files[relative]}  ${relative}`,
      )
      .join('\n') + '\n';
  if ((await readFile(await safePath(directory, 'checksums.sha256'), 'utf8')) !== expectedChecksums)
    throw new Error('Invalid checksums.sha256');
  await verifyPackages(directory, manifest);
  verifyDeclarations(manifest);
  return { manifest, manifestDigest };
}
