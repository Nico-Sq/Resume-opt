import { z } from 'zod';

const UUIDSchema = z.uuid();
const MonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/u, '月份必须使用 YYYY-MM')
  .nullable();
const ShortTextSchema = z.string().max(200);
const BodyTextSchema = z.string().max(4_000);

export const TextBlockSchema = z.strictObject({ id: UUIDSchema, text: BodyTextSchema });

export const PeriodSchema = z
  .strictObject({ start: MonthSchema, end: MonthSchema, current: z.boolean() })
  .refine((value) => !value.current || value.end === null, {
    message: '仍在进行时结束月份必须为空',
    path: ['end'],
  });

export const ContactSchema = z.strictObject({ value: ShortTextSchema, visible: z.boolean() });

export const LinkSchema = z.strictObject({
  id: UUIDSchema,
  label: z.string().max(100),
  url: z
    .string()
    .max(2_048)
    .refine((value) => {
      if (value === '') return true;
      try {
        return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
      } catch {
        return false;
      }
    }, '链接只允许 http、https 或 mailto'),
  visible: z.boolean(),
});

const EntryBaseShape = {
  id: UUIDSchema,
  period: PeriodSchema,
  bullets: z.array(TextBlockSchema).max(50),
};

const EducationSchema = z.strictObject({
  ...EntryBaseShape,
  school: ShortTextSchema,
  major: ShortTextSchema,
  degree: ShortTextSchema,
  city: ShortTextSchema,
  courses: z.array(ShortTextSchema).max(30),
  grade: ShortTextSchema.nullable(),
});

const EmploymentSchema = z.strictObject({
  ...EntryBaseShape,
  organization: ShortTextSchema,
  role: ShortTextSchema,
  city: ShortTextSchema,
  employmentType: ShortTextSchema,
});

const ProjectSchema = z.strictObject({
  ...EntryBaseShape,
  name: ShortTextSchema,
  role: ShortTextSchema,
  background: TextBlockSchema,
  actions: z.array(TextBlockSchema).max(50),
  results: z.array(TextBlockSchema).max(50),
  technologies: z.array(ShortTextSchema).max(50),
  links: z.array(LinkSchema).max(20),
});

const CampusSchema = z.strictObject({
  ...EntryBaseShape,
  organization: ShortTextSchema,
  role: ShortTextSchema,
  activity: BodyTextSchema,
});

const SkillCertificateSchema = z.strictObject({
  id: UUIDSchema,
  type: z.enum(['skill', 'certificate']),
  name: ShortTextSchema,
  proficiency: ShortTextSchema.nullable(),
  issuer: ShortTextSchema.nullable(),
  obtainedAt: MonthSchema,
  description: TextBlockSchema,
});

const AwardSchema = z.strictObject({
  id: UUIDSchema,
  name: ShortTextSchema,
  level: ShortTextSchema,
  issuer: ShortTextSchema,
  awardedAt: MonthSchema,
  description: TextBlockSchema,
});

const CustomEntrySchema = z.strictObject({
  ...EntryBaseShape,
  heading: ShortTextSchema,
  subheading: ShortTextSchema,
  links: z.array(LinkSchema).max(20),
});

function section<K extends string, T extends z.ZodType>(kind: K, entry: T) {
  return z.strictObject({
    id: UUIDSchema,
    kind: z.literal(kind),
    title: z.string().min(1).max(100),
    visible: z.boolean(),
    entries: z.array(entry).max(100),
  });
}

const BasicSectionSchema = section(
  'basic',
  z.strictObject({
    id: UUIDSchema,
    name: ShortTextSchema,
    avatarAssetId: UUIDSchema.nullable(),
    avatarVisible: z.boolean(),
    phone: ContactSchema,
    email: ContactSchema,
    city: ContactSchema,
    links: z.array(LinkSchema).max(20),
  }),
);
const IntentSectionSchema = section(
  'intent',
  z.strictObject({
    id: UUIDSchema,
    targetRole: ShortTextSchema,
    industries: z.array(ShortTextSchema).max(20),
    cities: z.array(ShortTextSchema).max(20),
    employmentType: ShortTextSchema,
  }),
);
const SummarySectionSchema = section(
  'summary',
  z.strictObject({ id: UUIDSchema, blocks: z.array(TextBlockSchema).max(20) }),
);
const SelfEvaluationSectionSchema = section(
  'selfEvaluation',
  z.strictObject({ id: UUIDSchema, blocks: z.array(TextBlockSchema).max(20) }),
);

