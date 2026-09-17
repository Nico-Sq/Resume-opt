import type { ResumeRenderModel } from './projector';

export const A4_WIDTH_MM = 210;
export const A4_HEIGHT_MM = 297;
export const CSS_PIXELS_PER_INCH = 96;
export const MILLIMETERS_PER_INCH = 25.4;

export function millimetersToCssPixels(value: number): number {
  return (value * CSS_PIXELS_PER_INCH) / MILLIMETERS_PER_INCH;
}

export interface A4PageMetrics {
  widthMm: number;
  heightMm: number;
  contentWidthMm: number;
  contentHeightMm: number;
  widthPx: number;
  heightPx: number;
  contentWidthPx: number;
  contentHeightPx: number;
}

export function getA4PageMetrics(page: ResumeRenderModel['page']): A4PageMetrics {
  const { top, right, bottom, left } = page.marginMm;
  const contentWidthMm = A4_WIDTH_MM - left - right;
  const contentHeightMm = A4_HEIGHT_MM - top - bottom;
  return {
    widthMm: A4_WIDTH_MM,
    heightMm: A4_HEIGHT_MM,
    contentWidthMm,
    contentHeightMm,
    widthPx: millimetersToCssPixels(A4_WIDTH_MM),
    heightPx: millimetersToCssPixels(A4_HEIGHT_MM),
    contentWidthPx: millimetersToCssPixels(contentWidthMm),
    contentHeightPx: millimetersToCssPixels(contentHeightMm),
  };
}
