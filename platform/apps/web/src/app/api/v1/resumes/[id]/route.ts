import { respondWithResume } from '@/server/http/resume-response';

export async function GET(request: Request, context: RouteContext<'/api/v1/resumes/[id]'>) {
  const { id } = await context.params;
  return respondWithResume(request, id);
}
