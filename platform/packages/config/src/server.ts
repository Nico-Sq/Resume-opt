import { z } from 'zod';

const AppEnvironmentSchema = z.enum(['local', 'test', 'staging', 'production']);
const PostgreSqlUrlSchema = z
  .url()
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: '必须使用 PostgreSQL URL',
  });

export const ServerRuntimeConfigSchema = z
  .object({
    APP_ENV: AppEnvironmentSchema.default('local'),
    AUTH_MODE: z.enum(['fixed', 'better-auth']).default('fixed'),
    PG_DEV_URL: PostgreSqlUrlSchema,
    PG_AUTH_URL: PostgreSqlUrlSchema.optional(),
    BETTER_AUTH_URL: z.url().optional(),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),
    DEV_FIXED_USER_ID: z.uuid().optional(),
    DEV_FIXED_RESUME_ID: z.uuid().optional(),
    DEV_FIXED_VERSION_ID: z.uuid().optional(),
  })
  .superRefine((value, context) => {
    const appDatabase = new URL(value.PG_DEV_URL).pathname.slice(1);
    if (['local', 'test'].includes(value.APP_ENV) && appDatabase !== 'resume_opt_dev') {
      context.addIssue({
        code: 'custom',
        path: ['PG_DEV_URL'],
        message: '本地和测试业务连接必须指向 resume_opt_dev',
      });
    }
    if (
      ['staging', 'production'].includes(value.APP_ENV) &&
      ['postgres', 'resume_opt_dev', 'resume_opt_test'].includes(appDatabase)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PG_DEV_URL'],
        message: '公开环境业务连接不得指向管理库、开发库或测试库',
      });
    }

    if (value.AUTH_MODE === 'fixed') {
      if (!['local', 'test'].includes(value.APP_ENV)) {
        context.addIssue({
          code: 'custom',
          path: ['AUTH_MODE'],
          message: '固定身份只允许用于 local/test',
        });
      }
      for (const key of [
        'DEV_FIXED_USER_ID',
        'DEV_FIXED_RESUME_ID',
        'DEV_FIXED_VERSION_ID',
      ] as const) {
        if (!value[key]) {
          context.addIssue({ code: 'custom', path: [key], message: '固定身份模式必须配置该值' });
        }
      }
      return;
    }

    for (const key of ['PG_AUTH_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET'] as const) {
      if (!value[key]) {
        context.addIssue({ code: 'custom', path: [key], message: '真实身份模式必须配置该值' });
      }
    }
    if (value.BETTER_AUTH_URL) {
      const authBaseUrl = new URL(value.BETTER_AUTH_URL);
      if (
        authBaseUrl.username ||
        authBaseUrl.password ||
        authBaseUrl.pathname !== '/' ||
        authBaseUrl.search ||
        authBaseUrl.hash
      ) {
        context.addIssue({
          code: 'custom',
          path: ['BETTER_AUTH_URL'],
          message: '认证地址必须是无凭据、无路径的站点 Origin',
        });
      }
      if (['staging', 'production'].includes(value.APP_ENV) && authBaseUrl.protocol !== 'https:') {
        context.addIssue({
          code: 'custom',
          path: ['BETTER_AUTH_URL'],
          message: 'staging/production 的认证地址必须使用 HTTPS',
        });
      }
    }
    if (value.PG_AUTH_URL) {
      const appUrl = new URL(value.PG_DEV_URL);
      const authUrl = new URL(value.PG_AUTH_URL);
      const sameDatabase =
        appUrl.hostname === authUrl.hostname &&
        (appUrl.port || '5432') === (authUrl.port || '5432') &&
        appUrl.pathname === authUrl.pathname;
      if (!sameDatabase) {
        context.addIssue({
          code: 'custom',
          path: ['PG_AUTH_URL'],
          message: '业务与认证角色必须连接同一 PostgreSQL 数据库',
        });
      }
      if (appUrl.username === authUrl.username) {
        context.addIssue({
          code: 'custom',
          path: ['PG_AUTH_URL'],
          message: '业务与认证必须使用不同数据库角色',
        });
      }
    }
  });

export type ServerRuntimeConfig = z.infer<typeof ServerRuntimeConfigSchema>;
export type DatabaseToolTarget = 'migration' | 'test';

export interface DatabaseToolConfig {
  appEnvironment: z.infer<typeof AppEnvironmentSchema>;
  connectionString: string;
}

const DatabaseToolEnvironmentSchema = z.object({
  APP_ENV: AppEnvironmentSchema.default('local'),
  PG_MIGRATION_URL: PostgreSqlUrlSchema.optional(),
  PG_TEST_URL: PostgreSqlUrlSchema.optional(),
});

export function parseServerRuntimeConfig(
  input: Record<string, string | undefined>,
): ServerRuntimeConfig {
  return ServerRuntimeConfigSchema.parse(input);
}

export function parseDatabaseToolConfig(
  input: Record<string, string | undefined>,
  target: DatabaseToolTarget,
): DatabaseToolConfig {
  const environment = DatabaseToolEnvironmentSchema.parse(input);
  const key = target === 'migration' ? 'PG_MIGRATION_URL' : 'PG_TEST_URL';
  const connectionString = environment[key];
  if (!connectionString) throw new Error(`缺少 ${key}`);

  const database = new URL(connectionString).pathname.slice(1);
  if (target === 'test' && database !== 'resume_opt_test') {
    throw new Error('测试连接必须指向 resume_opt_test');
  }
  if (
    target === 'migration' &&
    ['local', 'test'].includes(environment.APP_ENV) &&
    database !== 'resume_opt_dev'
  ) {
    throw new Error('本地和测试迁移连接必须指向 resume_opt_dev');
  }
  if (
    target === 'migration' &&
    ['staging', 'production'].includes(environment.APP_ENV) &&
    ['postgres', 'resume_opt_dev', 'resume_opt_test'].includes(database)
  ) {
    throw new Error('公开环境迁移连接不得指向管理库、开发库或测试库');
  }

  return { appEnvironment: environment.APP_ENV, connectionString };
}
