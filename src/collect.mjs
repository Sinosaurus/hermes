import { cp, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { assertPackToolchain, assertIntegrity, fileHash, listFiles, normalizeRegistry, npmCommand, npmJson, packageSpec, packArtifact, publicUrl, readJson, redact, validateIdentity, verifyBundle, writeJson } from './common.mjs';

export const currentTarget = () => ({ os: process.platform, cpu: process.arch, node: process.version, nodeAbi: process.versions.modules, libc: process.report?.getReport().header.glibcVersionRuntime ? `glibc-${process.report.getReport().header.glibcVersionRuntime}` : process.platform === 'linux' ? 'unknown' : 'not-applicable' });

export function registrySpec(value) {
  const match = /^(?<name>(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*)(?:@(?<selector>[a-zA-Z0-9.*+~^<>=| -]+))?$/.exec(value);
  if (!match) throw new Error('Package input must be a registry name, tag or version range; Git/file/URL/alias inputs are not supported');
  return match.groups.name;
}

export function validateInstallFlags(flags) {
  const allowed = new Set(['--legacy-peer-deps', '--strict-peer-deps', '--install-links=true', '--install-links=false']);
  if (!Array.isArray(flags) || flags.some(flag => !allowed.has(flag))) throw new Error('Supported install flags: --legacy-peer-deps, --strict-peer-deps, --install-links=true/false');
  if (flags.includes('--legacy-peer-deps') && flags.includes('--strict-peer-deps')) throw new Error('Conflicting peer dependency flags');
  if (flags.includes('--install-links=true') && flags.includes('--install-links=false')) throw new Error('Conflicting install-links flags');
  return [...new Set(flags)];
}

function packageAt(location, entry) {
  return entry.name || location.split('node_modules/').at(-1);
}

export function entriesFromLock(lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages || typeof lock.packages !== 'object') throw new Error('Only npm lockfile v2/v3 is supported');
  const entries = [], skipped = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location) continue;
    if (entry.link) throw new Error(`Workspace/file/link input needs an explicit migration: ${location}`);
    if (entry.inBundle) { skipped.push({ location, reason: 'included-in-parent-tarball' }); continue; }
    if (!entry.version && entry.optional && entry.peer) { skipped.push({ location, reason: 'optional-peer-not-selected' }); continue; }
    if (!location.includes('node_modules/')) throw new Error(`Non-registry lock entry: ${location}`);
    const item = { name: packageAt(location, entry), version: entry.version, location, resolved: entry.resolved, integrity: entry.integrity };
    validateIdentity(item);
    if (item.resolved && !/^https?:\/\//.test(item.resolved)) throw new Error(`Git/file/other source requires explicit migration: ${location}`);
    if (item.resolved) {
      const source = new URL(item.resolved);
      if (source.username || source.password || source.search || source.hash) throw new Error(`Lockfile resolved URL must not contain credentials, query or fragment: ${location}`);
    }
    entries.push(item);
  }
  return { entries, skipped };
}

export function tagPlanFromSnapshots(snapshots, packages) {
  const present = new Set(packages.map(packageSpec));
  return [...snapshots].map(([name, sourceTags]) => {
    const set = {}, excluded = [];
    for (const [tag, version] of Object.entries(sourceTags)) {
      if (present.has(`${name}@${version}`)) set[tag] = version;
      else excluded.push({ tag, version, reason: 'version-not-in-batch' });
    }
    return { name, sourceTags, set, excluded };
  });
}

async function newBundle(out, mode, onProgress) {
  const npm = await assertPackToolchain();
  out = path.resolve(out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out); // Never overwrite an already handed-off bundle.
  const stats = { total: 0, downloaded: 0, downloadBytes: 0, reused: 0, repacked: 0, packedBytes: 0, uploaded: 0, uploadBytes: 0 };
  return { out, stats, report: event => onProgress?.({ ...stats, ...event }), manifest: { schemaVersion: 1, status: 'collecting', batchId: randomUUID(), capturedAt: new Date().toISOString(), mode, toolchain: { node: process.version, npm }, targets: [currentTarget()], roots: [], inputs: [], packages: [], tagPlan: [], resources: [], resourceReview: { status: 'pending' }, exceptions: [], files: {} } };
}

async function failBundle(bundle, error) {
  await writeJson(path.join(bundle.out, 'failure.json'), { status: 'failed', message: redact(error.message) });
}

