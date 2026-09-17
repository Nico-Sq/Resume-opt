import { parseServerRuntimeConfig } from '@resume/config/server';
import { createPostgresPool } from '@resume/infrastructure/postgres';

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
