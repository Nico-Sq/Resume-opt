'use client';

import {
  type ContentSection,
  type StringListField,
  type TextBlockListField,
} from '@resume/domain/resume';
import { useId, useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';

import { useResumeEditorStore, useResumeEditorStoreApi, useResumeTextField } from './store';
import styles from './editor-workspace.module.css';

interface SectionFieldsEditorProps {
  section: ContentSection;
  onFlushSave: () => Promise<void>;
}

interface EntryTarget {
  sectionId: string;
  entryId: string;
}

interface TextFieldProps extends EntryTarget {
  label: string;
  path: ReadonlyArray<string | number>;
  value: string | null;
  onFlushSave: () => Promise<void>;
  multiline?: boolean;
  maxLength?: number;
  placeholder?: string;
  type?: 'text' | 'email' | 'tel' | 'url';
}

function TextField({
  label,
  sectionId,
  entryId,
  path,
  value,
  onFlushSave,
  multiline = false,
  maxLength = 200,
  placeholder,
  type = 'text',
}: TextFieldProps) {
  const store = useResumeEditorStoreApi();
  const { control } = useForm<{ value: string }>({ defaultValues: { value: value ?? '' } });
  const { field } = useResumeTextField({
    control,
    name: 'value',
    store,
    target: { sectionId, entryId, path },
  });
  const inputId = useId();
  const common = {
    id: inputId,
    maxLength,
    name: field.name,
    onBlur: () => {
      field.onBlur();
      void onFlushSave();
    },
    onChange: field.onChange,
    onCompositionEnd: field.onCompositionEnd,
    onCompositionStart: field.onCompositionStart,
    placeholder,
    ref: field.ref,
    value: field.value,
  };

  return (
    <label className={multiline ? styles.wideField : undefined} htmlFor={inputId}>
      <span>{label}</span>
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} type={type} />}
    </label>
  );
}

function isAllowedLink(value: string): boolean {
  if (value === '') return true;
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function UrlField({
  sectionId,
  entryId,
  path,
  value,
  onFlushSave,
  label = '链接地址',
}: EntryTarget & {
  path: ReadonlyArray<string | number>;
  value: string;
  onFlushSave: () => Promise<void>;
  label?: string;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  const beginHistoryGroup = useResumeEditorStore((state) => state.beginHistoryGroup);
  const endHistoryGroup = useResumeEditorStore((state) => state.endHistoryGroup);
  const [lastStoreValue, setLastStoreValue] = useState(value);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const groupId = `url:${sectionId}:${entryId}:${JSON.stringify(path)}`;
  if (value !== lastStoreValue) {
    setLastStoreValue(value);
    setDraft(value);
    setError('');
  }

  return (
    <label htmlFor={inputId}>
      <span>{label}</span>
      <input
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        id={inputId}
        maxLength={2_048}
        onBlur={() => {
          endHistoryGroup(groupId);
          if (!isAllowedLink(draft)) {
            setError('请输入以 http://、https:// 或 mailto: 开头的完整地址');
            return;
          }
          setError('');
          dispatch({ type: 'set-entry-field', sectionId, entryId, path, value: draft });
          void onFlushSave();
        }}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError('');
        }}
        onFocus={() => {
          beginHistoryGroup(groupId);
        }}
        placeholder="https://example.com"
        type="url"
        value={draft}
      />
      {error ? (
        <small className={styles.fieldError} id={errorId} role="alert">
          {error}
        </small>
      ) : null}
    </label>
  );
}

function MonthField({
  label,
  sectionId,
  entryId,
  path,
  value,
  onFlushSave,
  disabled = false,
}: EntryTarget & {
  label: string;
  path: ReadonlyArray<string | number>;
  value: string | null;
  onFlushSave: () => Promise<void>;
  disabled?: boolean;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <label>
      <span>{label}</span>
      <input
        disabled={disabled}
        onBlur={() => void onFlushSave()}
        onChange={(event) => {
          dispatch({
            type: 'set-entry-field',
            sectionId,
            entryId,
            path,
            value: event.currentTarget.value || null,
          });
        }}
        type="month"
        value={value ?? ''}
      />
    </label>
  );
}

