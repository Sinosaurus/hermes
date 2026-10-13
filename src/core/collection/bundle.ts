// 文件职责：创建交付批次、记录失败、冻结摘要与生成 tag 计划。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Manifest,
  TransferStats,
  OnProgress,
  ProgressEvent,
  Tags,
  PackageIdentity,
} from '../types.js';
import {
  assertPackToolchain,
  listFiles,
  fileHash,
  writeJson,
  verifyBundle,
  redact,
  packageSpec,
} from '../../lib/index.js';
export interface Bundle {
  out: string;
  stats: TransferStats & { repacked: number; packedBytes: number };
  report: OnProgress;
  manifest: Manifest;
}

export function currentTarget() {
  const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
  const glibc = report.header.glibcVersionRuntime;
  return {
    os: process.platform,
    cpu: process.arch,
    node: process.version,
    nodeAbi: process.versions.modules,
    libc: glibc ? `glibc-${glibc}` : process.platform === 'linux' ? 'unknown' : 'not-applicable',
  };
}

export function tagPlanFromSnapshots(snapshots: Map<string, Tags>, packages: PackageIdentity[]) {
  const present = new Set(packages.map(packageSpec));
  return [...snapshots].map(([name, sourceTags]) => {
    const set: Tags = {},
      excluded: { tag: string; version: string; reason: string }[] = [];
    for (const [tag, version] of Object.entries(sourceTags)) {
      if (present.has(`${name}@${version}`)) set[tag] = version;
      else excluded.push({ tag, version, reason: 'version-not-in-batch' });
    }
    return { name, sourceTags, set, excluded };
  });
}

export async function newBundle(
  out: string,
  mode: string,
  onProgress?: OnProgress,
): Promise<Bundle> {
  const npm = await assertPackToolchain();
  out = path.resolve(out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out); // 已交接目录不能被重新收集覆盖。
  const stats = {
    total: 0,
    downloaded: 0,
    downloadBytes: 0,
    reused: 0,
    repacked: 0,
    packedBytes: 0,
    uploaded: 0,
    uploadBytes: 0,
  };
  return {
    out,
    stats,
    report: (event: ProgressEvent) => onProgress?.({ ...stats, ...event }),
    manifest: {
      schemaVersion: 1,
      status: 'collecting',
      batchId: randomUUID(),
      capturedAt: new Date().toISOString(),
      mode,
      toolchain: { node: process.version, npm },
      targets: [currentTarget()],
      roots: [],
      inputs: [],
      packages: [],
      tagPlan: [],
      resources: [],
      resourceReview: { status: 'pending' },
      exceptions: [],
      files: {},
    },
  };
}

export async function failBundle(bundle: Bundle, error: Error) {
  await writeJson(path.join(bundle.out, 'failure.json'), {
    status: 'failed',
    message: redact(error.message),
  });
}

// 文件全部写完再冻结摘要，发布阶段只读 bundle，续跑状态另存 run。
export async function finishBundle(bundle: Bundle) {
  if (!bundle.manifest.packages.length) throw new Error('No publishable packages collected');
  for (const file of await listFiles(bundle.out))
    bundle.manifest.files[file] = await fileHash(path.join(bundle.out, file));
  bundle.manifest.status = 'complete';
  await writeJson(path.join(bundle.out, 'manifest.json'), bundle.manifest, { exclusive: true });
  const files: Record<string, string> = {
    ...bundle.manifest.files,
    'manifest.json': await fileHash(path.join(bundle.out, 'manifest.json')),
  };
  await writeFile(
    path.join(bundle.out, 'checksums.sha256'),
    Object.keys(files)
      .sort()
      .map((file) => `${files[file]}  ${file}`)
      .join('\n') + '\n',
    { flag: 'wx' },
  );
  return { ...(await verifyBundle(bundle.out)), stats: { ...bundle.stats } };
}
