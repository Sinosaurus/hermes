// 文件职责：绑定外部验收证据，预检全部 tag 后持久化意图、写入并回读。
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { RunIdentity, RunState, TagIntent, Acceptance } from '../types.js';
import { failure, valueAt, type Api } from './context.js';
import { currentTags, writeTag } from './tags.js';
import { persist } from './run.js';
import * as common from '../../lib/index.js';

export async function acceptance(identity: RunIdentity, file?: string) {
  if (!file) throw failure('An external acceptance record is required before promotion');
  const record = await common.readJson<Acceptance>(file);
  const readRegistry = common.normalizeRegistry(record.readRegistry);
  if (
    record.status !== 'passed' ||
    record.manifestDigest !== identity.manifestDigest ||
    common.normalizeRegistry(record.writeRegistry) !== identity.registry ||
    readRegistry !== identity.readRegistry ||
    !isDeepStrictEqual(record.targets, identity.manifest.targets) ||
    record.resourceReview !== 'reviewed' ||
    identity.manifest.resourceReview?.status !== 'reviewed' ||
    !Array.isArray(record.evidence) ||
    !record.evidence.length ||
    record.evidence.some((value) => typeof value !== 'string' || !value.trim())
  )
    throw failure(
      'Acceptance record must match this bundle, write/read registry, targets and completed resource review',
    );
  return { ...record, readRegistry, file: path.resolve(file), sha256: await common.fileHash(file) };
}

// 先完成整批 tag 冲突检查，再执行写入，避免预检失败造成部分变更。
export async function plannedTagChanges(
  api: Api,
  identity: RunIdentity,
  state: RunState,
  overwriteTags: boolean | undefined,
  progress: { completed: number },
) {
  const changes = [];
  for (const plan of identity.manifest.tagPlan ?? []) {
    api.progress({ name: plan.name, version: undefined });
    const tags = await currentTags(api, identity, plan.name);
    for (const [tag, after] of Object.entries(plan.set ?? {})) {
      const before = valueAt(identity.tagSnapshot[plan.name], tag);
      const current = valueAt(tags, tag);
      const intent = state.tagIntents.find(
        (intent) => intent.name === plan.name && intent.tag === tag,
      );
      if (current === after) {
        if (intent && intent.status !== 'reverted') intent.status = 'applied';
        api.progress({ completed: ++progress.completed, version: after });
        continue;
      }
      if (current !== before) throw failure(`Tag changed outside this run: ${plan.name}:${tag}`);
      if (before !== null && before !== after && !overwriteTags)
        throw failure(`Existing tag requires --overwrite-tags: ${plan.name}:${tag}`);
      changes.push(intent ?? { name: plan.name, tag, before, after, status: 'pending' });
    }
  }
  return changes;
}

// 每条变更先记意图，再写远端并回读；断点续跑与回滚以这些记录为依据。
export async function applyTagChanges(
  api: Api,
  identity: RunIdentity,
  state: RunState,
  dir: string,
  changes: TagIntent[],
  progress: { completed: number },
) {
  for (const intent of changes) {
    api.progress({ name: intent.name, version: intent.after });
    const current = valueAt(await currentTags(api, identity, intent.name), intent.tag);
    if (current !== intent.before && current !== intent.after)
      throw failure(`Tag changed outside this run: ${intent.name}:${intent.tag}`);
    if (!state.tagIntents.includes(intent)) state.tagIntents.push(intent);
    intent.status = 'pending';
    await persist(dir, state);
    if (current !== intent.after)
      await writeTag(api, identity, intent.name, intent.tag, intent.after);
    if (valueAt(await currentTags(api, identity, intent.name), intent.tag) !== intent.after)
      throw failure(`Tag verification failed for ${intent.name}:${intent.tag}`);
    intent.status = 'applied';
    await persist(dir, state);
    api.progress({ completed: ++progress.completed });
  }
}

export async function verifyPromotedTags(
  api: Api,
  identity: RunIdentity,
  progress: { completed: number },
) {
  for (const plan of identity.manifest.tagPlan ?? []) {
    api.progress({ name: plan.name, version: undefined });
    const tags = await currentTags(api, identity, plan.name);
    if (Object.entries(plan.set ?? {}).some(([tag, version]) => valueAt(tags, tag) !== version))
      throw failure(`Promoted tags changed outside this run: ${plan.name}`);
    api.progress({ completed: (progress.completed += Object.keys(plan.set).length) });
  }
}
