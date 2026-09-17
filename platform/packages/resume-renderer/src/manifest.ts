export interface TemplateManifest {
  id: string;
  version: string;
  rendererVersion: string;
  pageFormat: 'A4';
  allowedFontFamilyIds: readonly string[];
}

export interface FontManifest {
  families: ReadonlyArray<{
    familyId: string;
    cssFamily: string;
    weights: readonly number[];
  }>;
}

export interface RenderPolicy {
  version: string;
  allowedLinkProtocols: readonly ['http:', 'https:', 'mailto:'];
  allowAvatar: boolean;
}

export const ATS_BASIC_TEMPLATE_MANIFEST: TemplateManifest = {
  id: 'ats-basic',
  version: '1.0.0',
  rendererVersion: '1.0.0',
  pageFormat: 'A4',
  allowedFontFamilyIds: ['noto-sans-sc'],
};

export const DEFAULT_FONT_MANIFEST: FontManifest = {
  families: [
    { familyId: 'noto-sans-sc', cssFamily: '"Noto Sans SC", sans-serif', weights: [400, 600, 700] },
  ],
};

export const RENDER_POLICY_V1: RenderPolicy = {
  version: '1',
  allowedLinkProtocols: ['http:', 'https:', 'mailto:'],
  allowAvatar: false,
};
