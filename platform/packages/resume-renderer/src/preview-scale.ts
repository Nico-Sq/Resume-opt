import { A4_HEIGHT_MM, A4_WIDTH_MM, millimetersToCssPixels } from './page-metrics';

export type PreviewScaleMode = 'manual' | 'fit-width' | 'fit-page';

export interface PreviewScaleInput {
  mode: PreviewScaleMode;
  viewportWidthPx: number;
  viewportHeightPx: number;
  manualScale?: number;
  horizontalPaddingPx?: number;
  verticalPaddingPx?: number;
  minScale?: number;
  maxScale?: number;
}

export function computePreviewScale(input: PreviewScaleInput): number {
  const minScale = input.minScale ?? 0.25;
  const maxScale = input.maxScale ?? 2;
  if (
    !Number.isFinite(input.viewportWidthPx) ||
    !Number.isFinite(input.viewportHeightPx) ||
    input.viewportWidthPx <= 0 ||
    input.viewportHeightPx <= 0 ||
    minScale <= 0 ||
    maxScale < minScale
  ) {
    throw new Error('预览缩放参数无效');
  }
  const availableWidth = Math.max(1, input.viewportWidthPx - (input.horizontalPaddingPx ?? 48));
  const availableHeight = Math.max(1, input.viewportHeightPx - (input.verticalPaddingPx ?? 48));
  const widthScale = availableWidth / millimetersToCssPixels(A4_WIDTH_MM);
  const heightScale = availableHeight / millimetersToCssPixels(A4_HEIGHT_MM);
  const requested =
    input.mode === 'manual'
      ? (input.manualScale ?? 1)
      : input.mode === 'fit-width'
        ? widthScale
        : Math.min(widthScale, heightScale);
  return Math.min(maxScale, Math.max(minScale, requested));
}
