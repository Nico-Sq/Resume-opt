import { performance } from 'node:perf_hooks';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  createInitialResumeDocument,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';
import {
  ATS_BASIC_TEMPLATE_MANIFEST,
  computePreviewScale,
  createRendererCssVariables,
  createRenderFlow,
  createResumeRenderModel,
  DEFAULT_FONT_MANIFEST,
  getA4PageMetrics,
  paginateRenderFlow,
  RENDER_POLICY_V1,
  RESUME_RENDERER_CSS,
  ResumeMeasurementSurface,
  ResumePages,
  RendererConfigurationError,
  type RenderFlowBlock,
} from '@resume/resume-renderer';

function deterministicIds(start = 1) {
  let counter = start;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function createFixture() {
  const nextId = deterministicIds();
  return { document: createInitialResumeDocument(nextId), nextId };
}

function sectionByKind<K extends ContentSection['kind']>(document: ResumeDocumentV1, kind: K) {
  const sectionValue = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: K }> => candidate.kind === kind,
  );
  if (!sectionValue) throw new Error(`fixture 缺少 ${kind} 模块`);
  return sectionValue;
}

function rendererInput(document: ResumeDocumentV1) {
  return {
    document,
    templateManifest: ATS_BASIC_TEMPLATE_MANIFEST,
    fontManifest: DEFAULT_FONT_MANIFEST,
    renderPolicy: RENDER_POLICY_V1,
  };
}

function populateStandardDocument(document: ResumeDocumentV1, nextId: () => string) {
  const basic = sectionByKind(document, 'basic');
  const basicEntry = basic.entries[0];
  if (!basicEntry) throw new Error('fixture 缺少基本信息条目');
  basicEntry.name = '林小满';
  basicEntry.phone = { value: '13800000000', visible: true };
  basicEntry.email = { value: 'hidden@example.com', visible: false };
  basicEntry.links.push({
    id: nextId(),
    label: '作品集',
    url: 'https://example.com',
    visible: true,
  });

  const education = sectionByKind(document, 'education');
  education.entries.push({
    id: nextId(),
    school: '示例大学',
    major: '计算机科学',
    degree: '本科',
    city: '上海',
    courses: ['数据结构'],
    grade: null,
    period: { start: '2020-09', end: '2024-06', current: false },
    bullets: [{ id: nextId(), text: '完成课程设计' }],
  });
  document.typography.moduleOverrides[education.id] = { fontSizePt: 13, fontWeight: 700 };

  const campus = sectionByKind(document, 'campus');
  campus.visible = false;
  campus.entries.push({
    id: nextId(),
    organization: '不应公开的社团',
    role: '负责人',
    activity: '隐藏内容',
    period: { start: null, end: null, current: false },
    bullets: [],
  });
}

describe('resume renderer projector', () => {
  it('projects an ID-free read model and removes hidden or empty content', () => {
    const { document, nextId } = createFixture();
    populateStandardDocument(document, nextId);
    const sourceIds = Object.keys(document.sectionsById);

    const model = createResumeRenderModel(rendererInput(document));
    const serialized = JSON.stringify(model);

    expect(model).toMatchObject({
      name: '林小满',
      contacts: [{ label: '电话', value: '13800000000' }],
      links: [{ label: '作品集', url: 'https://example.com' }],
    });
    expect(model.sections.map((sectionValue) => sectionValue.title)).toEqual(['教育背景']);
    expect(model.sections[0]?.style).toEqual({ fontSizePt: 13, fontWeight: 700 });
    expect(serialized).not.toContain('hidden@example.com');
    expect(serialized).not.toContain('不应公开的社团');
    expect(serialized).not.toContain('moduleOverrides');
    sourceIds.forEach((id) => {
      expect(serialized).not.toContain(id);
    });
  });

  it('rejects template, font and avatar configuration mismatches', () => {
    const { document } = createFixture();
    expect(() =>
      createResumeRenderModel({
        ...rendererInput(document),
        templateManifest: { ...ATS_BASIC_TEMPLATE_MANIFEST, version: '2.0.0' },
      }),
    ).toThrow(expect.objectContaining({ code: 'TEMPLATE_MISMATCH' }));

    document.typography.fontFamilyId = 'unknown-font';
    expect(() => createResumeRenderModel(rendererInput(document))).toThrow(
      expect.objectContaining({ code: 'FONT_NOT_ALLOWED' }),
    );

    document.typography.fontFamilyId = 'noto-sans-sc';
    const basicEntry = sectionByKind(document, 'basic').entries[0];
    if (!basicEntry) throw new Error('fixture 缺少基本信息条目');
    basicEntry.avatarAssetId = '00000000-0000-4000-8000-999999999999';
    basicEntry.avatarVisible = true;
    expect(() =>
      createResumeRenderModel({
        ...rendererInput(document),
        renderPolicy: { ...RENDER_POLICY_V1, allowAvatar: true },
        resolveAvatarUrl: () => 'https://private.example/avatar.png',
      }),
    ).toThrow(RendererConfigurationError);
  });
});

