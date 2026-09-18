import {
  ResumeDocumentV1Schema,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';

import type { FontManifest, RenderPolicy, TemplateManifest } from './manifest';

export interface RenderLink {
  label: string;
  url: string;
}

export interface RenderContact {
  label: string;
  value: string;
}

export interface RenderEntry {
  heading: string;
  subheading: string;
  periodLabel: string;
  paragraphs: string[];
  bullets: string[];
  links: RenderLink[];
}

export interface RenderSection {
  title: string;
  style: { fontSizePt: number; fontWeight: number };
  entries: RenderEntry[];
}

export type RenderTypography = Omit<ResumeDocumentV1['typography'], 'moduleOverrides'>;

export interface ResumeRenderModel {
  rendererVersion: string;
  renderPolicyVersion: string;
  template: { id: string; version: string };
  locale: string;
  name: string;
  headline: string;
  avatarUrl: string | null;
  contacts: RenderContact[];
  links: RenderLink[];
  sections: RenderSection[];
  typography: RenderTypography;
  page: ResumeDocumentV1['page'];
  design: ResumeDocumentV1['design'];
  fontCssFamily: string;
}

export interface RendererInput {
  document: ResumeDocumentV1;
  templateManifest: TemplateManifest;
  fontManifest: FontManifest;
  renderPolicy: RenderPolicy;
  resolveAvatarUrl?: (assetId: string) => string | null;
}

export class RendererConfigurationError extends Error {
  constructor(
    readonly code:
      'TEMPLATE_MISMATCH' | 'FONT_NOT_ALLOWED' | 'FONT_NOT_FOUND' | 'UNSAFE_AVATAR_URL',
    message: string,
  ) {
    super(message);
    this.name = 'RendererConfigurationError';
  }
}

const nonBlank = (value: string) => value.trim().length > 0;
const textIfPresent = (value: string) => (nonBlank(value) ? value : '');
const listIfPresent = (values: readonly string[]) => values.filter(nonBlank);

function periodLabel(
  period: { start: string | null; end: string | null; current: boolean },
  locale: string,
): string {
  if (!period.start && !period.end && !period.current) return '';
  const end = period.current ? (locale.startsWith('zh') ? '至今' : 'Present') : (period.end ?? '');
  if (!period.start) return end;
  if (!end) return period.start;
  return `${period.start} – ${end}`;
}

function visibleLinks(
  links: ReadonlyArray<{ label: string; url: string; visible: boolean }>,
  policy: RenderPolicy,
): RenderLink[] {
  return links.flatMap((link) => {
    if (!link.visible || !nonBlank(link.label) || !nonBlank(link.url)) return [];
    const protocol = new URL(link.url).protocol as 'http:' | 'https:' | 'mailto:';
    return policy.allowedLinkProtocols.includes(protocol)
      ? [{ label: link.label, url: link.url }]
      : [];
  });
}

function isRenderEntryEmpty(entry: RenderEntry): boolean {
  return (
    !nonBlank(entry.heading) &&
    !nonBlank(entry.subheading) &&
    !nonBlank(entry.periodLabel) &&
    entry.paragraphs.length === 0 &&
    entry.bullets.length === 0 &&
    entry.links.length === 0
  );
}

function renderEntry(
  sectionValue: Exclude<ContentSection, { kind: 'basic' }>,
  entry: Exclude<ContentSection, { kind: 'basic' }>['entries'][number],
  locale: string,
  policy: RenderPolicy,
): RenderEntry {
  const empty: RenderEntry = {
    heading: '',
    subheading: '',
    periodLabel: '',
    paragraphs: [],
    bullets: [],
    links: [],
  };

  switch (sectionValue.kind) {
    case 'intent': {
      const intent = entry as Extract<ContentSection, { kind: 'intent' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(intent.targetRole),
        subheading: listIfPresent([
          ...intent.industries,
          ...intent.cities,
          intent.employmentType,
        ]).join(' · '),
      };
    }
    case 'summary':
    case 'selfEvaluation': {
      const textEntry = entry as Extract<
        ContentSection,
        { kind: 'summary' | 'selfEvaluation' }
      >['entries'][number];
      return { ...empty, paragraphs: textEntry.blocks.map((block) => block.text).filter(nonBlank) };
    }
    case 'education': {
      const education = entry as Extract<ContentSection, { kind: 'education' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(education.school),
        subheading: listIfPresent([
          education.major,
          education.degree,
          education.city,
          education.grade ?? '',
        ]).join(' · '),
        periodLabel: periodLabel(education.period, locale),
        paragraphs:
          education.courses.length > 0 ? [education.courses.filter(nonBlank).join('、')] : [],
        bullets: education.bullets.map((block) => block.text).filter(nonBlank),
      };
    }
    case 'work':
    case 'internship': {
      const employment = entry as Extract<
        ContentSection,
        { kind: 'work' | 'internship' }
      >['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(employment.organization),
        subheading: listIfPresent([
          employment.role,
          employment.city,
          employment.employmentType,
        ]).join(' · '),
        periodLabel: periodLabel(employment.period, locale),
        bullets: employment.bullets.map((block) => block.text).filter(nonBlank),
      };
    }
    case 'project': {
      const project = entry as Extract<ContentSection, { kind: 'project' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(project.name),
        subheading: textIfPresent(project.role),
        periodLabel: periodLabel(project.period, locale),
        paragraphs: [project.background.text].filter(nonBlank),
        bullets: [...project.bullets, ...project.actions, ...project.results]
          .map((block) => block.text)
          .filter(nonBlank),
        links: visibleLinks(project.links, policy),
      };
    }
    case 'campus': {
      const campus = entry as Extract<ContentSection, { kind: 'campus' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(campus.organization),
        subheading: textIfPresent(campus.role),
        periodLabel: periodLabel(campus.period, locale),
        paragraphs: [campus.activity].filter(nonBlank),
        bullets: campus.bullets.map((block) => block.text).filter(nonBlank),
      };
    }
    case 'skillsCertificates': {
      const skill = entry as Extract<
        ContentSection,
        { kind: 'skillsCertificates' }
      >['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(skill.name),
        subheading: listIfPresent([skill.proficiency ?? '', skill.issuer ?? '']).join(' · '),
        periodLabel: skill.obtainedAt ?? '',
        paragraphs: [skill.description.text].filter(nonBlank),
      };
    }
    case 'awards': {
      const award = entry as Extract<ContentSection, { kind: 'awards' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(award.name),
        subheading: listIfPresent([award.level, award.issuer]).join(' · '),
        periodLabel: award.awardedAt ?? '',
        paragraphs: [award.description.text].filter(nonBlank),
      };
    }
    case 'custom': {
      const custom = entry as Extract<ContentSection, { kind: 'custom' }>['entries'][number];
      return {
        ...empty,
        heading: textIfPresent(custom.heading),
        subheading: textIfPresent(custom.subheading),
        periodLabel: periodLabel(custom.period, locale),
        bullets: custom.bullets.map((block) => block.text).filter(nonBlank),
        links: visibleLinks(custom.links, policy),
      };
    }
  }
}

function renderSection(
  document: ResumeDocumentV1,
  sectionValue: Exclude<ContentSection, { kind: 'basic' }>,
  policy: RenderPolicy,
): RenderSection | null {
  const entries = sectionValue.entries
    .map((entry) => renderEntry(sectionValue, entry, document.locale, policy))
    .filter((entry) => !isRenderEntryEmpty(entry));
  if (entries.length === 0) return null;
  const override = document.typography.moduleOverrides[sectionValue.id];
  return {
    title: sectionValue.title,
    style: {
      fontSizePt: override?.fontSizePt ?? Math.min(document.typography.bodyFontSizePt + 2, 20),
      fontWeight: override?.fontWeight ?? 600,
    },
    entries,
  };
}

function avatarUrl(
  input: RendererInput,
  basic: Extract<ContentSection, { kind: 'basic' }> | undefined,
) {
  const entry = basic?.entries[0];
  if (
    !input.renderPolicy.allowAvatar ||
    !entry?.avatarVisible ||
    !entry.avatarAssetId ||
    !input.resolveAvatarUrl
  ) {
    return null;
  }
  const resolved = input.resolveAvatarUrl(entry.avatarAssetId);
  if (resolved !== null && (!resolved.startsWith('/') || resolved.startsWith('//'))) {
    throw new RendererConfigurationError('UNSAFE_AVATAR_URL', '头像必须使用同源绝对路径');
  }
  return resolved;
}

export function createResumeRenderModel(input: RendererInput): ResumeRenderModel {
  const document = ResumeDocumentV1Schema.parse(input.document);
  if (
    document.templateId !== input.templateManifest.id ||
    document.templateVersion !== input.templateManifest.version
  ) {
    throw new RendererConfigurationError(
      'TEMPLATE_MISMATCH',
      '文档模板引用与 Renderer manifest 不匹配',
    );
  }
  if (!input.templateManifest.allowedFontFamilyIds.includes(document.typography.fontFamilyId)) {
    throw new RendererConfigurationError('FONT_NOT_ALLOWED', '当前模板不允许使用所选字体');
  }
  const font = input.fontManifest.families.find(
    (candidate) => candidate.familyId === document.typography.fontFamilyId,
  );
  if (!font) throw new RendererConfigurationError('FONT_NOT_FOUND', '字体 manifest 缺少所选字体');

  const basic = Object.values(document.sectionsById).find(
    (sectionValue): sectionValue is Extract<ContentSection, { kind: 'basic' }> =>
      sectionValue.kind === 'basic' && sectionValue.visible,
  );
  const basicEntry = basic?.entries[0];
  const intent = Object.values(document.sectionsById).find(
    (sectionValue): sectionValue is Extract<ContentSection, { kind: 'intent' }> =>
      sectionValue.kind === 'intent' && sectionValue.visible,
  );
  const intentEntry = intent?.entries[0];
  const contacts: RenderContact[] = basicEntry
    ? [
        { label: '电话', ...basicEntry.phone },
        { label: '邮箱', ...basicEntry.email },
        { label: '城市', ...basicEntry.city },
      ].flatMap((contact) =>
        contact.visible && nonBlank(contact.value)
          ? [{ label: contact.label, value: contact.value }]
          : [],
      )
    : [];
  const sections = document.moduleOrder.flatMap((sectionId) => {
    const sectionValue = document.sectionsById[sectionId];
    if (!sectionValue?.visible || sectionValue.kind === 'basic' || sectionValue.kind === 'intent') {
      return [];
    }
    const projected = renderSection(document, sectionValue, input.renderPolicy);
    return projected ? [projected] : [];
  });

  return {
    rendererVersion: input.templateManifest.rendererVersion,
    renderPolicyVersion: input.renderPolicy.version,
    template: { id: input.templateManifest.id, version: input.templateManifest.version },
    locale: document.locale,
    name: basicEntry ? textIfPresent(basicEntry.name) : '',
    headline: intentEntry ? textIfPresent(intentEntry.targetRole) : '',
    avatarUrl: avatarUrl(input, basic),
    contacts,
    links: basicEntry ? visibleLinks(basicEntry.links, input.renderPolicy) : [],
    sections,
    typography: {
      fontFamilyId: document.typography.fontFamilyId,
      bodyFontSizePt: document.typography.bodyFontSizePt,
      lineHeight: document.typography.lineHeight,
      sectionGapMm: document.typography.sectionGapMm,
      paragraphGapMm: document.typography.paragraphGapMm,
    },
    page: document.page,
    design: document.design,
    fontCssFamily: font.cssFamily,
  };
}
