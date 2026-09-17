import { GetResumeForEditor } from '@resume/application';
import { parseServerRuntimeConfig } from '@resume/config/server';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

let applicationPool: ReturnType<typeof createPostgresPool> | undefined;

export function getServerRuntimeConfig() {
  return parseServerRuntimeConfig(process.env);
}

export function getApplicationPool() {
  if (!applicationPool) {
    const config = getServerRuntimeConfig();
    applicationPool = createPostgresPool({
      connectionString: config.PG_DEV_URL,
      max: config.DATABASE_POOL_MAX,
      applicationName: 'resume-opt-web',
    });
  }
  return applicationPool;
}

export function getResumeForEditorUseCase() {
  const config = getServerRuntimeConfig();
  if (config.AUTH_MODE !== 'fixed' || !config.DEV_FIXED_USER_ID) {
    throw new Error('V0.1 尚未配置真实认证适配器');
  }
  return new GetResumeForEditor(
    new FixedIdentityProvider({
      appEnvironment: config.APP_ENV,
      userId: config.DEV_FIXED_USER_ID,
    }),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}
