import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

function readRepositoryFile(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function elementById(source: string, tag: 'section' | 'template', id: string): string {
  const idIndex = source.indexOf(`id="${id}"`);
  const start = source.lastIndexOf(`<${tag}`, idIndex);
  const end = source.indexOf(`</${tag}>`, idIndex);
  if (idIndex < 0 || start < 0 || end < 0) throw new Error(`找不到 ${tag}#${id}`);
  return source.slice(start, end + tag.length + 3);
}

describe('V0.2 design artifacts', () => {
  it('keeps the prompt bound to the approved product scope', () => {
    const prompt = readRepositoryFile('ui-design-prompt.md');

    expect(prompt).toContain('本提示词只服务于 V0.2 正式项目');
    expect(prompt).toContain('不得用禁用按钮、“即将支持”或无响应控件保留这些入口');
    expect(prompt).toContain('如果原型与当前版本范围冲突，以正式产品和交付文档为准');
  });

  it('shows only supported screens and entries in the redesign default review surface', () => {
    const html = readRepositoryFile('output/redesign/index.html');
    const navigationTargets = [...html.matchAll(/data-go="(s\d+)"/gu)].map((match) => match[1]);
    const v02Surface = [
      elementById(html, 'section', 's1'),
      elementById(html, 'section', 's2'),
      elementById(html, 'section', 's3'),
      elementById(html, 'template', 'tpl-topnav'),
      elementById(html, 'template', 'tpl-topbar'),
      elementById(html, 'template', 'tpl-form-info'),
    ].join('\n');

    expect(navigationTargets).toEqual(['s1', 's2', 's3']);
    expect(html.match(/<section[^>]+data-v02/gu)).toHaveLength(3);
    expect(v02Surface).not.toMatch(
      /上传头像|搜索简历|导入旧简历|即将支持|AI 额度|会员与账户|分享简历|导出 PDF/u,
    );
  });
});
