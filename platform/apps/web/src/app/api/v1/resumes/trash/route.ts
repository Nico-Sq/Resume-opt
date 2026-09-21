import { respondToListDeletedResumes } from '@/server/http/resume-lifecycle-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return respondToListDeletedResumes(request);
}