describe('resume renderer flow and pagination', () => {
  it('creates atomic flow blocks in document order', () => {
    const { document, nextId } = createFixture();
    populateStandardDocument(document, nextId);
    const flow = createRenderFlow(createResumeRenderModel(rendererInput(document)));

    expect(flow.map((block) => block.kind)).toEqual([
      'header',
      'section-heading',
      'entry-heading',
      'paragraph',
      'bullet',
    ]);
    expect(flow[1]).toMatchObject({ kind: 'section-heading', keepWithNext: true });
    expect(flow[2]).toMatchObject({ kind: 'entry-heading', keepWithNext: true });
  });

  it('keeps a section heading, entry heading and first content block together', () => {
    const flow: RenderFlowBlock[] = [
      { key: 'filler', kind: 'paragraph', keepWithNext: false, text: '前文' },
      {
        key: 'section',
        kind: 'section-heading',
        keepWithNext: true,
        title: '项目经历',
        style: { fontSizePt: 12, fontWeight: 600 },
      },
      {
        key: 'entry',
        kind: 'entry-heading',
        keepWithNext: true,
        heading: '项目',
        subheading: '',
        periodLabel: '',
      },
      { key: 'content', kind: 'paragraph', keepWithNext: false, text: '内容' },
    ];
    const result = paginateRenderFlow(
      flow,
      {
        filler: { heightPx: 65 },
        section: { heightPx: 10 },
        entry: { heightPx: 10 },
        content: { heightPx: 20 },
      },
      100,
    );

    expect(result.ready).toBe(true);
    expect(result.pages.map((page) => page.map((placement) => placement.block.key))).toEqual([
      ['filler'],
      ['section', 'entry', 'content'],
    ]);
  });

  it('splits long text only at measured line boundaries without losing content', () => {
    const text = '甲乙丙丁戊';
    const block: RenderFlowBlock = {
      key: 'long-paragraph',
      kind: 'paragraph',
      keepWithNext: false,
      text,
    };
    const result = paginateRenderFlow(
      [block],
      {
        'long-paragraph': {
          heightPx: 150,
          lineFragments: ['甲', '乙', '丙', '丁', '戊'].map((character) => ({
            text: character,
            heightPx: 30,
          })),
        },
      },
      60,
    );
    const placements = result.pages.flat();

    expect(result).toMatchObject({ ready: true, issues: [] });
    expect(placements).toHaveLength(3);
    expect(
      placements
        .map((placement) => ('text' in placement.block ? placement.block.text : ''))
        .join(''),
    ).toBe(text);
    expect(placements[0]).toMatchObject({
      continuedFromPrevious: false,
      continuesOnNext: true,
    });
    expect(placements[2]).toMatchObject({
      continuedFromPrevious: true,
      continuesOnNext: false,
    });
  });

  it('fails closed with structured issues instead of clipping unmeasured or oversized blocks', () => {
    const header: RenderFlowBlock = {
      key: 'header',
      kind: 'header',
      keepWithNext: false,
      name: '姓名',
      avatarUrl: null,
      contacts: [],
      links: [],
    };
    expect(paginateRenderFlow([header], {}, 100)).toMatchObject({
      ready: false,
      pages: [],
      issues: [{ code: 'MEASUREMENT_MISSING', blockKey: 'header' }],
    });

    const oversized = paginateRenderFlow([header], { header: { heightPx: 101 } }, 100);
    expect(oversized).toMatchObject({
      ready: false,
      pages: [[]],
      issues: [{ code: 'LAYOUT_OVERFLOW', blockKey: 'header' }],
    });
  });

  it('handles the 100-entry boundary fixture within the pagination input budget', () => {
    const { document, nextId } = createFixture();
    const education = sectionByKind(document, 'education');
    for (let index = 0; index < 100; index += 1) {
      education.entries.push({
        id: nextId(),
        school: `示例大学 ${String(index)}`,
        major: '计算机科学',
        degree: '本科',
        city: '上海',
        courses: [],
        grade: null,
        period: { start: null, end: null, current: false },
        bullets: [{ id: nextId(), text: `项目成果 ${String(index)}` }],
      });
    }
    const startedAt = performance.now();
    const flow = createRenderFlow(createResumeRenderModel(rendererInput(document)));
    const measurements = Object.fromEntries(flow.map((block) => [block.key, { heightPx: 5 }]));
    const result = paginateRenderFlow(flow, measurements, 100);
    const elapsedMs = performance.now() - startedAt;

    expect(result.ready).toBe(true);
    expect(flow).toHaveLength(201);
    result.pages.forEach((page) => {
      expect(page.reduce((sum, placement) => sum + placement.heightPx, 0)).toBeLessThanOrEqual(100);
    });
    expect(elapsedMs).toBeLessThan(500);
  });
});

