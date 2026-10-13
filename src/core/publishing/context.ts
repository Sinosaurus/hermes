// 文件职责：集中声明发布选项、npm 适配器、统计与错误辅助函数。
import type { OnProgress, ProgressEvent, Tags } from '../types.js';
import { npmJson, npmCommand, packArtifact } from '../../lib/index.js';
export interface PublishOptions {
  registry?: string;
  readRegistry?: string;
  recovery?: boolean;
  runDir?: string;
  acceptanceFile?: string;
  overwriteTags?: boolean;
  onProgress?: OnProgress;
  adapter?: Partial<{
    npmJson: typeof npmJson;
    npmCommand: typeof npmCommand;
    packArtifact: typeof packArtifact;
  }>;
}
export type Api = ReturnType<typeof adapters>;
export type NormalizedOptions = PublishOptions & { registry: string; readRegistry: string };

export function adapters(options: PublishOptions, operation: string) {
  const stats = {
    total: 0,
    uploaded: 0,
    reused: 0,
    downloaded: 0,
    downloadBytes: 0,
    uploadBytes: 0,
  };
  let current = { phase: operation, completed: 0, total: 0 };
  return {
    npmJson,
    npmCommand,
    packArtifact,
    ...options.adapter,
    operation,
    stats,
    progress(event: Partial<ProgressEvent> = {}) {
      current = { ...current, ...event };
      options.onProgress?.({ ...stats, ...current });
    },
  };
}
export const failure = (message: string, cause?: { npmCode?: string; code?: string }) =>
  new Error(
    `${message}${/^[A-Z][A-Z0-9_]+$/.test(cause?.npmCode ?? cause?.code ?? '') ? ` (${cause?.npmCode ?? cause?.code})` : ''}`,
  );
export const missing = (error: { npmCode?: string; code?: string }) =>
  (error?.npmCode ?? error?.code) === 'E404';
export const valueAt = (tags: Tags, tag: string) => (Object.hasOwn(tags, tag) ? tags[tag] : null);
