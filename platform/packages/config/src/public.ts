import { z } from 'zod';

export const PublicRuntimeConfigSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('AI 简历平台'),
});

export type PublicRuntimeConfig = z.infer<typeof PublicRuntimeConfigSchema>;

export function parsePublicRuntimeConfig(
  input: Record<string, string | undefined>,
): PublicRuntimeConfig {
  return PublicRuntimeConfigSchema.parse(input);
}
