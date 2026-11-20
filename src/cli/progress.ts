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

/** 不将 Infinity/NaN 等内部 ETA 状态暴露给终端用户。 */
export function formatEta(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '估算中';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.ceil(seconds / 60)}min`;
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

/** 一阶段一条动态行，批量任务不输出逐包日志；管道仅节流输出阶段快照。 */
export function createProgress({ mode = 'auto', stream = process.stderr } = {}) {
  if (!['auto', 'plain', 'none'].includes(mode))
    throw new Error('--progress must be auto, plain or none');
  const tty = mode === 'auto' && stream.isTTY;
  const bar = tty
    ? new cliProgress.SingleBar(
        {
          stream,
          barsize: 12,
          linewrap: false,
          formatTime: formatEta,
          format:
            '  {phase}  {count}  成功 {done} · 复用 {reused} · {rate}/s · ETA {eta_formatted}',
        },
        cliProgress.Presets.shades_classic,
      )
    : undefined;
  let phase: string | undefined,
    active = false,
    last: ProgressEvent | undefined;
  let started = Date.now(),
    lastPrint = 0,
    startBytes = 0,
    finished = false;
  function stop() {
    bar?.stop();
    active = false;
  }
  return {
    update(event: ProgressEvent) {
      if (mode === 'none') return;
      const changed = phase !== event.phase;
      const completed = (event.total ?? 0) > 0 && (event.completed ?? 0) >= event.total!;
      if (changed) {
        stop();
        phase = event.phase;
        started = Date.now();
        finished = false;
        startBytes = (event.downloadBytes ?? 0) + (event.uploadBytes ?? 0);
      }
      last = event;
      if (finished && completed) return;
      const done = Math.max(0, (event.completed ?? 0) - (event.reused ?? 0));
      const bytes = Math.max(0, (event.downloadBytes ?? 0) + (event.uploadBytes ?? 0) - startBytes);
      const data = {
        ...payload(event),
        done,
        reused: event.reused ?? 0,
        rate: formatBytes(Math.round(bytes / Math.max(1, (Date.now() - started) / 1000))),
      };
      if (!tty) {
        if (changed || completed || Date.now() - lastPrint >= 5000) {
          stream.write(
            `  ${data.phase} ${data.count} · 成功 ${done} · 复用 ${data.reused} · ${data.rate}/s\n`,
          );
          lastPrint = Date.now();
        }
      } else if (!active) {
        bar!.start(Math.max(1, event.total ?? 0), event.completed ?? 0, data);
        active = true;
      } else {
        bar!.setTotal(Math.max(1, event.total ?? 0));
        bar!.update(event.completed ?? 0, data);
      }
      if (completed) {
        stop();
        finished = true;
      }
    },
    fail() {
      stop();
      if (mode !== 'none' && last)
        stream.write(
          `  ${phases[last.phase] ?? last.phase} 中断 · 失败 1（当前操作）· 已处理 ${last.completed ?? 0}/${last.total ?? '?'}；未处理项未验证\n`,
        );
    },
    stop,
  };
}
