import { respondToCopyResume } from '@/server/http/copy-resume-response';

export const runtime = 'nodejs';

export async function POST(request: Request, context: RouteContext<'/api/v1/resumes/[id]/copies'>) {
  const { id } = await context.params;
  return respondToCopyResume(request, id);
}