function ToggleField({
  label,
  sectionId,
  entryId,
  path,
  checked,
  onFlushSave,
  beforeEnable,
}: EntryTarget & {
  label: string;
  path: ReadonlyArray<string | number>;
  checked: boolean;
  onFlushSave: () => Promise<void>;
  beforeEnable?: () => void;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <label className={styles.checkboxField}>
      <input
        checked={checked}
        onChange={(event) => {
          if (event.currentTarget.checked) beforeEnable?.();
          dispatch({
            type: 'set-entry-field',
            sectionId,
            entryId,
            path,
            value: event.currentTarget.checked,
          });
          void onFlushSave();
        }}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  );
}

function SelectField({
  label,
  sectionId,
  entryId,
  path,
  value,
  options,
  onFlushSave,
}: EntryTarget & {
  label: string;
  path: ReadonlyArray<string | number>;
  value: string;
  options: ReadonlyArray<{ label: string; value: string }>;
  onFlushSave: () => Promise<void>;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <label>
      <span>{label}</span>
      <select
        onChange={(event) => {
          dispatch({
            type: 'set-entry-field',
            sectionId,
            entryId,
            path,
            value: event.currentTarget.value,
          });
          void onFlushSave();
        }}
        value={value}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function StringListEditor({
  label,
  sectionId,
  entryId,
  field,
  values,
  onFlushSave,
  placeholder = '使用顿号、逗号或换行分隔',
}: EntryTarget & {
  label: string;
  field: StringListField;
  values: readonly string[];
  onFlushSave: () => Promise<void>;
  placeholder?: string;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  const beginHistoryGroup = useResumeEditorStore((state) => state.beginHistoryGroup);
  const endHistoryGroup = useResumeEditorStore((state) => state.endHistoryGroup);
  const signature = values.join('\u0000');
  const [rawValue, setRawValue] = useState(values.join('、'));
  const groupId = `list:${sectionId}:${entryId}:${field}`;
  const parseList = (value: string) =>
    value
      .split(/[，,、\n]/u)
      .map((item) => item.trim())
      .filter(Boolean);
  if (parseList(rawValue).join('\u0000') !== signature) {
    setRawValue(values.join('、'));
  }

  return (
    <label className={styles.wideField}>
      <span>{label}</span>
      <textarea
        maxLength={1_000}
        onBlur={() => {
          endHistoryGroup(groupId);
          void onFlushSave();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setRawValue(next);
          dispatch({
            type: 'set-string-list-field',
            sectionId,
            entryId,
            field,
            values: parseList(next),
          });
        }}
        onFocus={() => {
          beginHistoryGroup(groupId);
        }}
        placeholder={placeholder}
        rows={2}
        value={rawValue}
      />
    </label>
  );
}

function TextBlockListEditor({
  label,
  sectionId,
  entryId,
  field,
  blocks,
  onFlushSave,
}: EntryTarget & {
  label: string;
  field: TextBlockListField;
  blocks: ReadonlyArray<{ id: string; text: string }>;
  onFlushSave: () => Promise<void>;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <fieldset className={styles.nestedFieldset}>
      <legend>{label}</legend>
      {blocks.map((block, index) => (
        <div className={styles.inlineEditor} key={block.id}>
          <TextField
            entryId={entryId}
            label={`${label} ${String(index + 1)}`}
            maxLength={4_000}
            multiline
            onFlushSave={onFlushSave}
            path={[field, index, 'text']}
            sectionId={sectionId}
            value={block.text}
          />
          <button
            aria-label={`删除${label} ${String(index + 1)}`}
            onClick={() => {
              dispatch({ type: 'remove-text-block', sectionId, entryId, field, blockId: block.id });
              void onFlushSave();
            }}
            type="button"
          >
            删除
          </button>
        </div>
      ))}
      <button
        className={styles.inlineAddButton}
        onClick={() => {
          dispatch({ type: 'add-text-block', sectionId, entryId, field });
        }}
        type="button"
      >
        添加{label}
      </button>
    </fieldset>
  );
}

function LinkListEditor({
  sectionId,
  entryId,
  links,
  onFlushSave,
}: EntryTarget & {
  links: ReadonlyArray<{ id: string; label: string; url: string; visible: boolean }>;
  onFlushSave: () => Promise<void>;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <fieldset className={styles.nestedFieldset}>
      <legend>链接</legend>
      {links.map((link, index) => (
        <div className={styles.linkEditor} key={link.id}>
          <TextField
            entryId={entryId}
            label="链接名称"
            maxLength={100}
            onFlushSave={onFlushSave}
            path={['links', index, 'label']}
            sectionId={sectionId}
            value={link.label}
          />
          <UrlField
            entryId={entryId}
            onFlushSave={onFlushSave}
            path={['links', index, 'url']}
            sectionId={sectionId}
            value={link.url}
          />
          <ToggleField
            checked={link.visible}
            entryId={entryId}
            label="在预览中显示"
            onFlushSave={onFlushSave}
            path={['links', index, 'visible']}
            sectionId={sectionId}
          />
          <button
            aria-label={`删除链接 ${String(index + 1)}`}
            onClick={() => {
              dispatch({ type: 'remove-link', sectionId, entryId, linkId: link.id });
              void onFlushSave();
            }}
            type="button"
          >
            删除链接
          </button>
        </div>
      ))}
      <button
        className={styles.inlineAddButton}
        onClick={() => dispatch({ type: 'add-link', sectionId, entryId })}
        type="button"
      >
        添加链接
      </button>
    </fieldset>
  );
}

function PeriodEditor({
  sectionId,
  entryId,
  period,
  onFlushSave,
}: EntryTarget & {
  period: { start: string | null; end: string | null; current: boolean };
  onFlushSave: () => Promise<void>;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <div className={styles.periodFields}>
      <MonthField
        entryId={entryId}
        label="开始月份"
        onFlushSave={onFlushSave}
        path={['period', 'start']}
        sectionId={sectionId}
        value={period.start}
      />
      <MonthField
        disabled={period.current}
        entryId={entryId}
        label="结束月份"
        onFlushSave={onFlushSave}
        path={['period', 'end']}
        sectionId={sectionId}
        value={period.end}
      />
      <ToggleField
        beforeEnable={() => {
          if (period.end === null) return;
          dispatch({
            type: 'set-entry-field',
            sectionId,
            entryId,
            path: ['period', 'end'],
            value: null,
          });
        }}
        checked={period.current}
        entryId={entryId}
        label="至今"
        onFlushSave={onFlushSave}
        path={['period', 'current']}
        sectionId={sectionId}
      />
    </div>
  );
}

function EntryCard({
  title,
  children,
  sectionId,
  entryId,
  onFlushSave,
}: EntryTarget & {
  title: string;
  children: ReactNode;
  onFlushSave: () => Promise<void>;
}) {
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  return (
    <details className={styles.entryCard} open>
      <summary>{title}</summary>
      <div className={styles.entryCardBody}>{children}</div>
      <div className={styles.entryActions}>
        <button onClick={() => dispatch({ type: 'copy-entry', sectionId, entryId })} type="button">
          复制条目
        </button>
        <button
          onClick={() => {
            dispatch({ type: 'remove-entry', sectionId, entryId });
            void onFlushSave();
          }}
          type="button"
        >
          删除条目
        </button>
      </div>
    </details>
  );
}

function BasicEditor({
  section,
  onFlushSave,
}: {
  section: Extract<ContentSection, { kind: 'basic' }>;
  onFlushSave: () => Promise<void>;
}) {
  const document = useResumeEditorStore((state) => state.document);
  const entry = section.entries[0];
  if (!entry) return <p className={styles.emptyState}>基本信息数据缺失。</p>;
  const target = { sectionId: section.id, entryId: entry.id };
  const intent = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: 'intent' }> =>
      candidate.kind === 'intent',
  );
  const intentEntry = intent?.entries[0];
  const summary = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: 'summary' }> =>
      candidate.kind === 'summary',
  );
  const summaryEntry = summary?.entries[0];
  const summaryBlock = summaryEntry?.blocks[0];
  const website = entry.links[0];
  return (
    <div className={styles.fieldGrid}>
      <TextField
        {...target}
        label="姓名"
        onFlushSave={onFlushSave}
        path={['name']}
        value={entry.name}
      />
      {intent && intentEntry ? (
        <TextField
          entryId={intentEntry.id}
          label="求职岗位"
          onFlushSave={onFlushSave}
          path={['targetRole']}
          sectionId={intent.id}
          value={intentEntry.targetRole}
        />
      ) : null}
      <TextField
        {...target}
        label="手机号"
        onFlushSave={onFlushSave}
        path={['phone', 'value']}
        type="tel"
        value={entry.phone.value}
      />
      <TextField
        {...target}
        label="邮箱"
        onFlushSave={onFlushSave}
        path={['email', 'value']}
        type="email"
        value={entry.email.value}
      />
      <TextField
        {...target}
        label="所在城市"
        onFlushSave={onFlushSave}
        path={['city', 'value']}
        value={entry.city.value}
      />
      {website ? (
        <UrlField
          {...target}
          label="个人网站"
          onFlushSave={onFlushSave}
          path={['links', 0, 'url']}
          value={website.url}
        />
      ) : null}
      {summary && summaryEntry && summaryBlock ? (
        <TextField
          entryId={summaryEntry.id}
          label="个人简介"
          maxLength={4_000}
          multiline
          onFlushSave={onFlushSave}
          path={['blocks', 0, 'text']}
          sectionId={summary.id}
          value={summaryBlock.text}
        />
      ) : null}
    </div>
  );
}

