import type { RenderEntry, ResumeRenderModel } from './projector';

export type RenderFlowBlock =
  | {
      key: string;
      kind: 'header';
      keepWithNext: boolean;
      name: string;
      avatarUrl: string | null;
      contacts: ResumeRenderModel['contacts'];
      links: ResumeRenderModel['links'];
    }
  | {
      key: string;
      kind: 'section-heading';
      keepWithNext: true;
      title: string;
      style: { fontSizePt: number; fontWeight: number };
    }
  | {
      key: string;
      kind: 'entry-heading';
      keepWithNext: boolean;
      heading: string;
      subheading: string;
      periodLabel: string;
    }
  | { key: string; kind: 'paragraph'; keepWithNext: false; text: string }
  | { key: string; kind: 'bullet'; keepWithNext: false; text: string }
  | { key: string; kind: 'links'; keepWithNext: false; links: RenderEntry['links'] };

function hasHeader(model: ResumeRenderModel): boolean {
  return (
    model.name.trim().length > 0 ||
    model.avatarUrl !== null ||
    model.contacts.length > 0 ||
    model.links.length > 0
  );
}

export function createRenderFlow(model: ResumeRenderModel): RenderFlowBlock[] {
  const blocks: RenderFlowBlock[] = [];
  if (hasHeader(model)) {
    blocks.push({
      key: 'header',
      kind: 'header',
      keepWithNext: model.sections.length > 0,
      name: model.name,
      avatarUrl: model.avatarUrl,
      contacts: model.contacts,
      links: model.links,
    });
  }

  model.sections.forEach((sectionValue, sectionIndex) => {
    blocks.push({
      key: `section-${String(sectionIndex)}-heading`,
      kind: 'section-heading',
      keepWithNext: true,
      title: sectionValue.title,
      style: sectionValue.style,
    });
    sectionValue.entries.forEach((entry, entryIndex) => {
      const prefix = `section-${String(sectionIndex)}-entry-${String(entryIndex)}`;
      const hasEntryHeading =
        entry.heading.trim().length > 0 ||
        entry.subheading.trim().length > 0 ||
        entry.periodLabel.trim().length > 0;
      const followingContentCount =
        entry.paragraphs.length + entry.bullets.length + (entry.links.length > 0 ? 1 : 0);
      if (hasEntryHeading) {
        blocks.push({
          key: `${prefix}-heading`,
          kind: 'entry-heading',
          keepWithNext: followingContentCount > 0,
          heading: entry.heading,
          subheading: entry.subheading,
          periodLabel: entry.periodLabel,
        });
      }
      entry.paragraphs.forEach((text, paragraphIndex) => {
        blocks.push({
          key: `${prefix}-paragraph-${String(paragraphIndex)}`,
          kind: 'paragraph',
          keepWithNext: false,
          text,
        });
      });
      entry.bullets.forEach((text, bulletIndex) => {
        blocks.push({
          key: `${prefix}-bullet-${String(bulletIndex)}`,
          kind: 'bullet',
          keepWithNext: false,
          text,
        });
      });
      if (entry.links.length > 0) {
        blocks.push({
          key: `${prefix}-links`,
          kind: 'links',
          keepWithNext: false,
          links: entry.links,
        });
      }
    });
  });
  return blocks;
}
