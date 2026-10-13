// 文件职责：验证资源声明与审查证据，把本地资源复制到交付目录。
import { cp, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceConfig } from '../types.js';
import type { Bundle } from './bundle.js';
import { readJson, listFiles } from '../../lib/index.js';

export async function addResources(bundle: Bundle, configFile?: string) {
  if (!configFile) return;
  const config = await readJson<ResourceConfig>(configFile);
  if (!Array.isArray(config.resources))
    throw new Error('resources config requires a resources array');
  const ids = new Set();
  for (const resource of config.resources) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(resource.id) ||
      ids.has(resource.id) ||
      typeof resource.source !== 'string' ||
      typeof resource.instructions !== 'string' ||
      !resource.instructions.trim() ||
      !Array.isArray(resource.targets) ||
      !resource.targets.length
    )
      throw new Error('Invalid resource id/source/instructions/targets');
    ids.add(resource.id);
    const source = path.resolve(path.dirname(configFile), resource.source);
    const destination = path.join(bundle.out, 'resources', resource.id);
    await copyResource(source, destination);
    const files = (await listFiles(destination)).map((file) => `resources/${resource.id}/${file}`);
    if (!files.length) throw new Error(`Empty resource: ${resource.id}`);
    bundle.manifest.resources.push({
      id: resource.id,
      targets: resource.targets,
      instructions: resource.instructions,
      files,
    });
  }
  if (
    config.review?.status === 'reviewed' &&
    Array.isArray(config.review.evidence) &&
    config.review.evidence.length &&
    config.review.evidence.every((item) => typeof item === 'string' && item.trim())
  ) {
    bundle.manifest.resourceReview = { status: 'reviewed', evidence: config.review.evidence };
  }
}

async function copyResource(source: string, destination: string) {
  const info = await stat(source);
  // 先检查资源目录并拒绝链接，再复制到交付目录，避免带入未经审查的缓存布局。
  if (info.isDirectory()) {
    await listFiles(source);
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
    });
  } else if (info.isFile()) {
    await mkdir(destination, { recursive: true });
    await cp(source, path.join(destination, path.basename(source)), {
      errorOnExist: true,
      force: false,
    });
  } else throw new Error('Resource must be a file or directory');
}
