// 文件职责：进度输出：终端进度条、普通日志及下载/上传/复用统计。
import type { ProgressEvent } from '../core/types.js';
import cliProgress from 'cli-progress';

const phases: Record<string, string> = {
  resolve: '解析',
  download: '下载',
  repack: '恢复打包',
  plan: '预检',
  import: '导入',
  promote: '提升校验',
  'promote-tags': '提升 tag',
  rollback: '回滚',
  verify: '校验',
  cleanup: '清理',
  inventory: '盘点',
};

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024,
    index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index++;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function payload(event: ProgressEvent) {
  return {
    phase: phases[event.phase] || event.phase,
    count: (event.total ?? 0) > 0 ? `${event.completed ?? 0}/${event.total}` : '等待数量',
    stats: `下载 ${event.downloaded ?? 0} (${formatBytes(event.downloadBytes)}) 上传 ${event.uploaded ?? 0} (${formatBytes(event.uploadBytes)}) 复用 ${event.reused ?? 0}${event.repacked ? ` 重打包 ${event.repacked}` : ''}`,
    name: event.name ? `${event.name}${event.version ? `@${event.version}` : ''}` : '',
  };
}

export function progressLine(event: ProgressEvent) {
  const { phase, count, stats, name } = payload(event);
  return `${phase} ${count} ${stats} ${name}`.trimEnd();
}

/** stderr 留给进度；stdout 留给结果。终端刷新、宽度与 ETA 由 cli-progress 管理。 */
export function createProgress({ mode = 'auto', stream = process.stderr } = {}) {
  if (!['auto', 'plain', 'none'].includes(mode))
    throw new Error('--progress must be auto, plain or none');
  const tty = mode === 'auto' && stream.isTTY;
  const bar = tty
    ? new cliProgress.SingleBar(
        {
          stream,
          barsize: 20,
          linewrap: true,
          format: '{phase} [{bar}] {count} | {stats} | ETA {eta_formatted} | {name}',
        },
        cliProgress.Presets.shades_classic,
      )
    : undefined;
  let phase: string | undefined,
    active = false;
  function stop() {
    bar?.stop();
    active = false;
  }
  return {
    update(event: ProgressEvent) {
      if (mode === 'none') return;
      if (!tty) {
        stream.write(`${progressLine(event)}\n`);
        return;
      }
      if (phase !== event.phase || !active) {
        stop();
        phase = event.phase;
        active = true;
        // 总数未定时只展示等待状态，不能把 0/0 渲染成已完成。
        bar!.start(Math.max(1, event.total ?? 0), event.completed ?? 0, payload(event));
      } else {
        bar!.setTotal(Math.max(1, event.total ?? 0));
        bar!.update(event.completed ?? 0, payload(event));
      }
      if ((event.total ?? 0) > 0 && (event.completed ?? 0) >= (event.total ?? 0)) stop();
    },
    stop,
  };
}
