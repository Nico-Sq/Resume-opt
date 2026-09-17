import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from './schema';

export type IdFactory = () => string;

export function createInitialResumeDocument(
  idFactory: IdFactory = () => crypto.randomUUID(),
): ResumeDocumentV1 {
  const sections = [
    {
      id: idFactory(),
      kind: 'basic',
      title: '基本信息',
      visible: true,
      entries: [
        {
          id: idFactory(),
          name: '',
          avatarAssetId: null,
          avatarVisible: false,
          phone: { value: '', visible: true },
          email: { value: '', visible: true },
          city: { value: '', visible: true },
          links: [],
        },
      ],
    },
    {
      id: idFactory(),
      kind: 'intent',
      title: '求职意向',
      visible: true,
      entries: [
        {
          id: idFactory(),
          targetRole: '',
          industries: [],
          cities: [],
          employmentType: '',
        },
      ],
    },
    {
      id: idFactory(),
      kind: 'summary',
      title: '职业概要',
      visible: false,
      entries: [{ id: idFactory(), blocks: [] }],
    },
    { id: idFactory(), kind: 'education', title: '教育背景', visible: true, entries: [] },
    { id: idFactory(), kind: 'work', title: '工作经历', visible: false, entries: [] },
    { id: idFactory(), kind: 'project', title: '项目经历', visible: true, entries: [] },
    { id: idFactory(), kind: 'internship', title: '实习经历', visible: true, entries: [] },
    { id: idFactory(), kind: 'campus', title: '校园经历', visible: true, entries: [] },
    {
      id: idFactory(),
      kind: 'skillsCertificates',
      title: '技能与证书',
      visible: true,
      entries: [],
    },
    { id: idFactory(), kind: 'awards', title: '奖项荣誉', visible: true, entries: [] },
    {
      id: idFactory(),
      kind: 'selfEvaluation',
      title: '自我评价',
      visible: true,
      entries: [{ id: idFactory(), blocks: [] }],
    },
  ];
  const sectionsById = Object.fromEntries(
    sections.map((sectionValue) => [sectionValue.id, sectionValue]),
  );

  return ResumeDocumentV1Schema.parse({
    schemaVersion: 1,
    locale: 'zh-CN',
    stage: 'student',
    sectionsById,
    moduleOrder: sections.map((sectionValue) => sectionValue.id),
    templateId: 'ats-basic',
    templateVersion: '1.0.0',
    typography: {
      fontFamilyId: 'noto-sans-sc',
      bodyFontSizePt: 10.5,
      lineHeight: 1.45,
      sectionGapMm: 4,
      paragraphGapMm: 2,
      moduleOverrides: {},
    },
    page: {
      format: 'A4',
      marginMm: { top: 14, right: 14, bottom: 14, left: 14 },
      showPageNumbers: false,
    },
    design: { accentColor: '#171717', headingColor: '#171717', divider: true },
  });
}
