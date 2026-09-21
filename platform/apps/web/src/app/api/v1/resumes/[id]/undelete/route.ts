import { respondToUndeleteResume } from '@/server/http/resume-lifecycle-response';

export const runtime = 'nodejs';

export async function POST(
  request: Request,
  context: RouteContext<'/api/v1/resumes/[id]/undelete'>,
) {
  const { id } = await context.params;
  return respondToUndeleteResume(request, id);
}
