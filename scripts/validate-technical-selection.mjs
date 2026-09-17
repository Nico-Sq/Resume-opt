import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Document checks only: this does not execute the proposed production pipeline.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const document = readFileSync(resolve(root, 'technical-selection.md'), 'utf8');
const lines = document.split(/\r?\n/);
const headings = [...document.matchAll(/^## (\d+)\. (.+)$/gm)];
const expected = [
  '文档信息', '执行摘要', '需求与技术约束', '架构方案对比', '总体架构',
  '前端技术选型', '后端与 API 选型', '数据库和数据模型', 'Resume JSON Schema',
  '自动保存与版本系统', 'PDF 技术方案', 'AI、诊断与 JD 匹配', '异步任务与队列',
  '认证、权限和隐私', '额度、订单和支付', '存储与文件管理', '测试策略',
  '监控与分析', '部署方案', '工程目录与代码边界', '分阶段实施路线', '成本控制',
  '风险清单', '架构决策记录', '最终技术栈清单',
];
const blocks = [];
let current;
for (const [index, line] of lines.entries()) {
  if (!line.startsWith('```')) {
    if (current) current.lines.push(line);
    continue;
  }
  if (current) {
    assert.equal(line.trim(), '```', `Nested fence at ${index + 1}`);
    blocks.push(current);
    current = undefined;
  } else {
    current = { language: line.slice(3).trim(), line: index + 1, lines: [] };
  }
}

test('preserves all 25 architecture chapters and version labels', () => {
  assert.equal(headings.length, 25);
  headings.forEach((match, i) => {
    assert.equal(Number(match[1]), i + 1);
    assert.equal(match[2].trim(), expected[i]);
  });
  assert.match(document, /文档版本 \| V0\.3，2026-09-17/);
});

test('summary remains within 500 characters', () => {
  const summary = document.split('## 2. 执行摘要')[1].split('## 3.')[0].trim();
  assert.ok(summary.length <= 500, `Summary: ${summary.length} characters`);
});

test('code fences balance and all JSON examples parse', () => {
  assert.equal(current, undefined, 'Unclosed code fence');
  for (const block of blocks.filter(b => b.language === 'json')) {
    assert.doesNotThrow(() => JSON.parse(block.lines.join('\n')), `JSON at line ${block.line}`);
  }
  assert.equal(blocks.filter(b => b.language === 'mermaid').length, 10);
});

test('Markdown table rows keep the same unescaped column count', () => {
  let width = null;
  let inFence = false;
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('```')) inFence = !inFence;
    if (inFence || !line.startsWith('|')) { width = null; continue; }
    const columns = line.split(/(?<!\\)\|/).length - 2;
    width ??= columns;
    assert.equal(columns, width, `Broken table row ${index + 1}`);
  }
});

test('relative source links exist and whitespace is clean', () => {
  for (const match of document.matchAll(/\]\((\.\/[^)]+)\)/g)) {
    assert.ok(existsSync(resolve(root, match[1])), `Missing source: ${match[1]}`);
  }
  assert.doesNotMatch(document, /[ \t]+$/m);
});

test('architecture matrix still totals correctly', () => {
  const rows = [...document.matchAll(/^\| [^|\r\n]+ \| (\d+) \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)];
  assert.equal(rows.reduce((sum, row) => sum + Number(row[1]), 0), 100);
  const totals = [0, 0, 0, 0];
  rows.forEach(row => totals.forEach((_, i) => { totals[i] += Number(row[1]) * Number(row[i + 2]); }));
  assert.deepEqual(totals, [466, 444, 366, 310]);
});

test('the four requested delivery additions have numbered sections', () => {
  for (const section of ['7.4', '7.5', '7.6', '7.7', '7.8', '14.5', '15.4', '15.5', '15.6',
    '17.1', '17.2', '17.3', '17.4', '18.1', '19.4', '19.5', '19.6', '19.7', '19.8',
    '20.1', '20.2', '20.3', '20.4', '20.5']) {
    assert.ok(document.includes(`### ${section} `), `Missing section ${section}`);
  }
});

test('business decisions, load cases, alerts, and runbooks are traceable', () => {
  for (const [prefix, count] of [['BIZ-', 11], ['LOAD-', 6], ['AL-', 8], ['RB-', 6]]) {
    for (let i = 1; i <= count; i++) {
      assert.ok(document.includes(`${prefix}${String(i).padStart(2, '0')}`));
    }
  }
  for (const id of ['SAVE-01', 'SCHEMA-01', 'AI-01', 'JOB-01', 'QUOTA-01', 'PAY-01',
    'REFUND-01', 'PDF-01', 'FILE-01', 'AUTH-01', 'SHARE-01', 'PRIVACY-01', 'A11Y-01', 'OPS-01']) {
    assert.ok(document.includes(`| ${id} |`), `Missing acceptance case ${id}`);
  }
});

test('workflow examples pin actions and separate quality/staging/production', () => {
  const yaml = blocks.filter(b => b.language === 'yaml').map(b => b.lines.join('\n'));
  assert.equal(yaml.length, 2);
  for (const source of yaml) {
    for (const match of source.matchAll(/uses:\s+([^\s]+)@([^\s]+)/g)) {
      assert.match(match[2], /^[a-f0-9]{40}$/);
    }
    assert.doesNotMatch(source, /continue-on-error:\s*true/);
    assert.match(source, /persist-credentials: false/);
  }
  assert.match(yaml[0], /pnpm ci:full/);
  assert.match(yaml[1], /needs: staging/);
  assert.match(yaml[1], /environment: production/);
  assert.match(yaml[1], /cancel-in-progress: false/);
});

test('unimplemented delivery contracts and unapproved business policy remain explicit', () => {
  assert.ok(document.includes('正式工程待实现的交付契约'));
  assert.ok(document.includes('不表示当前原型已经具备'));
  assert.ok(document.includes('待审批业务参数'));
  assert.ok(document.includes('不自动执行down migration'));
  assert.ok(document.includes('不替代PITR'));
  assert.ok(document.includes('JOB_NOT_CANCELLABLE'));
});

test('confirmed business decisions keep credits separate from membership', () => {
  const examples = blocks.filter(b => b.language === 'json').map(b => JSON.parse(b.lines.join('\n')));
  const decisions = examples.find(value => value.registrationGift);
  assert.ok(decisions, 'Missing confirmed policy fragment');
  assert.equal(decisions.launchRegion, 'CN');
  assert.deepEqual(decisions.registrationGift, {
    trigger: 'registration_completed', benefitCode: 'signup_gift', unit: 'ai_use',
    amount: 5, oncePerAccount: true, expiresAt: null,
  });
  assert.deepEqual(decisions.successfulJobCost, { ai_optimize: 1, jd_analysis: 1, diagnosis: 1 });
  assert.equal(decisions.generationFailure, 'release_full_reservation');
  assert.deepEqual(decisions.userRegeneration, { newJob: true, successCost: 1 });
  assert.deepEqual(decisions.membership.term, { unit: 'calendar_year', value: 3 });
  assert.equal(decisions.membership.earlyExpiryForNoRecharge, false);
  assert.equal(decisions.membership.expiredPaidCredits, 'retain_for_basic_features');
  assert.deepEqual(decisions.membership.retainAfterExpiry, ['resume_read', 'resume_edit', 'resume_download']);
  assert.ok(document.includes('不是可直接启用生产收款的完整配置'));
  assert.ok(document.includes('不能实现无例外拒退'));
  assert.doesNotMatch(document, /邮箱验证成功后一次性赠送/);
});
