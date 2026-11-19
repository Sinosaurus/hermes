// 文件职责：克制的终端配色；机器输出与 NO_COLOR 不包含颜色转义。
import type { OutputStream } from './types.js';
export function paint(text: string, code: number, stream: OutputStream) {
  return stream.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
    ? `\x1b[${code}m${text}\x1b[0m`
    : text;
}
export function banner(action: string, stream: OutputStream = process.stderr) {
  if (!stream.isTTY) return;
  stream.write(`\n  ${paint('HERMES', 36, stream)}  ${paint(action, 2, stream)}\n\n`);
}
