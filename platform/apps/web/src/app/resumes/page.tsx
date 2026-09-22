import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { ResumeDashboard } from '@/client/dashboard/dashboard';
import { getPrivatePageIdentity } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function ResumesPage() {
  const identity = await getPrivatePageIdentity(await headers());
  if (!identity) redirect('/login?returnTo=/resumes');
  return <ResumeDashboard {...identity} />;
}
