import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { getPrivatePageIdentity } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const identity = await getPrivatePageIdentity(await headers());
  redirect(identity ? '/resumes' : '/login');
}
