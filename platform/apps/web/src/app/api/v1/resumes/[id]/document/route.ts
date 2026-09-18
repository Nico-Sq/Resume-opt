import { respondToSaveResume } from '@/server/http/save-resume-response';

export const runtime = 'nodejs';

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  return respondToSaveResume(request, id);
}
