import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { AccountPage } from '@/client/account/account-page';
import { getPrivatePageIdentity } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default async function AccountRoute() {
  const identity = await getPrivatePageIdentity(await headers());
  if (!identity) redirect('/login?returnTo=/account');
  return <AccountPage {...identity} />;
}
