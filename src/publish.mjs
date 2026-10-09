import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as common from './common.mjs';

function adapters(options, operation) {
  const stats = { total: 0, uploaded: 0, reused: 0, downloaded: 0, downloadBytes: 0, uploadBytes: 0 };
  let current = { phase: operation, completed: 0, total: 0 };
  return {
    ...common, ...options.adapter, operation, stats,
    progress(event = {}) { current = { ...current, ...event }; options.onProgress?.({ ...stats, ...current }); },
  };
}
const failure = (message, cause) => new Error(`${message}${/^[A-Z][A-Z0-9_]+$/.test(cause?.npmCode ?? cause?.code ?? '') ? ` (${cause.npmCode ?? cause.code})` : ''}`);
const missing = error => (error?.npmCode ?? error?.code) === 'E404';
const valueAt = (tags, tag) => Object.hasOwn(tags, tag) ? tags[tag] : null;
const tagValid = tag => /^[a-z][a-z0-9._-]*$/i.test(tag) && !/^v/i.test(tag) && !/^x$/i.test(tag);

function validate(manifest, recovery) {
  if (manifest.packages.some(pkg => pkg.artifactKind === 'installed-repack') && !recovery) throw failure('Recovered artifacts require --recovery and a dedicated recovery registry');
  const names = new Map();
  for (const pkg of manifest.packages) {
    if (!names.has(pkg.name)) names.set(pkg.name, new Set());
    names.get(pkg.name).add(pkg.version);
  }
  const seen = new Set();
  for (const plan of manifest.tagPlan ?? []) {
    for (const [tag, version] of Object.entries(plan.set ?? {})) {
      if (!tagValid(tag)) throw failure(`Invalid or ambiguous dist-tag: ${tag}`);
      if (!names.get(plan.name)?.has(version)) throw failure(`Tag target is outside the bundle: ${plan.name}@${version}`);
      const key = `${plan.name}:${tag}`;
      if (seen.has(key)) throw failure(`Duplicate tag plan: ${key}`);
      seen.add(key);
    }
  }
}

async function query(api, args, registry, name) {
  try { return await api.npmJson(args, { registry, packageName: name }); }
  catch (error) { if (missing(error)) return null; throw failure(`Registry query failed for ${name}`, error); }
}

async function tagsFor(api, name, registry, version) {
  if (!version) {
    const versions = await query(api, ['view', `${name}@*`, 'version', '--json'], registry, name);
    if (versions === null) return {};
    const values = Array.isArray(versions) ? versions : [versions];
    if (!values.length || values.some(value => typeof value !== 'string' || !value)) throw failure(`Cannot determine an existing version for ${name}`);
    version = values.at(-1);
  }
  const tags = await query(api, ['view', common.packageSpec({ name, version }), 'dist-tags', '--json'], registry, name);
  if (!tags || typeof tags !== 'object' || Array.isArray(tags) || Object.values(tags).some(value => typeof value !== 'string')) throw failure(`Invalid dist-tag snapshot for ${name}`);
  return tags;
}

