import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { CreateResumePage } from '@/client/dashboard/dashboard';
import { getPrivatePageIdentity } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function NewResumePage() {
  const identity = await getPrivatePageIdentity(await headers());
  if (!identity) redirect('/login?returnTo=/resumes/new');
  return <CreateResumePage {...identity} />;
}
