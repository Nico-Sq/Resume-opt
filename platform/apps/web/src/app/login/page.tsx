import { AuthPage } from '@/client/auth/auth-page';
import { firstQueryValue } from '@/client/auth/auth-request';

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const query = await searchParams;
  return <AuthPage mode="login" returnTo={firstQueryValue(query.returnTo)} />;
}