describe('A4 metrics, styles and external preview scale', () => {
  it('uses fixed A4 geometry and keeps zoom outside renderer measurement', () => {
    const model = createResumeRenderModel(rendererInput(createFixture().document));
    const metrics = getA4PageMetrics(model.page);

    expect(metrics).toMatchObject({
      widthMm: 210,
      heightMm: 297,
      contentWidthMm: 182,
      contentHeightMm: 269,
    });
    expect(
      computePreviewScale({
        mode: 'manual',
        viewportWidthPx: 800,
        viewportHeightPx: 600,
        manualScale: 3,
      }),
    ).toBe(2);
    expect(
      computePreviewScale({
        mode: 'fit-page',
        viewportWidthPx: metrics.widthPx + 48,
        viewportHeightPx: metrics.heightPx + 48,
      }),
    ).toBeCloseTo(1);
  });

  it('exports isolated white-paper CSS and document-derived variables', () => {
    const model = createResumeRenderModel(rendererInput(createFixture().document));
    const variables = createRendererCssVariables(model);

    expect(RESUME_RENDERER_CSS).toContain('width: 210mm');
    expect(RESUME_RENDERER_CSS).toContain('height: 297mm');
    expect(RESUME_RENDERER_CSS).toContain('background: #fff');
    expect(RESUME_RENDERER_CSS).not.toContain('overflow: hidden');
    expect(RESUME_RENDERER_CSS).toContain('box-shadow: none');
    expect(variables).toMatchObject({
      '--resume-body-size': '10.5pt',
      '--resume-margin-top': '14mm',
      '--resume-heading-color': '#171717',
    });
  });

  it('renders measurable A4 page DOM without executing user HTML or leaking internal IDs', () => {
    const { document, nextId } = createFixture();
    populateStandardDocument(document, nextId);
    const basicEntry = sectionByKind(document, 'basic').entries[0];
    if (!basicEntry) throw new Error('fixture 缺少基本信息条目');
    basicEntry.name = '<script>alert(1)</script>';
    const model = createResumeRenderModel(rendererInput(document));
    const flow = createRenderFlow(model);
    const pagination = paginateRenderFlow(
      flow,
      Object.fromEntries(flow.map((block) => [block.key, { heightPx: 10 }])),
      100,
    );

    const pagesHtml = renderToStaticMarkup(
      createElement(ResumePages, { model, pagination, assetsReady: true }),
    );
    const measurementHtml = renderToStaticMarkup(
      createElement(ResumeMeasurementSurface, { model, flow }),
    );

    expect(pagesHtml).toContain('class="resume-page"');
    expect(pagesHtml).toContain('data-render-ready="true"');
    expect(pagesHtml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(pagesHtml).not.toContain('<script>alert(1)</script>');
    expect(measurementHtml).toContain('data-render-block-key="header"');
    Object.keys(document.sectionsById).forEach((id) => {
      expect(pagesHtml).not.toContain(id);
      expect(measurementHtml).not.toContain(id);
    });
  });
});
