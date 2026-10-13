// 文件职责：验证终端摘要、JSON 输出兼容性，以及失败原因和处理提示。
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { writeResult, writeFailure } from '../src/cli/output.js';

function capture(isTTY) {
  let output = '';
  return {
    isTTY,
    write: (value) => {
      output += value;
    },
    text: () => output,
  };
}

const ready = {
  phase: 'versions-ready',
  registry: 'https://registry.internal/',
  stats: { uploaded: 2, uploadBytes: 2048, reused: 1, downloaded: 3, downloadBytes: 4096 },
};

test('terminal summary exposes upload statistics and pending formal tags', () => {
  const stream = capture(true);
  writeResult('import', ready, { run: './runs/default' }, stream);
  assert.match(stream.text(), /正式 tag 尚未提升/);
  assert.match(stream.text(), /上传 2 个 \(2.0 KiB\)/);
  assert.match(stream.text(), /复用 1 个/);
  assert.match(stream.text(), /runs\/default/);
  const partial = capture(true);
  writeResult(
    'rollback',
    { ...ready, phase: 'rollback-pending', rollbackPending: [{}] },
    {},
    partial,
  );
  assert.match(partial.text(), /回滚尚未完成/);
  assert.match(partial.text(), /待恢复 tag：1 项/);
});

test('redirected output and explicit --json retain the complete result', () => {
  for (const [isTTY, options] of [
    [false, {}],
    [true, { json: true }],
  ]) {
    const stream = capture(isTTY);
    writeResult('import', ready, options, stream);
    assert.deepEqual(JSON.parse(stream.text()), ready);
  }
});

test('inventory summary bounds issue output without hiding the full issue count', () => {
  const stream = capture(true);
  writeResult(
    'inventory',
    {
      sourceRoot: '/project/node_modules',
      layout: 'pnpm',
      instances: [{}, {}],
      issues: Array.from({ length: 8 }, (_, i) => ({ path: `issue-${i}`, message: 'broken-link' })),
    },
    {},
    stream,
  );
  assert.match(stream.text(), /2 个包实例.*8 个问题/);
  assert.match(stream.text(), /issue-4/);
  assert.doesNotMatch(stream.text(), /issue-5/);
  assert.match(stream.text(), /--json/);
});

test('failure output redacts secrets and adds an actionable hint in terminal and JSON modes', () => {
  const error = Object.assign(new Error('\x1b[2JFile exists authorization=secret-token'), {
    code: 'EEXIST',
  });
  const terminal = capture(true);
  writeFailure(error, {}, terminal, true);
  assert.match(terminal.text(), /处理建议：.*--out/);
  // oxlint-disable-next-line no-control-regex -- 校验终端 ANSI 转义是否正确输出或清除。
  assert.doesNotMatch(terminal.text(), /secret-token|\x1b/);
  const json = capture(true);
  writeFailure(error, { json: true }, json, true);
  const result = JSON.parse(json.text());
  assert.equal(result.status, 'failed');
  assert.match(result.hint, /不会覆盖/);
  assert.doesNotMatch(result.message, /secret-token/);
});
