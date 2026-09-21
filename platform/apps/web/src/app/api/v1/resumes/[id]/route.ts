import { respondWithResume } from '@/server/http/resume-response';
import { respondToRenameResume } from '@/server/http/rename-resume-response';

export const runtime = 'nodejs';

export async function GET(request: Request, context: RouteContext<'/api/v1/resumes/[id]'>) {
  const { id } = await context.params;
  return respondWithResume(request, id);
}

export async function PATCH(request: Request, context: RouteContext<'/api/v1/resumes/[id]'>) {
  const { id } = await context.params;
  return respondToRenameResume(request, id);
}
