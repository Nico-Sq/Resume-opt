import { respondToCreateResume } from '@/server/http/create-resume-response';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  return respondToCreateResume(request);
}