function IntentEditor({
  section,
  onFlushSave,
}: {
  section: Extract<ContentSection, { kind: 'intent' }>;
  onFlushSave: () => Promise<void>;
}) {
  const entry = section.entries[0];
  if (!entry) return <p className={styles.emptyState}>求职意向数据缺失。</p>;
  const target = { sectionId: section.id, entryId: entry.id };
  return (
    <div className={styles.fieldGrid}>
      <TextField
        {...target}
        label="目标职位"
        onFlushSave={onFlushSave}
        path={['targetRole']}
        value={entry.targetRole}
      />
      <TextField
        {...target}
        label="工作性质"
        onFlushSave={onFlushSave}
        path={['employmentType']}
        value={entry.employmentType}
      />
      <StringListEditor
        {...target}
        field="industries"
        label="目标行业"
        onFlushSave={onFlushSave}
        values={entry.industries}
      />
      <StringListEditor
        {...target}
        field="cities"
        label="意向城市"
        onFlushSave={onFlushSave}
        values={entry.cities}
      />
    </div>
  );
}

function BlockSectionEditor({
  section,
  onFlushSave,
}: {
  section: Extract<ContentSection, { kind: 'summary' | 'selfEvaluation' }>;
  onFlushSave: () => Promise<void>;
}) {
  const entry = section.entries[0];
  if (!entry) return <p className={styles.emptyState}>文本模块数据缺失。</p>;
  return (
    <TextBlockListEditor
      blocks={entry.blocks}
      entryId={entry.id}
      field="blocks"
      label="段落"
      onFlushSave={onFlushSave}
      sectionId={section.id}
    />
  );
}

