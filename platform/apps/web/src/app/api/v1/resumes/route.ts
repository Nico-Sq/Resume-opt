import { respondToCreateResume } from '@/server/http/create-resume-response';
import { respondToListResumes } from '@/server/http/list-resumes-response';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  return respondToListResumes(request);
}

export async function POST(request: Request) {
  return respondToCreateResume(request);
}
