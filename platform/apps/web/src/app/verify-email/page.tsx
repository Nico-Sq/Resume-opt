import { AuthPage } from '@/client/auth/auth-page';
import { firstQueryValue } from '@/client/auth/auth-request';

export default async function VerifyEmailPage({ searchParams }: PageProps<'/verify-email'>) {
  const query = await searchParams;
  return (
    <AuthPage
      mode="verify-email"
      verificationError={firstQueryValue(query.error)}
      verificationStatus={firstQueryValue(query.status)}
    />
  );
}
