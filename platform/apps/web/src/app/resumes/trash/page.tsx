import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { TrashPage } from '@/client/dashboard/trash-page';
import { getPrivatePageIdentity } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function ResumeTrashPage() {
  const identity = await getPrivatePageIdentity(await headers());
  if (!identity) redirect('/login?returnTo=/resumes/trash');
  return <TrashPage {...identity} />;
}
