import type { RenderFlowBlock } from './flow';

export interface LineMeasurement {
  text: string;
  heightPx: number;
}

export interface RenderBlockMeasurement {
  heightPx: number;
  lineFragments?: readonly LineMeasurement[];
}

export interface PagePlacement {
  block: RenderFlowBlock;
  heightPx: number;
  continuedFromPrevious: boolean;
  continuesOnNext: boolean;
}

export interface PaginationIssue {
  code: 'MEASUREMENT_MISSING' | 'LAYOUT_OVERFLOW' | 'INVALID_MEASUREMENT';
  blockKey: string;
  message: string;
}

export interface PaginationResult {
  ready: boolean;
  pages: PagePlacement[][];
  issues: PaginationIssue[];
}

const epsilon = 0.01;

function textBlockWithFragment(block: RenderFlowBlock, text: string): RenderFlowBlock {
  if (block.kind === 'paragraph' || block.kind === 'bullet') return { ...block, text };
  return block;
}

function validHeight(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

export function paginateRenderFlow(
  flow: readonly RenderFlowBlock[],
  measurements: Readonly<Record<string, RenderBlockMeasurement>>,
  contentHeightPx: number,
): PaginationResult {
  if (!Number.isFinite(contentHeightPx) || contentHeightPx <= 0) {
    throw new Error('分页内容高度必须是正有限数');
  }

  const issues: PaginationIssue[] = [];
  for (const block of flow) {
    const measurement = measurements[block.key];
    if (!measurement) {
      issues.push({
        code: 'MEASUREMENT_MISSING',
        blockKey: block.key,
        message: '布局块缺少测量结果',
      });
    } else if (
      !validHeight(measurement.heightPx) ||
      measurement.lineFragments?.some((line) => !validHeight(line.heightPx))
    ) {
      issues.push({
        code: 'INVALID_MEASUREMENT',
        blockKey: block.key,
        message: '布局块包含非法高度',
      });
    }
  }
  if (issues.length > 0) return { ready: false, pages: [], issues };

  const pages: PagePlacement[][] = [[]];
  let usedHeight = 0;
  const currentPage = () => pages.at(-1) ?? [];
  const newPage = () => {
    if (currentPage().length === 0) return;
    pages.push([]);
    usedHeight = 0;
  };
  const place = (placement: PagePlacement) => {
    currentPage().push(placement);
    usedHeight += placement.heightPx;
  };

  const keepChainHeight = (startIndex: number): number => {
    let height = 0;
    for (let index = startIndex; index < flow.length; index += 1) {
      const candidate = flow[index];
      if (!candidate) break;
      height += measurements[candidate.key]?.heightPx ?? 0;
      if (!candidate.keepWithNext) break;
    }
    return height;
  };

  flow.forEach((block, index) => {
    const measurement = measurements[block.key];
    if (!measurement) return;
    const requiredWithNext = block.keepWithNext ? keepChainHeight(index) : measurement.heightPx;
    if (
      currentPage().length > 0 &&
      requiredWithNext <= contentHeightPx + epsilon &&
      usedHeight + requiredWithNext > contentHeightPx + epsilon
    ) {
      newPage();
    }

    if (measurement.heightPx <= contentHeightPx + epsilon) {
      if (
        currentPage().length > 0 &&
        usedHeight + measurement.heightPx > contentHeightPx + epsilon
      ) {
        newPage();
      }
      place({
        block,
        heightPx: measurement.heightPx,
        continuedFromPrevious: false,
        continuesOnNext: false,
      });
      return;
    }

    const lines = measurement.lineFragments;
    if (!lines || lines.length === 0 || (block.kind !== 'paragraph' && block.kind !== 'bullet')) {
      issues.push({
        code: 'LAYOUT_OVERFLOW',
        blockKey: block.key,
        message: '布局块超过整页且没有可用的行级拆分结果',
      });
      return;
    }

    if (lines.some((line) => line.heightPx > contentHeightPx + epsilon)) {
      issues.push({
        code: 'LAYOUT_OVERFLOW',
        blockKey: block.key,
        message: '单行内容高度超过整页可用区域',
      });
      return;
    }

    let lineIndex = 0;
    let fragmentIndex = 0;
    while (lineIndex < lines.length) {
      if (currentPage().length > 0 && usedHeight >= contentHeightPx - epsilon) newPage();
      const available = contentHeightPx - usedHeight;
      let fragmentHeight = 0;
      const fragmentLines: LineMeasurement[] = [];
      while (lineIndex < lines.length) {
        const line = lines[lineIndex];
        if (!line) break;
        if (fragmentLines.length > 0 && fragmentHeight + line.heightPx > available + epsilon) break;
        if (fragmentLines.length === 0 && line.heightPx > available + epsilon) {
          newPage();
          break;
        }
        fragmentLines.push(line);
        fragmentHeight += line.heightPx;
        lineIndex += 1;
      }
      if (fragmentLines.length === 0) continue;
      place({
        block: textBlockWithFragment(
          { ...block, key: `${block.key}-fragment-${String(fragmentIndex)}` },
          fragmentLines.map((line) => line.text).join(''),
        ),
        heightPx: fragmentHeight,
        continuedFromPrevious: fragmentIndex > 0,
        continuesOnNext: lineIndex < lines.length,
      });
      fragmentIndex += 1;
      if (lineIndex < lines.length) newPage();
    }
  });

  return { ready: issues.length === 0, pages, issues };
}
