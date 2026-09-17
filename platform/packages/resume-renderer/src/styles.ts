import type { ResumeRenderModel } from './projector';

export const RESUME_RENDERER_CSS = `
@page { size: A4; margin: 0; }
.resume-renderer { color: #171717; font-family: var(--resume-font-family); }
.resume-renderer .resume-page {
  box-sizing: border-box;
  width: 210mm;
  height: 297mm;
  padding: var(--resume-margin-top) var(--resume-margin-right) var(--resume-margin-bottom) var(--resume-margin-left);
  background: #fff;
  color: #171717;
  border-radius: 2px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 10%);
  font-size: var(--resume-body-size);
  line-height: var(--resume-line-height);
  print-color-adjust: exact;
  -webkit-print-color-adjust: exact;
}
@media print {
  .resume-renderer .resume-page { break-after: page; border-radius: 0; box-shadow: none; }
  .resume-renderer .resume-page:last-child { break-after: auto; }
  .editor-chrome, .selection-decoration { display: none !important; }
}
`;

export function createRendererCssVariables(model: ResumeRenderModel): Record<string, string> {
  return {
    '--resume-font-family': model.fontCssFamily,
    '--resume-body-size': `${String(model.typography.bodyFontSizePt)}pt`,
    '--resume-line-height': String(model.typography.lineHeight),
    '--resume-section-gap': `${String(model.typography.sectionGapMm)}mm`,
    '--resume-paragraph-gap': `${String(model.typography.paragraphGapMm)}mm`,
    '--resume-margin-top': `${String(model.page.marginMm.top)}mm`,
    '--resume-margin-right': `${String(model.page.marginMm.right)}mm`,
    '--resume-margin-bottom': `${String(model.page.marginMm.bottom)}mm`,
    '--resume-margin-left': `${String(model.page.marginMm.left)}mm`,
    '--resume-accent-color': model.design.accentColor,
    '--resume-heading-color': model.design.headingColor,
  };
}