async function remoteArtifact(api, pkg, registry) {
  const dist = await query(api, ['view', common.packageSpec(pkg), 'dist', '--json'], registry, pkg.name);
  if (dist === null) return false;
  if (!dist || typeof dist !== 'object' || typeof dist.tarball !== 'string') throw failure(`Invalid remote metadata for ${common.packageSpec(pkg)}`);
  let tarball;
  try { tarball = new URL(dist.tarball); } catch { throw failure(`Invalid remote tarball URL for ${common.packageSpec(pkg)}`); }
  if (tarball.origin !== new URL(registry).origin || tarball.username || tarball.password || tarball.hash) throw failure(`Remote tarball must use the target registry origin for ${common.packageSpec(pkg)}`);
  const scratch = await mkdirScratch();
  try {
    api.progress({ name: pkg.name, version: pkg.version });
    const artifact = await api.packArtifact(tarball.href, scratch, { registry, packageName: pkg.name });
    if (artifact.sha256 !== pkg.sha256 || artifact.packageJson.name !== pkg.name || artifact.packageJson.version !== pkg.version) throw failure(`Artifact conflict for ${common.packageSpec(pkg)}`);
    api.stats.downloaded++;
    api.stats.downloadBytes += artifact.size ?? (await stat(artifact.file)).size;
    api.progress();
    return true;
  } catch (error) {
    if (error.message?.startsWith('Artifact conflict')) throw error;
    throw failure(`Cannot verify remote artifact for ${common.packageSpec(pkg)}`, error);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function mkdirScratch() {
  const { mkdtemp } = await import('node:fs/promises');
  return mkdtemp(path.join(os.tmpdir(), 'offline-npm-remote-'));
}

/** Read-only preflight; downloads existing artifacts only to compare their bytes. */
async function inspectBundle(bundle, options, api) {
  const registry = common.normalizeRegistry(options.registry);
  const readRegistry = common.normalizeRegistry(options.readRegistry ?? registry);
  const { manifest, manifestDigest } = await common.verifyBundle(bundle);
  validate(manifest, options.recovery === true);
  api.stats.total = manifest.packages.length;
  api.progress({ phase: 'plan', completed: 0, total: manifest.packages.length, name: undefined, version: undefined });
  const packages = [];
  const existing = new Map();
  for (const pkg of manifest.packages) {
    api.progress({ name: pkg.name, version: pkg.version });
    const exists = await remoteArtifact(api, pkg, registry);
    packages.push({ id: pkg.id, name: pkg.name, version: pkg.version, action: exists ? 'reuse' : 'publish' });
    if (exists) {
      existing.set(pkg.name, pkg.version);
      if (api.operation === 'plan') api.stats.reused++;
    }
    api.progress({ completed: packages.length });
  }
  const tagSnapshot = {};
  for (const name of new Set(manifest.packages.map(pkg => pkg.name))) tagSnapshot[name] = await tagsFor(api, name, registry, existing.get(name));
  const tagChanges = (manifest.tagPlan ?? []).flatMap(plan => Object.entries(plan.set ?? {}).map(([tag, version]) => {
    const before = valueAt(tagSnapshot[plan.name], tag);
    return { name: plan.name, tag, before, after: version, conflict: before !== null && before !== version };
  }));
  return { schemaVersion: 1, registry, readRegistry, recovery: options.recovery === true, manifestDigest, manifest, packages, tagSnapshot, tagChanges };
}

export async function planImport(bundle, options = {}) {
  const api = adapters(options, 'plan');
  return { ...await inspectBundle(bundle, options, api), stats: { ...api.stats } };
}

async function withRun(runDir, callback) {
  if (!runDir) throw failure('A run directory is required');
  const dir = path.resolve(runDir);
  await mkdir(path.dirname(dir), { recursive: true });
  let created = false;
  try { await mkdir(dir); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let lock;
  // ponytail: this lock covers one local run; use a registry maintenance window / single writer across runs and machines.
  try { lock = await open(path.join(dir, '.lock'), 'wx', 0o600); }
  catch { throw failure('Run is locked; inspect the active process before removing a stale .lock'); }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await callback(dir, created);
  } finally { await lock.close(); await rm(path.join(dir, '.lock'), { force: true }); }
}

async function loadRun(dir) {
  let identity, state;
  try {
    identity = await common.readJson(path.join(dir, 'identity.json'));
    state = await common.readJson(path.join(dir, 'state.json'));
  } catch { throw failure('Run has no complete original identity/state; preserve it and use a new run directory'); }
  if (identity.schemaVersion !== 1 || state.schemaVersion !== 1 || identity.runId !== state.runId || await common.fileHash(path.join(dir, 'identity.json')) !== state.identityDigest) throw failure('Run identity or original tag snapshot changed');
  validate(identity.manifest, identity.recovery);
  return { identity, state };
}

const persist = (dir, state) => common.writeJson(path.join(dir, 'state.json'), state);
const result = (identity, state, api) => ({ ...state, registry: identity.registry, readRegistry: identity.readRegistry, recovery: identity.recovery, manifestDigest: identity.manifestDigest, temporaryTag: identity.temporaryTag, stats: { ...api.stats } });

async function verifyRunBundle(identity) {
  const verified = await common.verifyBundle(identity.bundle);
  if (verified.manifestDigest !== identity.manifestDigest) throw failure('Bundle changed since this run started');
}

async function verifyAll(api, identity, state, dir) {
  api.stats.total = identity.manifest.packages.length;
  api.progress({ phase: api.operation, completed: 0, total: api.stats.total, name: undefined, version: undefined });
  let completed = 0;
  for (const pkg of identity.manifest.packages) {
    api.progress({ name: pkg.name, version: pkg.version });
    if (!await remoteArtifact(api, pkg, identity.registry)) throw failure(`Required version is missing: ${common.packageSpec(pkg)}`);
    state.versions[pkg.id] = { status: 'validated', sha256: pkg.sha256 };
    api.stats.reused++;
    api.progress({ completed: ++completed });
  }
  await persist(dir, state);
}

/** Publish versions with a run-owned staging tag. Formal tags require promoteRun. */
export async function importBundle(bundle, options = {}) {
  const absoluteBundle = await common.canonicalPath(bundle);
  const registry = common.normalizeRegistry(options.registry);
  const readRegistry = common.normalizeRegistry(options.readRegistry ?? registry);
  const relativeRun = options.runDir && path.relative(absoluteBundle, await common.canonicalPath(options.runDir));
  if (options.runDir && (relativeRun === '' || (!path.isAbsolute(relativeRun) && relativeRun !== '..' && !relativeRun.startsWith(`..${path.sep}`)))) throw failure('Run directory must be outside the frozen bundle');
  return withRun(options.runDir, async (dir, created) => {
    const api = adapters(options, 'import');
    let identity, state;
    if (created) {
      const plan = await inspectBundle(absoluteBundle, options, api);
      // npm redacts UUID-shaped text even in JSON output, so the tag suffix must not have UUID punctuation.
      identity = { schemaVersion: 1, runId: randomUUID(), createdAt: new Date().toISOString(), bundle: absoluteBundle, registry, readRegistry, recovery: options.recovery === true, manifestDigest: plan.manifestDigest, manifest: plan.manifest, tagSnapshot: plan.tagSnapshot, temporaryTag: `offline-import-${randomUUID().replaceAll('-', '')}`, writerConstraint: 'Registry changes require one writer across all runs and machines.' };
      await common.writeJson(path.join(dir, 'identity.json'), identity, { exclusive: true });
      state = { schemaVersion: 1, runId: identity.runId, identityDigest: await common.fileHash(path.join(dir, 'identity.json')), phase: 'importing', versions: {}, temporaryTags: {}, tagIntents: [], attempts: 0 };
      await common.writeJson(path.join(dir, 'state.json'), state, { exclusive: true });
    } else {
      ({ identity, state } = await loadRun(dir));
      if (identity.bundle !== absoluteBundle || identity.registry !== registry || identity.readRegistry !== readRegistry || identity.recovery !== (options.recovery === true)) throw failure('Resume must use the same bundle, write/read registry and recovery mode');
      await verifyRunBundle(identity);
      if (['rolling-back', 'rollback-pending', 'rolled-back'].includes(state.phase)) throw failure('Rollback run is closed to import; finish rollback or use a new run directory');
      if (state.phase === 'promoting') throw failure('Promotion was interrupted; resume promote or rollback');
      if (state.phase === 'promoted') {
        await verifyAll(api, identity, state, dir);
        return result(identity, state, api);
      }
    }
    state.attempts++;
    await persist(dir, state);
    api.stats.total = identity.manifest.packages.length;
    api.progress({ phase: 'import', completed: 0, total: api.stats.total, name: undefined, version: undefined });
    let completed = 0;
    try {
      for (const pkg of identity.manifest.packages) {
        api.progress({ name: pkg.name, version: pkg.version });
        if (!await remoteArtifact(api, pkg, registry)) {
          const tags = await tagsFor(api, pkg.name, registry);
          const current = valueAt(tags, identity.temporaryTag);
          const owned = state.temporaryTags[pkg.name]?.versions ?? [];
          if (current !== null && !owned.includes(current)) throw failure(`Temporary tag collision for ${pkg.name}`);
          state.temporaryTags[pkg.name] = { versions: [...new Set([...owned, pkg.version])], status: 'pending' };
          state.versions[pkg.id] = { status: 'publishing', sha256: pkg.sha256 };
          await persist(dir, state);
          const file = await common.safePath(absoluteBundle, pkg.file);
          const uploadBytes = (await stat(file)).size;
          let publishError;
          api.progress();
          try { await api.npmCommand(['publish', file, '--ignore-scripts', '--tag', identity.temporaryTag, '--provenance=false', '--json'], { registry, packageName: pkg.name, cwd: dir }); }
          catch (error) { publishError = error; }
          if (!await remoteArtifact(api, pkg, registry)) throw failure(`Publishing failed for ${common.packageSpec(pkg)}`, publishError);
          api.stats.uploaded++;
          api.stats.uploadBytes += uploadBytes;
        } else api.stats.reused++;
        state.versions[pkg.id] = { status: 'validated', sha256: pkg.sha256 };
        await persist(dir, state);
        api.progress({ completed: ++completed });
      }
      if (!['promoted', 'promotion-failed'].includes(state.phase)) state.phase = 'versions-ready';
      delete state.error;
      await persist(dir, state);
      return result(identity, state, api);
    } catch (error) {
      state.phase = 'import-failed'; state.error = failure('Import stopped', error).message;
      await persist(dir, state);
      throw error;
    }
  });
}

async function currentTags(api, identity, name) {
  const pkg = identity.manifest.packages.find(pkg => pkg.name === name);
  return tagsFor(api, name, identity.registry, pkg.version);
}

async function writeTag(api, identity, name, tag, version) {
  const args = version === null ? ['dist-tag', 'rm', name, tag] : ['dist-tag', 'add', common.packageSpec({ name, version }), tag];
  api.progress({ name, version: version ?? undefined });
  try { await api.npmCommand(args, { registry: identity.registry, packageName: name }); }
  catch (error) { throw failure(`Tag write failed for ${name}:${tag}`, error); }
}

async function restoreTags(api, identity, state, dir) {
  const pending = [];
  let completed = 0;
  api.progress({ phase: 'rollback', completed, total: state.tagIntents.length, name: undefined, version: undefined });
  for (const intent of [...state.tagIntents].reverse()) {
    try {
      api.progress({ name: intent.name, version: intent.before ?? undefined });
      const current = valueAt(await currentTags(api, identity, intent.name), intent.tag);
      if (current === intent.before) { intent.status = 'reverted'; await persist(dir, state); api.progress({ completed: ++completed }); continue; }
      if (current !== intent.after) { intent.status = 'rollback-conflict'; pending.push(`${intent.name}:${intent.tag}`); await persist(dir, state); continue; }
      intent.status = 'rollback-pending'; await persist(dir, state);
      await writeTag(api, identity, intent.name, intent.tag, intent.before);
      if (valueAt(await currentTags(api, identity, intent.name), intent.tag) !== intent.before) throw failure('Rollback verification failed');
      intent.status = 'reverted'; await persist(dir, state);
      api.progress({ completed: ++completed });
    } catch { pending.push(`${intent.name}:${intent.tag}`); }
  }
  state.rollbackPending = pending;
  await persist(dir, state);
  return pending;
}

async function cleanupTemporary(api, identity, state, dir) {
  const pending = [];
  let completed = 0;
  api.progress({ phase: 'cleanup', completed, total: Object.keys(state.temporaryTags).length, name: undefined, version: undefined });
  for (const [name, owner] of Object.entries(state.temporaryTags)) {
    try {
      api.progress({ name, version: undefined });
      const current = valueAt(await currentTags(api, identity, name), identity.temporaryTag);
      if (current === null) { owner.status = 'removed'; await persist(dir, state); api.progress({ completed: ++completed }); continue; }
      if (!owner.versions.includes(current)) { owner.status = 'cleanup-conflict'; pending.push(name); await persist(dir, state); continue; }
      owner.status = 'cleanup-pending'; await persist(dir, state);
      await writeTag(api, identity, name, identity.temporaryTag, null);
      if (valueAt(await currentTags(api, identity, name), identity.temporaryTag) !== null) throw failure('Temporary tag cleanup verification failed');
      owner.status = 'removed'; await persist(dir, state);
      api.progress({ completed: ++completed });
    } catch { pending.push(name); }
  }
  state.cleanupPending = pending;
  await persist(dir, state);
}

async function acceptance(identity, file) {
  if (!file) throw failure('An external acceptance record is required before promotion');
  const record = await common.readJson(file);
  const readRegistry = common.normalizeRegistry(record.readRegistry);
  if (record.status !== 'passed' || record.manifestDigest !== identity.manifestDigest || common.normalizeRegistry(record.writeRegistry) !== identity.registry || readRegistry !== identity.readRegistry || !isDeepStrictEqual(record.targets, identity.manifest.targets) || record.resourceReview !== 'reviewed' || identity.manifest.resourceReview?.status !== 'reviewed' || !Array.isArray(record.evidence) || !record.evidence.length || record.evidence.some(value => typeof value !== 'string' || !value.trim())) throw failure('Acceptance record must match this bundle, write/read registry, targets and completed resource review');
  return { ...record, readRegistry, file: path.resolve(file), sha256: await common.fileHash(file) };
}

/** Apply only the frozen formal tag plan after a matching real-environment acceptance record. */
export async function promoteRun(runDir, options = {}) {
  return withRun(runDir, async (dir, created) => {
    if (created) throw failure('No import run exists');
    const { identity, state } = await loadRun(dir);
    if (!['versions-ready', 'promoting', 'promotion-failed', 'promoted'].includes(state.phase)) throw failure('Import has not reached versions-ready');
    await verifyRunBundle(identity);
    const accepted = await acceptance(identity, options.acceptanceFile);
    const api = adapters(options, 'promote');
    await verifyAll(api, identity, state, dir);
    const totalTags = identity.manifest.tagPlan.reduce((total, plan) => total + Object.keys(plan.set).length, 0);
    let completedTags = 0;
    api.progress({ phase: 'promote-tags', completed: completedTags, total: totalTags, name: undefined, version: undefined });
    if (state.phase === 'promoted') {
      for (const plan of identity.manifest.tagPlan ?? []) {
        api.progress({ name: plan.name, version: undefined });
        const tags = await currentTags(api, identity, plan.name);
        if (Object.entries(plan.set ?? {}).some(([tag, version]) => valueAt(tags, tag) !== version)) throw failure(`Promoted tags changed outside this run: ${plan.name}`);
        api.progress({ completed: completedTags += Object.keys(plan.set).length });
      }
      await cleanupTemporary(api, identity, state, dir);
      return result(identity, state, api);
    }
    state.acceptance = accepted;
    state.phase = 'promoting'; await persist(dir, state);
    try {
      const changes = [];
      for (const plan of identity.manifest.tagPlan ?? []) {
        api.progress({ name: plan.name, version: undefined });
        const tags = await currentTags(api, identity, plan.name);
        for (const [tag, after] of Object.entries(plan.set ?? {})) {
          const before = valueAt(identity.tagSnapshot[plan.name], tag);
          const current = valueAt(tags, tag);
          const intent = state.tagIntents.find(intent => intent.name === plan.name && intent.tag === tag);
          if (current === after) { if (intent && intent.status !== 'reverted') intent.status = 'applied'; api.progress({ completed: ++completedTags, version: after }); continue; }
          if (current !== before) throw failure(`Tag changed outside this run: ${plan.name}:${tag}`);
          if (before !== null && before !== after && !options.overwriteTags) throw failure(`Existing tag requires --overwrite-tags: ${plan.name}:${tag}`);
          changes.push(intent ?? { name: plan.name, tag, before, after, status: 'pending' });
        }
      }
      for (const intent of changes) {
        api.progress({ name: intent.name, version: intent.after });
        const current = valueAt(await currentTags(api, identity, intent.name), intent.tag);
        if (current !== intent.before && current !== intent.after) throw failure(`Tag changed outside this run: ${intent.name}:${intent.tag}`);
        if (!state.tagIntents.includes(intent)) state.tagIntents.push(intent);
        intent.status = 'pending'; await persist(dir, state);
        if (current !== intent.after) await writeTag(api, identity, intent.name, intent.tag, intent.after);
        if (valueAt(await currentTags(api, identity, intent.name), intent.tag) !== intent.after) throw failure(`Tag verification failed for ${intent.name}:${intent.tag}`);
        intent.status = 'applied'; await persist(dir, state);
        api.progress({ completed: ++completedTags });
      }
    } catch (error) {
      await restoreTags(api, identity, state, dir);
      state.phase = 'promotion-failed'; state.error = failure('Promotion stopped', error).message;
      await persist(dir, state);
      throw error;
    }
    state.phase = 'promoted'; delete state.error; delete state.rollbackPending;
    await persist(dir, state);
    await cleanupTemporary(api, identity, state, dir);
    return result(identity, state, api);
  });
}

/** Conditional, repeatable tag rollback; uploaded package versions are retained. */
export async function rollbackRun(runDir, options = {}) {
  return withRun(runDir, async (dir, created) => {
    if (created) throw failure('No import run exists');
    const { identity, state } = await loadRun(dir);
    const api = adapters(options, 'rollback');
    api.stats.total = identity.manifest.packages.length;
    state.phase = 'rolling-back'; await persist(dir, state);
    const pending = await restoreTags(api, identity, state, dir);
    await cleanupTemporary(api, identity, state, dir);
    state.phase = pending.length || state.cleanupPending.length ? 'rollback-pending' : 'rolled-back';
    await persist(dir, state);
    return result(identity, state, api);
  });
}
