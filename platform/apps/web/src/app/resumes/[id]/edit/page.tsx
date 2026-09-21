import { EditorEntry } from '@/client/editor/editor-entry';
import { getServerRuntimeConfig } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function ResumeEditPage({ params }: PageProps<'/resumes/[id]/edit'>) {
  const { id } = await params;
  const config = getServerRuntimeConfig();
  return (
    <EditorEntry
      csrfRequired={config.AUTH_MODE === 'better-auth'}
      fixedUserId={config.AUTH_MODE === 'fixed' ? config.DEV_FIXED_USER_ID : undefined}
      key={id}
      resumeId={id}
    />
  );
}
