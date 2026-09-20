import { GetResumeForEditor, SaveResumeDocument } from '@resume/application';
import { parseServerRuntimeConfig } from '@resume/config/server';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import {
  BetterAuthSessionProvider,
  createBetterAuthServer,
  type BetterAuthServer,
} from '@resume/infrastructure/better-auth-server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';

let applicationPool: ReturnType<typeof createPostgresPool> | undefined;
let authPool: ReturnType<typeof createPostgresPool> | undefined;
let authServer: BetterAuthServer | undefined;

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

export function getBetterAuthServer() {
  if (authServer) return authServer;
  const config = getServerRuntimeConfig();
  if (
    config.AUTH_MODE !== 'better-auth' ||
    !config.PG_AUTH_URL ||
    !config.BETTER_AUTH_URL ||
    !config.BETTER_AUTH_SECRET
  ) {
    throw new Error('真实身份服务未配置');
  }
  if (!['local', 'test'].includes(config.APP_ENV)) {
    throw new Error('公开环境邮件发送器尚未配置');
  }

  authPool = createPostgresPool({
    connectionString: config.PG_AUTH_URL,
    max: config.DATABASE_POOL_MAX,
    applicationName: 'resume-opt-auth',
  });
  authServer = createBetterAuthServer({
    authPool,
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    sendVerificationEmail: () => Promise.resolve(),
  });
  return authServer;
}

export function getRequestSessionProvider(requestHeaders: Headers) {
  return new BetterAuthSessionProvider(getBetterAuthServer(), getApplicationPool(), requestHeaders);
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

export function getSaveResumeDocumentUseCase() {
  const config = getServerRuntimeConfig();
  if (config.AUTH_MODE !== 'fixed' || !config.DEV_FIXED_USER_ID) {
    throw new Error('V0.1 尚未配置真实认证适配器');
  }
  return new SaveResumeDocument(
    new FixedIdentityProvider({
      appEnvironment: config.APP_ENV,
      userId: config.DEV_FIXED_USER_ID,
    }),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}
