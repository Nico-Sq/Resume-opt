import {
  CopyResume,
  CreateResume,
  DeleteResume,
  GetResumeForEditor,
  ListDeletedResumes,
  ListResumes,
  RenameResume,
  SaveResumeDocument,
  UndeleteResume,
} from '@resume/application';
import { parseServerRuntimeConfig } from '@resume/config/server';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';
import {
  BetterAuthSessionProvider,
  createBetterAuthServer,
  InMemoryAuthMailbox,
  type BetterAuthServer,
} from '@resume/infrastructure/better-auth-server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { PostgresUserTransactionManager } from '@resume/infrastructure/resume-transactions';
import type { IdentityProvider } from '@resume/application';

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
  const authMailbox = new InMemoryAuthMailbox();
  authServer = createBetterAuthServer({
    authPool,
    baseURL: config.BETTER_AUTH_URL,
    secret: config.BETTER_AUTH_SECRET,
    sendVerificationEmail: authMailbox.sendVerificationEmail,
    sendResetPassword: authMailbox.sendResetPassword,
  });
  return authServer;
}

export function getRequestSessionProvider(requestHeaders: Headers) {
  const config = getServerRuntimeConfig();
  return new BetterAuthSessionProvider(
    getBetterAuthServer(),
    getApplicationPool(),
    requestHeaders,
    'public',
    config.BETTER_AUTH_SECRET,
  );
}

function getRequestIdentityProvider(requestHeaders: Headers): IdentityProvider {
  const config = getServerRuntimeConfig();
  if (config.AUTH_MODE === 'better-auth') return getRequestSessionProvider(requestHeaders);
  if (!config.DEV_FIXED_USER_ID) {
    throw new Error('固定身份未配置');
  }
  return new FixedIdentityProvider({
    appEnvironment: config.APP_ENV,
    userId: config.DEV_FIXED_USER_ID,
  });
}

export function getResumeForEditorUseCase(requestHeaders: Headers) {
  return new GetResumeForEditor(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getSaveResumeDocumentUseCase(requestHeaders: Headers) {
  return new SaveResumeDocument(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getCreateResumeUseCase(requestHeaders: Headers) {
  return new CreateResume(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getCopyResumeUseCase(requestHeaders: Headers) {
  return new CopyResume(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getListResumesUseCase(requestHeaders: Headers) {
  return new ListResumes(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getRenameResumeUseCase(requestHeaders: Headers) {
  return new RenameResume(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getDeleteResumeUseCase(requestHeaders: Headers) {
  return new DeleteResume(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getUndeleteResumeUseCase(requestHeaders: Headers) {
  return new UndeleteResume(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}

export function getListDeletedResumesUseCase(requestHeaders: Headers) {
  return new ListDeletedResumes(
    getRequestIdentityProvider(requestHeaders),
    new PostgresUserTransactionManager(getApplicationPool()),
  );
}
