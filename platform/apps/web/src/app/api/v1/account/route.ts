import { respondToDeleteAccount } from '@/server/http/account-deletion-response';
import {
  getAccountDeletionRequests,
  getRequestSessionProvider,
  getServerRuntimeConfig,
} from '@/server/runtime';

export async function DELETE(request: Request) {
  const config = getServerRuntimeConfig();
  if (config.AUTH_MODE !== 'better-auth' || !config.BETTER_AUTH_URL) {
    return Response.json({ code: 'ACCOUNT_DELETION_UNAVAILABLE' }, { status: 404 });
  }
  return respondToDeleteAccount(
    request,
    getRequestSessionProvider(request.headers),
    getAccountDeletionRequests(),
    config.BETTER_AUTH_URL,
  );
}
