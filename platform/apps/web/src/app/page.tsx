import { redirect } from 'next/navigation';

import { getServerRuntimeConfig } from '@/server/runtime';

export const dynamic = 'force-dynamic';

export default function HomePage() {
  const config = getServerRuntimeConfig();
  if (config.AUTH_MODE === 'fixed' && config.DEV_FIXED_RESUME_ID) {
    redirect(`/resumes/${config.DEV_FIXED_RESUME_ID}/edit`);
  }
  redirect('/login');
}
