import { AuthPage } from '@/client/auth/auth-page';
import { firstQueryValue } from '@/client/auth/auth-request';

export default async function ResetPasswordPage({ searchParams }: PageProps<'/reset-password'>) {
  const query = await searchParams;
  return (
    <AuthPage
      mode="reset-password"
      token={firstQueryValue(query.token)}
      verificationError={firstQueryValue(query.error)}
    />
  );
}
