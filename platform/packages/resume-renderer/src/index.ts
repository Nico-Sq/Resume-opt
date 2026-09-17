export {
  ATS_BASIC_TEMPLATE_MANIFEST,
  DEFAULT_FONT_MANIFEST,
  RENDER_POLICY_V1,
  type FontManifest,
  type RenderPolicy,
  type TemplateManifest,
} from './manifest';
export {
  createResumeRenderModel,
  RendererConfigurationError,
  type RenderContact,
  type RenderEntry,
  type RendererInput,
  type RenderLink,
  type RenderSection,
  type RenderTypography,
  type ResumeRenderModel,
} from './projector';
export { createRenderFlow, type RenderFlowBlock } from './flow';
export {
  A4_HEIGHT_MM,
  A4_WIDTH_MM,
  CSS_PIXELS_PER_INCH,
  MILLIMETERS_PER_INCH,
  getA4PageMetrics,
  millimetersToCssPixels,
  type A4PageMetrics,
} from './page-metrics';
export {
  paginateRenderFlow,
  type LineMeasurement,
  type PagePlacement,
  type PaginationIssue,
  type PaginationResult,
  type RenderBlockMeasurement,
} from './pagination';
export {
  computePreviewScale,
  type PreviewScaleInput,
  type PreviewScaleMode,
} from './preview-scale';
export { createRendererCssVariables, RESUME_RENDERER_CSS } from './styles';
