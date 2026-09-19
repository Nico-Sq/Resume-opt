import type { ResumeRenderModel } from './projector';

export const RESUME_RENDERER_CSS = `
@page { size: A4; margin: 0; }
.resume-renderer { color: #171717; font-family: var(--resume-font-family); }
.resume-renderer .resume-measurement-surface { position: absolute; left: -100000px; top: 0; width: var(--resume-content-width); visibility: hidden; }
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
  display: flex;
  flex-direction: column;
}
.resume-renderer .resume-header { margin-block-end: calc(var(--resume-section-gap) * .24); }
.resume-renderer .resume-name { margin: 0; color: var(--resume-heading-color); font-size: 32pt; font-weight: 750; line-height: 1.08; letter-spacing: .02em; }
.resume-renderer .resume-headline { margin: 1.8mm 0 0; color: #454545; font-size: 14pt; line-height: 1.4; }
.resume-renderer .resume-contact-list, .resume-renderer .resume-link-list { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 1mm 5mm; margin-block-start: 3.2mm; color: #4a4a4a; vertical-align: middle; }
.resume-renderer .resume-link-list { margin-left: 5mm; }
.resume-renderer .resume-header .resume-link-list a { color: #4a4a4a; text-decoration: none; }
.resume-renderer .resume-contact-list > span { display: inline-flex; align-items: center; gap: 1.5mm; }
.resume-renderer .resume-contact-icon { flex: 0 0 auto; color: #555; }
.resume-renderer .resume-section-heading { margin: var(--resume-section-gap) 0 var(--resume-paragraph-gap); border-bottom: .35mm solid #b8c0c7; color: var(--resume-heading-color); font-weight: 700; line-height: 1.55; }
.resume-renderer .resume-entry-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0; margin-block-end: var(--resume-paragraph-gap); }
.resume-renderer .resume-entry-heading > :not(:first-child)::before { content: "|"; margin: 0 2.5mm; color: #9a9a9a; font-weight: 400; }
.resume-renderer .resume-entry-meta { color: #595959; }
.resume-renderer .resume-paragraph, .resume-renderer .resume-bullet, .resume-renderer .resume-entry-links { margin: 0 0 var(--resume-paragraph-gap); overflow-wrap: anywhere; }
.resume-renderer .resume-paragraph[data-continues-on-next='true'], .resume-renderer .resume-bullet[data-continues-on-next='true'] { margin-block-end: 0; }
.resume-renderer .resume-bullet { display: grid; grid-template-columns: 3mm minmax(0, 1fr); }
.resume-renderer a { color: var(--resume-accent-color); text-decoration: underline; text-underline-offset: 0.15em; }
.resume-renderer .resume-page-number { margin-block-start: auto; text-align: center; color: #737373; font-size: 8pt; }
.resume-renderer .resume-layout-error { padding: 12px; border: 1px solid #b42318; color: #b42318; background: #fff; }
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
    '--resume-content-width': `${String(210 - model.page.marginMm.left - model.page.marginMm.right)}mm`,
    '--resume-accent-color': model.design.accentColor,
    '--resume-heading-color': model.design.headingColor,
  };
}
