import { z } from 'zod';

const PostgreSqlUrlSchema = z
  .url()
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: '必须使用 PostgreSQL URL',
  });

export const ServerRuntimeConfigSchema = z
  .object({
    APP_ENV: z.enum(['local', 'test', 'staging', 'production']).default('local'),
    AUTH_MODE: z.enum(['fixed', 'better-auth']).default('fixed'),
    PG_DEV_URL: PostgreSqlUrlSchema,
    PG_MIGRATION_URL: PostgreSqlUrlSchema,
    PG_TEST_URL: PostgreSqlUrlSchema,
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    DEV_FIXED_USER_ID: z.uuid().optional(),
    DEV_FIXED_RESUME_ID: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    if (value.AUTH_MODE === 'fixed' && !['local', 'test'].includes(value.APP_ENV)) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_MODE'],
        message: '固定身份只允许用于 local/test',
      });
    }

    if (value.AUTH_MODE === 'fixed') {
      for (const key of ['DEV_FIXED_USER_ID', 'DEV_FIXED_RESUME_ID'] as const) {
        if (!value[key]) {
          context.addIssue({ code: 'custom', path: [key], message: '固定身份模式必须配置该值' });
        }
      }
    }

    const devDatabase = new URL(value.PG_DEV_URL).pathname.slice(1);
    const migrationDatabase = new URL(value.PG_MIGRATION_URL).pathname.slice(1);
    const testDatabase = new URL(value.PG_TEST_URL).pathname.slice(1);
    if (devDatabase !== 'resume_opt_dev' || migrationDatabase !== 'resume_opt_dev') {
      context.addIssue({
        code: 'custom',
        path: ['PG_DEV_URL'],
        message: '开发和迁移连接必须指向 resume_opt_dev',
      });
    }
    if (testDatabase !== 'resume_opt_test') {
      context.addIssue({
        code: 'custom',
        path: ['PG_TEST_URL'],
        message: '测试连接必须指向 resume_opt_test',
      });
    }
  });

export type ServerRuntimeConfig = z.infer<typeof ServerRuntimeConfigSchema>;

export function parseServerRuntimeConfig(
  input: Record<string, string | undefined>,
): ServerRuntimeConfig {
  return ServerRuntimeConfigSchema.parse(input);
}
