// 文件职责：发布流程入口：组织版本导入、验收提升和条件回滚。
import path from 'node:path';
import * as common from '../lib/index.js';
import { adapters, failure, type PublishOptions } from './publishing/context.js';
import {
  withRun,
  loadRun,
  persist,
  result,
  verifyRunBundle,
  createImportRun,
  resumeImportRun,
} from './publishing/run.js';
import { verifyAll, importVersions } from './publishing/versions.js';
import { cleanupTemporary, restoreTags } from './publishing/tags.js';
import {
  acceptance,
  plannedTagChanges,
  applyTagChanges,
  verifyPromotedTags,
} from './publishing/promotion.js';
export { planImport } from './publishing/plan.js';
export type { PublishOptions } from './publishing/context.js';

/** 使用本 run 的临时 tag 导入版本；正式 tag 必须经 promoteRun 提升。 */
export async function importBundle(bundle: string, options: PublishOptions = {}) {
  const absoluteBundle = await common.canonicalPath(bundle);
  const registry = common.normalizeRegistry(options.registry ?? '');
  const readRegistry = common.normalizeRegistry(options.readRegistry ?? registry);
  const relativeRun = options.runDir
    ? path.relative(absoluteBundle, await common.canonicalPath(options.runDir))
    : '';
  if (
    options.runDir &&
    (relativeRun === '' ||
      (!path.isAbsolute(relativeRun) &&
        relativeRun !== '..' &&
        !relativeRun.startsWith(`..${path.sep}`)))
  )
    throw failure('Run directory must be outside the frozen bundle');
  return withRun(options.runDir, async (dir, empty) => {
    const api = adapters(options, 'import');
    const normalized = { ...options, registry, readRegistry };
    const { identity, state } = empty
      ? await createImportRun(dir, absoluteBundle, normalized, api)
      : await resumeImportRun(dir, absoluteBundle, normalized);
    if (state.phase === 'promoted') {
      await verifyAll(api, identity, state, dir);
      return result(identity, state, api);
    }
    return importVersions(api, identity, state, dir);
  });
}

/** 验收记录与批次匹配后，按冻结计划提升正式 tag。 */
export async function promoteRun(runDir: string, options: PublishOptions = {}) {
  return withRun(runDir, async (dir, created) => {
    if (created) throw failure('No import run exists');
    const { identity, state } = await loadRun(dir);
    if (!['versions-ready', 'promoting', 'promotion-failed', 'promoted'].includes(state.phase))
      throw failure('Import has not reached versions-ready');
    await verifyRunBundle(identity);
    const accepted = await acceptance(identity, options.acceptanceFile);
    const api = adapters(options, 'promote');
    await verifyAll(api, identity, state, dir);
    const totalTags = identity.manifest.tagPlan.reduce(
      (total, plan) => total + Object.keys(plan.set).length,
      0,
    );
    const progress = { completed: 0 };
    api.progress({
      phase: 'promote-tags',
      completed: progress.completed,
      total: totalTags,
      name: undefined,
      version: undefined,
    });
    if (state.phase === 'promoted') {
      await verifyPromotedTags(api, identity, progress);
      await cleanupTemporary(api, identity, state, dir);
      return result(identity, state, api);
    }
    state.acceptance = accepted;
    state.phase = 'promoting';
    await persist(dir, state);
    try {
      const changes = await plannedTagChanges(
        api,
        identity,
        state,
        options.overwriteTags,
        progress,
      );
      await applyTagChanges(api, identity, state, dir, changes, progress);
    } catch (error) {
      await restoreTags(api, identity, state, dir);
      state.phase = 'promotion-failed';
      state.error = failure('Promotion stopped', error).message;
      await persist(dir, state);
      throw error;
    }
    state.phase = 'promoted';
    delete state.error;
    delete state.rollbackPending;
    await persist(dir, state);
    await cleanupTemporary(api, identity, state, dir);
    return result(identity, state, api);
  });
}

/** 按当前 tag 值条件回滚，可重复执行，保留已上传的包版本。 */
export async function rollbackRun(runDir: string, options: PublishOptions = {}) {
  return withRun(runDir, async (dir, created) => {
    if (created) throw failure('No import run exists');
    const { identity, state } = await loadRun(dir);
    const api = adapters(options, 'rollback');
    api.stats.total = identity.manifest.packages.length;
    state.phase = 'rolling-back';
    await persist(dir, state);
    const pending = await restoreTags(api, identity, state, dir);
    await cleanupTemporary(api, identity, state, dir);
    state.phase =
      pending.length || state.cleanupPending?.length ? 'rollback-pending' : 'rolled-back';
    await persist(dir, state);
    return result(identity, state, api);
  });
}