async function finishBundle(bundle) {
  if (!bundle.manifest.packages.length) throw new Error('No publishable packages collected');
  for (const file of await listFiles(bundle.out)) bundle.manifest.files[file] = await fileHash(path.join(bundle.out, file));
  bundle.manifest.status = 'complete';
  await writeJson(path.join(bundle.out, 'manifest.json'), bundle.manifest, { exclusive: true });
  const files = { ...bundle.manifest.files, 'manifest.json': await fileHash(path.join(bundle.out, 'manifest.json')) };
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(bundle.out, 'checksums.sha256'), Object.keys(files).sort().map(file => `${files[file]}  ${file}`).join('\n') + '\n', { flag: 'wx' });
  return { ...await verifyBundle(bundle.out), stats: { ...bundle.stats } };
}

async function addResources(bundle, configFile) {
  if (!configFile) return;
  const config = await readJson(configFile);
  if (!Array.isArray(config.resources)) throw new Error('resources config requires a resources array');
  const ids = new Set();
  for (const resource of config.resources) {
    if (!/^[A-Za-z0-9_-]+$/.test(resource.id) || ids.has(resource.id) || typeof resource.source !== 'string' || typeof resource.instructions !== 'string' || !resource.instructions.trim() || !Array.isArray(resource.targets) || !resource.targets.length) throw new Error('Invalid resource id/source/instructions/targets');
    ids.add(resource.id);
    const source = path.resolve(path.dirname(configFile), resource.source);
    const destination = path.join(bundle.out, 'resources', resource.id);
    const info = await stat(source);
    // Symlinks are rejected by listFiles; don't copy a cache whose layout wasn't explicitly checked.
    if (info.isDirectory()) { await listFiles(source); await cp(source, destination, { recursive: true, dereference: false, errorOnExist: true, force: false }); }
    else if (info.isFile()) { await mkdir(destination, { recursive: true }); await cp(source, path.join(destination, path.basename(source)), { errorOnExist: true, force: false }); }
    else throw new Error('Resource must be a file or directory');
    const files = (await listFiles(destination)).map(file => `resources/${resource.id}/${file}`);
    if (!files.length) throw new Error(`Empty resource: ${resource.id}`);
    bundle.manifest.resources.push({ id: resource.id, targets: resource.targets, instructions: resource.instructions, files });
  }
  if (config.review?.status === 'reviewed' && Array.isArray(config.review.evidence) && config.review.evidence.length && config.review.evidence.every(item => typeof item === 'string' && item.trim())) {
    bundle.manifest.resourceReview = { status: 'reviewed', evidence: config.review.evidence };
  }
}

function assertSourceUrl(value, registry, allowHosts) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('Tarball source must use HTTPS without embedded credentials (localhost HTTP is allowed)');
  if (![new URL(registry).host, ...allowHosts].includes(url.host)) throw new Error(`Unapproved tarball host: ${url.host}; declare --allow-host explicitly`);
  return url.href;
}

