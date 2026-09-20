import { respondWithSession } from '@/server/http/session-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return respondWithSession(request);
}
