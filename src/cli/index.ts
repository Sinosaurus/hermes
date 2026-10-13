#!/usr/bin/env node
// 文件职责：CLI 入口，交给 cac 解析并统一处理同步参数错误。
import { createProgram } from './program.js';
import { writeFailure } from './output.js';

const cli = createProgram();
try {
  cli.parse();
} catch (error) {
  writeFailure(error, cli.options);
  process.exitCode = 1;
}