async function addOriginal(bundle, entry, { registry, allowHosts = [], snapshots, context }) {
  const progress = () => bundle.report({ phase: 'download', completed: bundle.manifest.packages.length, total: bundle.stats.total, name: entry.name, version: entry.version });
  progress();
  const metadata = await npmJson(['view', packageSpec(entry)], { registry, packageName: entry.name });
  validateIdentity(metadata);
  if (packageSpec(metadata) !== packageSpec(entry)) throw new Error('Registry returned a different package identity');
  const url = assertSourceUrl(entry.resolved || metadata.dist?.tarball, registry, allowHosts);
  const sourceIntegrity = entry.integrity || metadata.dist?.integrity || (metadata.dist?.shasum ? `sha1-${Buffer.from(metadata.dist.shasum, 'hex').toString('base64')}` : null);
  if (!sourceIntegrity) throw new Error(`No trusted source integrity: ${packageSpec(entry)}`);
  const existing = bundle.manifest.packages.find(pkg => packageSpec(pkg) === packageSpec(entry));
  if (existing) {
    await assertIntegrity(path.join(bundle.out, existing.file), sourceIntegrity);
    existing.instances.push({ context, location: entry.location || entry.name });
    bundle.stats.reused++;
    progress();
    return;
  }
  const id = String(bundle.manifest.packages.length + 1).padStart(6, '0');
  const scratch = await mkdtemp(path.join(tmpdir(), 'offline-npm-pack-'));
  try {
    const artifact = await packArtifact(url, scratch, { registry, packageName: entry.name });
    if (packageSpec(artifact.packageJson) !== packageSpec(entry)) throw new Error('Downloaded tarball identity differs from lockfile');
    await assertIntegrity(artifact.file, sourceIntegrity);
    await mkdir(path.join(bundle.out, 'packages'), { recursive: true });
    const file = `packages/${id}.tgz`;
    await rename(artifact.file, path.join(bundle.out, file));
    const metadataFile = `metadata/${id}.json`;
    const safeMetadata = { name: metadata.name, version: metadata.version, dependencies: metadata.dependencies, optionalDependencies: metadata.optionalDependencies, peerDependencies: metadata.peerDependencies, deprecated: metadata.deprecated, scripts: artifact.packageJson.scripts, dist: { tarball: publicUrl(url), integrity: sourceIntegrity }, sourceTags: metadata['dist-tags'] || {} };
    await writeJson(path.join(bundle.out, metadataFile), safeMetadata);
    const pkg = { id, artifactKind: 'registry-original', name: entry.name, version: entry.version, file, sha256: artifact.sha256, artifactIntegrity: artifact.artifactIntegrity, sourceIntegrity, sourceRegistry: registry, sourceTarball: publicUrl(url), metadataFile, instances: [{ context, location: entry.location || entry.name }] };
    bundle.manifest.packages.push(pkg);
    bundle.stats.downloaded++;
    bundle.stats.downloadBytes += artifact.size;
    if (!snapshots.has(pkg.name)) {
      const tags = await npmJson(['view', packageSpec(pkg), 'dist-tags'], { registry, packageName: pkg.name });
      if (!tags || typeof tags !== 'object' || Array.isArray(tags) || Object.values(tags).some(value => typeof value !== 'string')) throw new Error(`Invalid tags snapshot: ${pkg.name}`);
      snapshots.set(pkg.name, tags);
    }
    progress();
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export async function collect({ out, project, specs = [], registry = 'https://registry.npmjs.org/', allowHosts = [], resourcesFile, installFlags = [], onProgress }) {
  if ((!project && !specs.length) || (project && specs.length)) throw new Error('Use either --project or one/more --package inputs');
  installFlags = validateInstallFlags(installFlags);
  specs.forEach(registrySpec);
  registry = normalizeRegistry(registry);
  const bundle = await newBundle(out, 'mirror', onProgress);
  const work = await mkdtemp(path.join(tmpdir(), 'offline-npm-resolve-'));
  const snapshots = new Map();
  try {
    const inputs = [];
    bundle.report({ phase: 'resolve', completed: 0, total: project ? 1 : specs.length });
    if (project) {
      project = path.resolve(project);
      const packageJson = await readJson(path.join(project, 'package.json'));
      let lockName = 'npm-shrinkwrap.json';
      try { await stat(path.join(project, lockName)); } catch (error) { if (error.code !== 'ENOENT') throw error; lockName = 'package-lock.json'; }
      const lock = await readJson(path.join(project, lockName));
      const parsed = entriesFromLock(lock); // Block Git/link inputs before running any resolver.
      if (packageJson.workspaces) throw new Error('Workspace source migration is not automated in v1');
      await writeJson(path.join(work, 'package.json'), packageJson);
      await writeJson(path.join(work, lockName), lock);
      await npmCommand(['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund', ...installFlags], { cwd: work, registry });
      bundle.manifest.roots.push({ context: 'project', name: packageJson.name, version: packageJson.version });
      inputs.push({ packageJson, lock, lockName, parsed, context: 'project' });
      bundle.report({ phase: 'resolve', completed: 1, total: 1 });
    } else {
      for (let i = 0; i < specs.length; i++) {
        bundle.report({ phase: 'resolve', completed: i, total: specs.length, name: registrySpec(specs[i]) });
        const cwd = path.join(work, String(i));
        await mkdir(cwd);
        await writeJson(path.join(cwd, 'package.json'), { name: 'offline-npm-resolution', version: '1.0.0', private: true });
        await npmCommand(['install', specs[i], '--package-lock-only', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund', ...installFlags], { cwd, registry, packageName: registrySpec(specs[i]) });
        const packageJson = await readJson(path.join(cwd, 'package.json'));
        const lock = await readJson(path.join(cwd, 'package-lock.json'));
        inputs.push({ packageJson, lock, lockName: 'package-lock.json', parsed: entriesFromLock(lock), context: `root-${i + 1}` });
        bundle.manifest.roots.push({ requested: specs[i], resolved: packageJson.dependencies });
        bundle.report({ phase: 'resolve', completed: i + 1, total: specs.length });
      }
    }
    bundle.stats.total = new Set(inputs.flatMap(input => input.parsed.entries.map(packageSpec))).size;
    for (const input of inputs) {
      const prefix = `inputs/${input.context}`;
      await writeJson(path.join(bundle.out, prefix, 'package.json'), input.packageJson);
      await writeJson(path.join(bundle.out, prefix, input.lockName), input.lock);
      bundle.manifest.inputs.push({ context: input.context, packageJson: `${prefix}/package.json`, lock: `${prefix}/${input.lockName}`, installFlags });
      bundle.manifest.exceptions.push(...input.parsed.skipped.map(item => ({ ...item, context: input.context })));
      for (const entry of input.parsed.entries) await addOriginal(bundle, entry, { registry, allowHosts, snapshots, context: input.context });
    }
    bundle.manifest.tagPlan = tagPlanFromSnapshots(snapshots, bundle.manifest.packages);
    await addResources(bundle, resourcesFile);
    return await finishBundle(bundle);
  } catch (error) { await failBundle(bundle, error); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}

export async function recover({ modules, out, registry, repack = false, allowHosts = [], allowLinkRoots = [], resourcesFile, onProgress }) {
  const { inventoryModules, stageInstance } = await import('./recovery.mjs');
  if (!repack && !registry) throw new Error('Recovery requires --registry for originals, or explicit --repack for an isolated recovery repository');
  onProgress?.({ phase: 'inventory', completed: 0, total: 0 });
  const inventory = await inventoryModules(modules, { allowLinkRoots });
  onProgress?.({ phase: 'inventory', completed: inventory.instances.length, total: inventory.instances.length });
  if (inventory.issues.length) throw new Error(`Recovery blocked: ${inventory.issues.map(item => `${item.code}: ${item.message}`).join('; ')}`);
  const bundle = await newBundle(out, repack ? 'recovery' : 'mirror', onProgress);
  bundle.stats.total = new Set(inventory.instances.map(packageSpec)).size;
  const work = await mkdtemp(path.join(tmpdir(), 'offline-npm-recover-'));
  try {
    await writeJson(path.join(bundle.out, 'inputs', 'inventory.json'), inventory);
    bundle.manifest.inputs.push({ inventory: 'inputs/inventory.json', layout: inventory.layout });
    const snapshots = new Map();
    for (const instance of inventory.instances) {
      if (!repack) {
        await addOriginal(bundle, instance, { registry: normalizeRegistry(registry), allowHosts, snapshots, context: 'installed-inventory' });
        continue;
      }
      const progress = () => bundle.report({ phase: 'repack', completed: bundle.manifest.packages.length, total: bundle.stats.total, name: instance.name, version: instance.version });
      progress();
      if (bundle.manifest.packages.some(pkg => packageSpec(pkg) === packageSpec(instance))) { bundle.stats.reused++; progress(); continue; }
      const id = String(bundle.manifest.packages.length + 1).padStart(6, '0');
      const stage = path.join(work, id);
      await stageInstance(instance, stage);
      const artifact = await packArtifact(stage, path.join(work, 'packed', id), { cwd: work });
      await mkdir(path.join(bundle.out, 'packages'), { recursive: true });
      const file = `packages/${id}.tgz`;
      await rename(artifact.file, path.join(bundle.out, file));
      const metadataFile = `metadata/${id}.json`;
      await writeJson(path.join(bundle.out, metadataFile), { name: instance.name, version: instance.version, source: instance.path, locations: instance.locations, contentHash: instance.contentHash, scripts: artifact.packageJson.scripts, sourceTags: null, sourceIntegrity: null });
      bundle.manifest.packages.push({ id, name: instance.name, version: instance.version, artifactKind: 'installed-repack', file, metadataFile, sha256: artifact.sha256, artifactIntegrity: artifact.artifactIntegrity, sourceIntegrity: null });
      bundle.stats.repacked++;
      bundle.stats.packedBytes += artifact.size;
      progress();
    }
    bundle.manifest.tagPlan = tagPlanFromSnapshots(snapshots, bundle.manifest.packages);
    await addResources(bundle, resourcesFile);
    return await finishBundle(bundle);
  } catch (error) { await failBundle(bundle, error); throw error; }
  finally { await rm(work, { recursive: true, force: true }); }
}
