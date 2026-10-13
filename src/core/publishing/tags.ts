// 文件职责：按快照条件回滚正式 tag，按所有权清理临时 tag，并保留冲突。
import type { RunIdentity, RunState } from '../types.js';
import { failure, valueAt, type Api } from './context.js';
import { tagsFor } from './registry.js';
import { persist } from './run.js';
import * as common from '../../lib/index.js';

export async function currentTags(api: Api, identity: RunIdentity, name: string) {
  const pkg = identity.manifest.packages.find((pkg) => pkg.name === name);
  return tagsFor(api, name, identity.registry, pkg?.version);
}

export async function writeTag(
  api: Api,
  identity: RunIdentity,
  name: string,
  tag: string,
  version: string | null,
) {
  const args =
    version === null
      ? ['dist-tag', 'rm', name, tag]
      : ['dist-tag', 'add', common.packageSpec({ name, version }), tag];
  api.progress({ name, version: version ?? undefined });
  try {
    await api.npmCommand(args, { registry: identity.registry, packageName: name });
  } catch (error) {
    throw failure(`Tag write failed for ${name}:${tag}`, error);
  }
}

export async function restoreTags(api: Api, identity: RunIdentity, state: RunState, dir: string) {
  const pending = [];
  let completed = 0;
  api.progress({
    phase: 'rollback',
    completed,
    total: state.tagIntents.length,
    name: undefined,
    version: undefined,
  });
  for (const intent of [...state.tagIntents].reverse()) {
    try {
      api.progress({ name: intent.name, version: intent.before ?? undefined });
      const current = valueAt(await currentTags(api, identity, intent.name), intent.tag);
      if (current === intent.before) {
        intent.status = 'reverted';
        await persist(dir, state);
        api.progress({ completed: ++completed });
        continue;
      }
      if (current !== intent.after) {
        intent.status = 'rollback-conflict';
        pending.push(`${intent.name}:${intent.tag}`);
        await persist(dir, state);
        continue;
      }
      intent.status = 'rollback-pending';
      await persist(dir, state);
      await writeTag(api, identity, intent.name, intent.tag, intent.before);
      if (valueAt(await currentTags(api, identity, intent.name), intent.tag) !== intent.before)
        throw failure('Rollback verification failed');
      intent.status = 'reverted';
      await persist(dir, state);
      api.progress({ completed: ++completed });
    } catch {
      pending.push(`${intent.name}:${intent.tag}`);
    }
  }
  state.rollbackPending = pending;
  await persist(dir, state);
  return pending;
}

export async function cleanupTemporary(
  api: Api,
  identity: RunIdentity,
  state: RunState,
  dir: string,
) {
  const pending = [];
  let completed = 0;
  api.progress({
    phase: 'cleanup',
    completed,
    total: Object.keys(state.temporaryTags).length,
    name: undefined,
    version: undefined,
  });
  for (const [name, owner] of Object.entries(state.temporaryTags)) {
    try {
      api.progress({ name, version: undefined });
      const current = valueAt(await currentTags(api, identity, name), identity.temporaryTag);
      if (current === null) {
        owner.status = 'removed';
        await persist(dir, state);
        api.progress({ completed: ++completed });
        continue;
      }
      if (!owner.versions.includes(current)) {
        owner.status = 'cleanup-conflict';
        pending.push(name);
        await persist(dir, state);
        continue;
      }
      owner.status = 'cleanup-pending';
      await persist(dir, state);
      await writeTag(api, identity, name, identity.temporaryTag, null);
      if (valueAt(await currentTags(api, identity, name), identity.temporaryTag) !== null)
        throw failure('Temporary tag cleanup verification failed');
      owner.status = 'removed';
      await persist(dir, state);
      api.progress({ completed: ++completed });
    } catch {
      pending.push(name);
    }
  }
  state.cleanupPending = pending;
  await persist(dir, state);
}
