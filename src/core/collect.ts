// 文件职责：编排项目收集与安装树恢复；校验、取包和冻结分别交给具体步骤。
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { CollectOptions, RecoverOptions, Tags } from './types.js';
import { registrySpec, normalizeRegistry, packageSpec, writeJson } from '../lib/index.js';
import { inventoryModules } from './recovery.js';
import {
  newBundle,
  failBundle,
  finishBundle,
  tagPlanFromSnapshots,
  type Bundle,
} from './collection/bundle.js';
import {
  resolveProject,
  resolveRoots,
  validateInstallFlags,
  type ResolvedInput,
} from './collection/resolution.js';
import { addOriginal } from './collection/originals.js';
import { addResources } from './collection/resources.js';
import { addRepacked } from './collection/repack.js';
export { registrySpec } from '../lib/packages.js';
export { currentTarget, tagPlanFromSnapshots } from './collection/bundle.js';
export { entriesFromLock, validateInstallFlags } from './collection/resolution.js';

async function collectInputs(
  bundle: Bundle,
  inputs: ResolvedInput[],
  registry: string,
  allowHosts: string[],
  snapshots: Map<string, Tags>,
  installFlags: string[],
) {
  for (const input of inputs) {
    const prefix = `inputs/${input.context}`;
    await writeJson(path.join(bundle.out, prefix, 'package.json'), input.packageJson);
    await writeJson(path.join(bundle.out, prefix, input.lockName), input.lock);
    bundle.manifest.inputs.push({
      context: input.context,
      packageJson: `${prefix}/package.json`,
      lock: `${prefix}/${input.lockName}`,
      installFlags,
    });
    bundle.manifest.exceptions.push(
      ...input.parsed.skipped.map((item) => ({ ...item, context: input.context })),
    );
    for (const entry of input.parsed.entries)
      await addOriginal(bundle, entry, { registry, allowHosts, snapshots, context: input.context });
  }
}

export async function collect({
  out,
  project,
  specs = [],
  registry = 'https://registry.npmjs.org/',
  allowHosts = [],
  resourcesFile,
  installFlags = [],
  onProgress,
}: CollectOptions) {
  if ((!project && !specs.length) || (project && specs.length))
    throw new Error('Use either --project or one/more --package inputs');
  installFlags = validateInstallFlags(installFlags);
  specs.forEach(registrySpec);
  registry = normalizeRegistry(registry);
  const bundle = await newBundle(out, 'mirror', onProgress);
  const work = await mkdtemp(path.join(tmpdir(), 'offline-npm-resolve-'));
  const snapshots = new Map<string, Tags>();
  try {
    bundle.report({ phase: 'resolve', completed: 0, total: project ? 1 : specs.length });
    const inputs = project
      ? [await resolveProject(project, work, registry, installFlags, bundle)]
      : await resolveRoots(specs, work, registry, installFlags, bundle);
    if (project) bundle.report({ phase: 'resolve', completed: 1, total: 1 });
    bundle.stats.total = new Set(
      inputs.flatMap((input) => input.parsed.entries.map(packageSpec)),
    ).size;
    await collectInputs(bundle, inputs, registry, allowHosts, snapshots, installFlags);
    bundle.manifest.tagPlan = tagPlanFromSnapshots(snapshots, bundle.manifest.packages);
    await addResources(bundle, resourcesFile);
    return await finishBundle(bundle);
  } catch (error) {
    await failBundle(bundle, error);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function recover({
  modules,
  out,
  registry,
  repack = false,
  allowHosts = [],
  allowLinkRoots = [],
  resourcesFile,
  onProgress,
}: RecoverOptions) {
  if (!repack && !registry)
    throw new Error(
      'Recovery requires --registry for originals, or explicit --repack for an isolated recovery repository',
    );
  onProgress?.({ phase: 'inventory', completed: 0, total: 0 });
  const inventory = await inventoryModules(modules, { allowLinkRoots });
  onProgress?.({
    phase: 'inventory',
    completed: inventory.instances.length,
    total: inventory.instances.length,
  });
  if (inventory.issues.length)
    throw new Error(
      `Recovery blocked: ${inventory.issues.map((item) => `${item.code} (${item.path}): ${item.message}`).join('; ')}`,
    );
  const bundle = await newBundle(out, repack ? 'recovery' : 'mirror', onProgress);
  bundle.stats.total = new Set(inventory.instances.map(packageSpec)).size;
  const work = await mkdtemp(path.join(tmpdir(), 'offline-npm-recover-'));
  try {
    await writeJson(path.join(bundle.out, 'inputs', 'inventory.json'), inventory);
    bundle.manifest.inputs.push({ inventory: 'inputs/inventory.json', layout: inventory.layout });
    const snapshots = new Map<string, Tags>();
    for (const instance of inventory.instances) {
      if (!repack) {
        await addOriginal(bundle, instance, {
          registry: normalizeRegistry(registry!),
          allowHosts,
          snapshots,
          context: 'installed-inventory',
        });
        continue;
      }
      await addRepacked(bundle, instance, work);
    }
    bundle.manifest.tagPlan = tagPlanFromSnapshots(snapshots, bundle.manifest.packages);
    await addResources(bundle, resourcesFile);
    return await finishBundle(bundle);
  } catch (error) {
    await failBundle(bundle, error);
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
