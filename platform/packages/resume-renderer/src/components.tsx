import type { CSSProperties, ReactElement, ReactNode } from 'react';

import type { RenderFlowBlock } from './flow';
import type { PagePlacement, PaginationResult } from './pagination';
import type { ResumeRenderModel } from './projector';
import { createRendererCssVariables, RESUME_RENDERER_CSS } from './styles';

interface BlockViewProps {
  block: RenderFlowBlock;
  placement?: Pick<PagePlacement, 'continuedFromPrevious' | 'continuesOnNext'>;
  measurement?: boolean;
}

function ContactIcon({ label }: { label: string }): ReactElement {
  const common = {
    'aria-hidden': true,
    className: 'resume-contact-icon',
    fill: 'none',
    height: 14,
    viewBox: '0 0 24 24',
    width: 14,
  } as const;
  if (label === '电话') {
    return (
      <svg {...common}>
        <path
          d="M6.6 3.8 9 8.1 6.9 9.8c1.4 3 3.6 5.2 6.6 6.6l1.7-2.1 4.3 2.4-.8 3.1c-.2.7-.8 1.2-1.5 1.2C9.4 20.6 3.4 14.6 3 6.8c0-.7.5-1.3 1.2-1.5l2.4-.7Z"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }
  if (label === '邮箱') {
    return (
      <svg {...common}>
        <rect height="14" rx="1.5" stroke="currentColor" strokeWidth="1.7" width="18" x="3" y="5" />
        <path
          d="m4 7 8 6 8-6"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.7"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
      <circle cx="12" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function linksView(links: ReadonlyArray<{ label: string; url: string }>): ReactNode {
  return links.map((link, index) => (
    <a href={link.url} key={`${link.url}-${String(index)}`} rel="noreferrer">
      {link.label}
    </a>
  ));
}

function BlockView({ block, placement, measurement = false }: BlockViewProps): ReactElement {
  const common = {
    'data-render-block-key': measurement ? block.key : undefined,
    'data-continued-from-previous': placement?.continuedFromPrevious ? 'true' : undefined,
    'data-continues-on-next': placement?.continuesOnNext ? 'true' : undefined,
  };
  switch (block.kind) {
    case 'header':
      return (
        <header className="resume-header" {...common}>
          {block.avatarUrl ? (
            // Shared browser/PDF renderer cannot depend on Next.js image optimization.
            // eslint-disable-next-line @next/next/no-img-element
            <img alt="" className="resume-avatar" src={block.avatarUrl} />
          ) : null}
          {block.name ? <h1 className="resume-name">{block.name}</h1> : null}
          {block.headline ? <p className="resume-headline">{block.headline}</p> : null}
          {block.contacts.length > 0 ? (
            <div className="resume-contact-list">
              {block.contacts.map((contact, index) => (
                <span
                  aria-label={`${contact.label}：${contact.value}`}
                  key={`${contact.label}-${String(index)}`}
                >
                  <ContactIcon label={contact.label} />
                  {contact.value}
                </span>
              ))}
            </div>
          ) : null}
          {block.links.length > 0 ? (
            <nav aria-label="个人链接" className="resume-link-list">
              {linksView(block.links)}
            </nav>
          ) : null}
        </header>
      );
    case 'section-heading':
      return (
        <h2
          className="resume-section-heading"
          style={{
            fontSize: `${String(block.style.fontSizePt)}pt`,
            fontWeight: block.style.fontWeight,
          }}
          {...common}
        >
          {block.title}
        </h2>
      );
    case 'entry-heading':
      return (
        <div className="resume-entry-heading" {...common}>
          {block.heading ? <strong>{block.heading}</strong> : null}
          {block.subheading ? <span className="resume-entry-meta">{block.subheading}</span> : null}
          {block.periodLabel ? <time>{block.periodLabel}</time> : null}
        </div>
      );
    case 'paragraph':
      return (
        <p className="resume-paragraph" {...common}>
          {block.text}
        </p>
      );
    case 'bullet':
      return (
        <div className="resume-bullet" {...common}>
          <span aria-hidden="true">{placement?.continuedFromPrevious ? '' : '•'}</span>
          <span>{block.text}</span>
        </div>
      );
    case 'links':
      return (
        <nav aria-label="条目链接" className="resume-entry-links" {...common}>
          {linksView(block.links)}
        </nav>
      );
  }
}

export interface ResumeMeasurementSurfaceProps {
  model: ResumeRenderModel;
  flow: readonly RenderFlowBlock[];
}

export function ResumeMeasurementSurface({
  model,
  flow,
}: ResumeMeasurementSurfaceProps): ReactElement {
  return (
    <div
      aria-hidden="true"
      className="resume-renderer"
      style={createRendererCssVariables(model) as CSSProperties}
    >
      <style>{RESUME_RENDERER_CSS}</style>
      <div className="resume-measurement-surface">
        {flow.map((block) => (
          <BlockView block={block} key={block.key} measurement />
        ))}
      </div>
    </div>
  );
}

export interface ResumePagesProps {
  model: ResumeRenderModel;
  pagination: PaginationResult;
  assetsReady: boolean;
}

export function ResumePages({ model, pagination, assetsReady }: ResumePagesProps): ReactElement {
  const ready = assetsReady && pagination.ready;
  return (
    <div
      className="resume-renderer"
      data-render-ready={ready ? 'true' : 'false'}
      style={createRendererCssVariables(model) as CSSProperties}
    >
      <style>{RESUME_RENDERER_CSS}</style>
      {pagination.issues.length > 0 ? (
        <div className="resume-layout-error" role="alert">
          简历排版未完成：{pagination.issues.map((issue) => issue.code).join('、')}
        </div>
      ) : null}
      {pagination.pages.map((page, pageIndex) => (
        <article
          aria-label={`简历第 ${String(pageIndex + 1)} 页`}
          className="resume-page"
          data-page-index={pageIndex}
          key={pageIndex}
        >
          {page.map((placement) => (
            <BlockView block={placement.block} key={placement.block.key} placement={placement} />
          ))}
          {model.page.showPageNumbers ? (
            <div className="resume-page-number">{pageIndex + 1}</div>
          ) : null}
        </article>
      ))}
    </div>
  );
}