export function SectionFieldsEditor({ section, onFlushSave }: SectionFieldsEditorProps) {
  const text = (
    entryId: string,
    label: string,
    path: ReadonlyArray<string | number>,
    value: string | null,
    multiline = false,
  ) => (
    <TextField
      entryId={entryId}
      label={label}
      maxLength={multiline ? 4_000 : 200}
      multiline={multiline}
      onFlushSave={onFlushSave}
      path={path}
      sectionId={section.id}
      value={value}
    />
  );
  const blocks = (
    entryId: string,
    label: string,
    field: TextBlockListField,
    values: ReadonlyArray<{ id: string; text: string }>,
  ) => (
    <TextBlockListEditor
      blocks={values}
      entryId={entryId}
      field={field}
      label={label}
      onFlushSave={onFlushSave}
      sectionId={section.id}
    />
  );
  const period = (
    entryId: string,
    value: { start: string | null; end: string | null; current: boolean },
  ) => (
    <PeriodEditor
      entryId={entryId}
      onFlushSave={onFlushSave}
      period={value}
      sectionId={section.id}
    />
  );
  const list = (
    entryId: string,
    label: string,
    field: StringListField,
    values: readonly string[],
  ) => (
    <StringListEditor
      entryId={entryId}
      field={field}
      label={label}
      onFlushSave={onFlushSave}
      sectionId={section.id}
      values={values}
    />
  );

  switch (section.kind) {
    case 'basic':
      return <BasicEditor onFlushSave={onFlushSave} section={section} />;
    case 'intent':
      return <IntentEditor onFlushSave={onFlushSave} section={section} />;
    case 'summary':
    case 'selfEvaluation':
      return <BlockSectionEditor onFlushSave={onFlushSave} section={section} />;
    case 'education':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`教育经历 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '学校', ['school'], entry.school)}
            {text(entry.id, '专业', ['major'], entry.major)}
            {text(entry.id, '学历', ['degree'], entry.degree)}
            {text(entry.id, '城市', ['city'], entry.city)}
            {text(entry.id, '成绩', ['grade'], entry.grade)}
            {period(entry.id, entry.period)}
            {list(entry.id, '主修课程', 'courses', entry.courses)}
            {blocks(entry.id, '经历要点', 'bullets', entry.bullets)}
          </div>
        </EntryCard>
      ));
    case 'work':
    case 'internship':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`${section.kind === 'work' ? '工作' : '实习'}经历 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '单位', ['organization'], entry.organization)}
            {text(entry.id, '职位', ['role'], entry.role)}
            {text(entry.id, '城市', ['city'], entry.city)}
            {text(entry.id, '工作性质', ['employmentType'], entry.employmentType)}
            {period(entry.id, entry.period)}
            {blocks(entry.id, '工作要点', 'bullets', entry.bullets)}
          </div>
        </EntryCard>
      ));
    case 'project':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`项目经历 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '项目名称', ['name'], entry.name)}
            {text(entry.id, '担任角色', ['role'], entry.role)}
            {period(entry.id, entry.period)}
            {text(entry.id, '项目背景', ['background', 'text'], entry.background.text, true)}
            {list(entry.id, '技术栈', 'technologies', entry.technologies)}
            {blocks(entry.id, '项目要点', 'bullets', entry.bullets)}
            {blocks(entry.id, '关键行动', 'actions', entry.actions)}
            {blocks(entry.id, '项目结果', 'results', entry.results)}
            <LinkListEditor
              entryId={entry.id}
              links={entry.links}
              onFlushSave={onFlushSave}
              sectionId={section.id}
            />
          </div>
        </EntryCard>
      ));
    case 'campus':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`校园经历 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '组织', ['organization'], entry.organization)}
            {text(entry.id, '角色', ['role'], entry.role)}
            {period(entry.id, entry.period)}
            {text(entry.id, '活动描述', ['activity'], entry.activity, true)}
            {blocks(entry.id, '经历要点', 'bullets', entry.bullets)}
          </div>
        </EntryCard>
      ));
    case 'skillsCertificates':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`技能或证书 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            <SelectField
              entryId={entry.id}
              label="类型"
              onFlushSave={onFlushSave}
              options={[
                { label: '技能', value: 'skill' },
                { label: '证书', value: 'certificate' },
              ]}
              path={['type']}
              sectionId={section.id}
              value={entry.type}
            />
            {text(entry.id, '名称', ['name'], entry.name)}
            {text(entry.id, '熟练度', ['proficiency'], entry.proficiency)}
            {text(entry.id, '颁发机构', ['issuer'], entry.issuer)}
            <MonthField
              entryId={entry.id}
              label="获得月份"
              onFlushSave={onFlushSave}
              path={['obtainedAt']}
              sectionId={section.id}
              value={entry.obtainedAt}
            />
            {text(entry.id, '说明', ['description', 'text'], entry.description.text, true)}
          </div>
        </EntryCard>
      ));
    case 'awards':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`奖项 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '奖项名称', ['name'], entry.name)}
            {text(entry.id, '级别', ['level'], entry.level)}
            {text(entry.id, '颁发机构', ['issuer'], entry.issuer)}
            <MonthField
              entryId={entry.id}
              label="获奖月份"
              onFlushSave={onFlushSave}
              path={['awardedAt']}
              sectionId={section.id}
              value={entry.awardedAt}
            />
            {text(entry.id, '说明', ['description', 'text'], entry.description.text, true)}
          </div>
        </EntryCard>
      ));
    case 'custom':
      return section.entries.map((entry, index) => (
        <EntryCard
          entryId={entry.id}
          key={entry.id}
          onFlushSave={onFlushSave}
          sectionId={section.id}
          title={`自定义内容 ${String(index + 1)}`}
        >
          <div className={styles.fieldGrid}>
            {text(entry.id, '主标题', ['heading'], entry.heading)}
            {text(entry.id, '副标题', ['subheading'], entry.subheading)}
            {period(entry.id, entry.period)}
            {blocks(entry.id, '内容要点', 'bullets', entry.bullets)}
            <LinkListEditor
              entryId={entry.id}
              links={entry.links}
              onFlushSave={onFlushSave}
              sectionId={section.id}
            />
          </div>
        </EntryCard>
      ));
  }
}
