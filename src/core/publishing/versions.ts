// 文件职责：逐版本禁钩子上传、回读确认、处理丢失响应并记录续跑进度。
import { stat } from 'node:fs/promises';
import type { RunIdentity, RunState, BundlePackage } from '../types.js';
import { failure, valueAt, type Api } from './context.js';
import { remoteArtifact, tagsFor } from './registry.js';
import { persist, result } from './run.js';
import * as common from '../../lib/index.js';

export async function verifyAll(api: Api, identity: RunIdentity, state: RunState, dir: string) {
  api.stats.total = identity.manifest.packages.length;
  api.progress({
    phase: api.operation,
    completed: 0,
    total: api.stats.total,
    name: undefined,
    version: undefined,
  });
  let completed = 0;
  for (const pkg of identity.manifest.packages) {
    api.progress({ name: pkg.name, version: pkg.version });
    if (!(await remoteArtifact(api, pkg, identity.registry)))
      throw failure(`Required version is missing: ${common.packageSpec(pkg)}`);
    state.versions[pkg.id] = { status: 'validated', sha256: pkg.sha256 };
    api.stats.reused++;
    api.progress({ completed: ++completed });
  }
  await persist(dir, state);
}

// 发布前持久化临时 tag 所有权；响应丢失时通过远端字节确认是否已成功。
async function importVersion(
  api: Api,
  identity: RunIdentity,
  state: RunState,
  dir: string,
  pkg: BundlePackage,
) {
  const { registry, bundle: absoluteBundle } = identity;
  if (!(await remoteArtifact(api, pkg, registry))) {
    const tags = await tagsFor(api, pkg.name, registry);
    const current = valueAt(tags, identity.temporaryTag);
    const owned = state.temporaryTags[pkg.name]?.versions ?? [];
    if (current !== null && !owned.includes(current))
      throw failure(`Temporary tag collision for ${pkg.name}`);
    state.temporaryTags[pkg.name] = {
      versions: [...new Set([...owned, pkg.version])],
      status: 'pending',
    };
    state.versions[pkg.id] = { status: 'publishing', sha256: pkg.sha256 };
    await persist(dir, state);
    const file = await common.safePath(absoluteBundle, pkg.file);
    const uploadBytes = (await stat(file)).size;
    let publishError;
    api.progress();
    try {
      await api.npmCommand(
        [
          'publish',
          file,
          '--ignore-scripts',
          '--tag',
          identity.temporaryTag,
          '--provenance=false',
          '--json',
        ],
        { registry, packageName: pkg.name, cwd: dir },
      );
    } catch (error) {
      publishError = error;
    }
    if (!(await remoteArtifact(api, pkg, registry)))
      throw failure(`Publishing failed for ${common.packageSpec(pkg)}`, publishError);
    api.stats.uploaded++;
    api.stats.uploadBytes += uploadBytes;
  } else api.stats.reused++;
}

export async function importVersions(
  api: Api,
  identity: RunIdentity,
  state: RunState,
  dir: string,
) {
  state.attempts++;
  await persist(dir, state);
  api.stats.total = identity.manifest.packages.length;
  api.progress({
    phase: 'import',
    completed: 0,
    total: api.stats.total,
    name: undefined,
    version: undefined,
  });
  let completed = 0;
  try {
    for (const pkg of identity.manifest.packages) {
      api.progress({ name: pkg.name, version: pkg.version });
      await importVersion(api, identity, state, dir, pkg);
      state.versions[pkg.id] = { status: 'validated', sha256: pkg.sha256 };
      await persist(dir, state);
      api.progress({ completed: ++completed });
    }
    if (!['promoted', 'promotion-failed'].includes(state.phase)) state.phase = 'versions-ready';
    delete state.error;
    await persist(dir, state);
    return result(identity, state, api);
  } catch (error) {
    state.phase = 'import-failed';
    state.error = failure('Import stopped', error).message;
    await persist(dir, state);
    throw error;
  }
}
