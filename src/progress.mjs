const phases = { resolve: '解析', download: '下载', repack: '恢复打包', plan: '预检', import: '导入', promote: '提升校验', 'promote-tags': '提升 tag', rollback: '回滚', verify: '校验', cleanup: '清理', inventory: '盘点' };

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024, index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
  return `${value.toFixed(1)} ${units[index]}`;
}

export function progressLine(event, elapsed = 0, tick = 0, compact = false) {
  const completed = event.completed ?? 0, total = event.total ?? 0;
  const filled = total > 0 ? Math.min(20, Math.floor(completed / total * 20)) : 0;
  const bar = total > 0 ? `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}] ${completed}/${total}` : '等待数量';
  const stats = compact
    ? `↓${event.downloaded ?? 0} ${formatBytes(event.downloadBytes)} ↑${event.uploaded ?? 0} ${formatBytes(event.uploadBytes)} =${event.reused ?? 0}`
    : `下载 ${event.downloaded ?? 0} (${formatBytes(event.downloadBytes)}) 上传 ${event.uploaded ?? 0} (${formatBytes(event.uploadBytes)}) 复用 ${event.reused ?? 0}`;
  const packed = event.repacked ? ` 重打包 ${event.repacked}` : '';
  const name = event.name ? ` ${event.name}${event.version ? `@${event.version}` : ''}` : '';
  const seconds = Math.floor(elapsed / 1000);
  const eta = seconds > 0 && completed > 0 && completed < total ? ` 预计剩余 ${Math.ceil(seconds / completed * (total - completed))}s` : '';
  return `${completed < total || !total ? '|/-\\'[tick % 4] : '+'} ${phases[event.phase] || event.phase} ${bar} ${stats}${packed} ${seconds}s${eta}${name}`;
}

/** stderr is reserved for human progress; stdout stays machine-readable JSON. */
export function createProgress({ mode = 'auto', stream = process.stderr, intervalMs = 120 } = {}) {
  if (!['auto', 'plain', 'none'].includes(mode)) throw new Error('--progress must be auto, plain or none');
  const tty = mode === 'auto' && stream.isTTY;
  let current, started, phase, timer, tick = 0, lineOpen = false;
  const write = text => stream.write(text);
  function render() {
    let line = progressLine(current, Date.now() - started, tick++, tty);
    if (tty && stream.columns) {
      let width = 0, clipped = '';
      for (const character of line) {
        width += character.codePointAt(0) >= 0x2e80 ? 2 : 1;
        if (width >= stream.columns - 1) break;
        clipped += character;
      }
      line = clipped;
    }
    if (tty) { write(`\r\x1b[2K${line}`); lineOpen = true; }
    else write(`${line}\n`);
  }
  function stop() {
    clearInterval(timer); timer = undefined;
    if (lineOpen) { write('\n'); lineOpen = false; }
  }
  return {
    update(event) {
      if (mode === 'none') return;
      if (phase !== event.phase) { stop(); phase = event.phase; started = Date.now(); }
      current = event;
      render();
      if (event.total > 0 && event.completed >= event.total) stop();
      else if (tty && !timer) { timer = setInterval(render, intervalMs); timer.unref(); }
    },
    stop,
  };
}