export const ContentSectionSchema = z.discriminatedUnion('kind', [
  BasicSectionSchema,
  IntentSectionSchema,
  SummarySectionSchema,
  section('education', EducationSchema),
  section('work', EmploymentSchema),
  section('project', ProjectSchema),
  section('internship', EmploymentSchema),
  section('campus', CampusSchema),
  section('skillsCertificates', SkillCertificateSchema),
  section('awards', AwardSchema),
  SelfEvaluationSectionSchema,
  section('custom', CustomEntrySchema),
]);

export const ResumeDocumentV1ShapeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  locale: z.string().min(2).max(35),
  stage: z.enum(['student', 'employed', 'transition']),
  sectionsById: z.record(UUIDSchema, ContentSectionSchema),
  moduleOrder: z.array(UUIDSchema).max(50),
  templateId: z.string().min(1).max(100),
  templateVersion: z.string().min(1).max(50),
  typography: z.strictObject({
    fontFamilyId: z.string().min(1).max(100),
    bodyFontSizePt: z.number().min(8).max(14),
    lineHeight: z.number().min(1).max(2),
    sectionGapMm: z.number().min(0).max(20),
    paragraphGapMm: z.number().min(0).max(20),
    moduleOverrides: z.record(
      UUIDSchema,
      z.strictObject({
        fontSizePt: z.number().min(8).max(20),
        fontWeight: z.number().int().min(400).max(700),
      }),
    ),
  }),
  page: z.strictObject({
    format: z.literal('A4'),
    marginMm: z.strictObject({
      top: z.number().min(8).max(30),
      right: z.number().min(8).max(30),
      bottom: z.number().min(8).max(30),
      left: z.number().min(8).max(30),
    }),
    showPageNumbers: z.boolean(),
  }),
  design: z.strictObject({
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    headingColor: z.string().regex(/^#[0-9a-fA-F]{6}$/u),
    divider: z.boolean(),
  }),
});

function collectIds(section: z.infer<typeof ContentSectionSchema>): string[] {
  const ids = [section.id];
  for (const entry of section.entries) {
    ids.push(entry.id);
    if ('bullets' in entry) ids.push(...entry.bullets.map((block) => block.id));
    if ('blocks' in entry) ids.push(...entry.blocks.map((block) => block.id));
    if ('background' in entry) ids.push(entry.background.id);
    if ('actions' in entry) ids.push(...entry.actions.map((block) => block.id));
    if ('results' in entry) ids.push(...entry.results.map((block) => block.id));
    if ('description' in entry) ids.push(entry.description.id);
    if ('links' in entry) ids.push(...entry.links.map((link) => link.id));
  }
  return ids;
}

export const ResumeDocumentV1Schema = ResumeDocumentV1ShapeSchema.superRefine(
  (document, context) => {
    const sectionEntries = Object.entries(document.sectionsById);
    const orderSet = new Set(document.moduleOrder);
    const sectionIds = new Set(sectionEntries.map(([id]) => id));

    if (orderSet.size !== document.moduleOrder.length || orderSet.size !== sectionIds.size) {
      context.addIssue({
        code: 'custom',
        path: ['moduleOrder'],
        message: '模块顺序必须无重复并完整覆盖全部模块',
      });
    }
    for (const id of orderSet) {
      if (!sectionIds.has(id)) {
        context.addIssue({
          code: 'custom',
          path: ['moduleOrder'],
          message: '模块顺序包含未知模块',
        });
      }
    }

    const singletonKinds = new Set(['basic', 'intent', 'summary', 'selfEvaluation']);
    const kindCounts = new Map<string, number>();
    const allIds: string[] = [];
    for (const [mapId, sectionValue] of sectionEntries) {
      if (mapId !== sectionValue.id) {
        context.addIssue({
          code: 'custom',
          path: ['sectionsById', mapId, 'id'],
          message: '模块 map key 必须等于模块 id',
        });
      }
      kindCounts.set(sectionValue.kind, (kindCounts.get(sectionValue.kind) ?? 0) + 1);
      allIds.push(...collectIds(sectionValue));
    }
    if (kindCounts.get('basic') !== 1) {
      context.addIssue({
        code: 'custom',
        path: ['sectionsById'],
        message: '必须且只能有一个基本信息模块',
      });
    }
    for (const kind of singletonKinds) {
      if ((kindCounts.get(kind) ?? 0) > 1) {
        context.addIssue({
          code: 'custom',
          path: ['sectionsById'],
          message: `${kind} 模块最多一个`,
        });
      }
    }
    if (new Set(allIds).size !== allIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['sectionsById'],
        message: '文档内所有 ID 必须唯一',
      });
    }
  },
);

export type ResumeDocumentV1 = z.infer<typeof ResumeDocumentV1Schema>;
export type ContentSection = z.infer<typeof ContentSectionSchema>;
