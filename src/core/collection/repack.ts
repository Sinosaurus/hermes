// 文件职责：从盘点实例建立独立副本，禁钩子重打包并记录恢复来源。
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { InstalledInstance } from '../types.js';
import type { Bundle } from './bundle.js';
import { stageInstance } from '../recovery.js';
import { packageSpec, packArtifact, writeJson } from '../../lib/index.js';

// 目录恢复会生成新制品摘要；不把恢复字节伪装成上游原始 tarball。
export async function addRepacked(bundle: Bundle, instance: InstalledInstance, work: string) {
  const progress = () =>
    bundle.report({
      phase: 'repack',
      completed: bundle.manifest.packages.length,
      total: bundle.stats.total,
      name: instance.name,
      version: instance.version,
    });
  progress();
  if (bundle.manifest.packages.some((pkg) => packageSpec(pkg) === packageSpec(instance))) {
    bundle.stats.reused++;
    progress();
    return;
  }
  const id = String(bundle.manifest.packages.length + 1).padStart(6, '0');
  const stage = path.join(work, id);
  await stageInstance(instance, stage);
  const artifact = await packArtifact(stage, path.join(work, 'packed', id), { cwd: work });
  await mkdir(path.join(bundle.out, 'packages'), { recursive: true });
  const file = `packages/${id}.tgz`;
  await rename(artifact.file, path.join(bundle.out, file));
  const metadataFile = `metadata/${id}.json`;
  await writeJson(path.join(bundle.out, metadataFile), {
    name: instance.name,
    version: instance.version,
    source: instance.path,
    locations: instance.locations,
    contentHash: instance.contentHash,
    scripts: artifact.packageJson.scripts,
    sourceTags: null,
    sourceIntegrity: null,
  });
  bundle.manifest.packages.push({
    id,
    name: instance.name,
    version: instance.version,
    artifactKind: 'installed-repack',
    file,
    metadataFile,
    sha256: artifact.sha256,
    artifactIntegrity: artifact.artifactIntegrity,
    sourceIntegrity: null,
  });
  bundle.stats.repacked++;
  bundle.stats.packedBytes += artifact.size;
  progress();
}
