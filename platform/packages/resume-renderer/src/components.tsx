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
          {block.contacts.length > 0 ? (
            <div className="resume-contact-list">
              {block.contacts.map((contact, index) => (
                <span key={`${contact.label}-${String(index)}`}>
                  {contact.label}：{contact.value}
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
          <div>
            {block.heading ? <strong>{block.heading}</strong> : null}
            {block.subheading ? <div className="resume-entry-meta">{block.subheading}</div> : null}
          </div>
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
