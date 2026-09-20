'use client';

import Link from 'next/link';
import { type ReactNode, type SyntheticEvent, useState } from 'react';

import { postAuth, safeReturnTo } from './auth-request';
import styles from './auth-page.module.css';

export type AuthPageMode =
  'login' | 'register' | 'verify-email' | 'forgot-password' | 'reset-password';

interface AuthPageProps {
  mode: AuthPageMode;
  returnTo?: string | undefined;
  token?: string | undefined;
  verificationStatus?: string | undefined;
  verificationError?: string | undefined;
  navigate?: ((path: string) => void) | undefined;
}

interface ShellProps {
  active?: 'login' | 'register';
  title: string;
  description: string;
  children: ReactNode;
}

function classNames(...names: Array<string | undefined>) {
  return names.filter((name): name is string => Boolean(name)).join(' ');
}

function AuthShell({ active, title, description, children }: ShellProps) {
  const register = active === 'login';
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <span aria-hidden="true" className={styles.brandMark}>
            R
          </span>
          <span>AI 简历平台</span>
        </Link>
        <div>
          <span className={styles.headerPrompt}>{register ? '还没有账号？' : '已有账号？'}</span>
          <Link className={styles.headerAction} href={register ? '/register' : '/login'}>
            {register ? '免费注册' : '登录'}
          </Link>
        </div>
      </header>
      <main className={styles.main}>
        <section className={styles.card} aria-labelledby="auth-title">
          {active ? (
            <nav aria-label="认证方式" className={styles.tabs}>
              <Link
                aria-current={active === 'login' ? 'page' : undefined}
                className={styles.tab}
                href="/login"
              >
                登录
              </Link>
              <Link
                aria-current={active === 'register' ? 'page' : undefined}
                className={styles.tab}
                href="/register"
              >
                注册
              </Link>
            </nav>
          ) : null}
          <h1 className={styles.title} id="auth-title">
            {title}
          </h1>
          <p className={styles.description}>{description}</p>
          {children}
        </section>
      </main>
    </div>
  );
}

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return (
    <p
      className={classNames(styles.notice, error ? styles.error : styles.success)}
      role={error ? 'alert' : 'status'}
    >
      {children}
    </p>
  );
}

function EmailField({
  value,
  onChange,
  autocomplete = 'email',
}: {
  value: string;
  onChange: (value: string) => void;
  autocomplete?: 'email' | 'username';
}) {
  return (
    <label className={styles.field}>
      邮箱
      <input
        autoComplete={autocomplete}
        className={styles.input}
        inputMode="email"
        name="email"
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        placeholder="请输入邮箱"
        required
        type="email"
        value={value}
      />
    </label>
  );
}

function PasswordField({
  label = '密码',
  name,
  value,
  onChange,
  autocomplete,
}: {
  label?: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  autocomplete: 'current-password' | 'new-password';
}) {
  return (
    <label className={styles.field}>
      {label}
      <input
        autoComplete={autocomplete}
        className={styles.input}
        maxLength={128}
        minLength={8}
        name={name}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
        placeholder={`请输入${label}`}
        required
        type="password"
        value={value}
      />
    </label>
  );
}

function LoginPage({
  returnTo,
  navigate,
}: {
  returnTo: string | undefined;
  navigate: ((path: string) => void) | undefined;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [needsVerification, setNeedsVerification] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(undefined);
    setNeedsVerification(false);
    try {
      const response = await postAuth('sign-in/email', { email, password, rememberMe });
      if (response.ok) {
        setPassword('');
        const destination = safeReturnTo(returnTo);
        if (navigate) navigate(destination);
        else window.location.assign(destination);
        return;
      }
      if (response.status === 403) {
        setNeedsVerification(true);
        setMessage('邮箱尚未验证，请先完成验证。');
      } else if (response.status === 400 || response.status === 401) {
        setMessage('邮箱或密码不正确。');
      } else {
        setMessage('暂时无法登录，请稍后重试。');
      }
    } catch {
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setPending(true);
    try {
      const response = await postAuth('send-verification-email', {
        email,
        callbackURL: '/verify-email?status=verified',
      });
      setMessage(
        response.ok ? '如果该邮箱需要验证，验证邮件将发送到该邮箱。' : '暂时无法发送，请稍后重试。',
      );
    } catch {
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell active="login" description="继续编辑和管理你的简历" title="登录你的账号">
      <form
        aria-busy={pending}
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <EmailField autocomplete="username" onChange={setEmail} value={email} />
        <PasswordField
          autocomplete="current-password"
          name="password"
          onChange={setPassword}
          value={password}
        />
        <div className={styles.formRow}>
          <label className={styles.checkboxLabel}>
            <input
              checked={rememberMe}
              className={styles.checkbox}
              name="rememberMe"
              onChange={(event) => {
                setRememberMe(event.currentTarget.checked);
              }}
              type="checkbox"
            />
            记住登录状态
          </label>
          <Link className={styles.link} href="/forgot-password">
            忘记密码
          </Link>
        </div>
        {message ? <Notice error>{message}</Notice> : null}
        {needsVerification ? (
          <button
            className={styles.button}
            disabled={pending}
            onClick={() => {
              void resend();
            }}
            type="button"
          >
            重新发送验证邮件
          </button>
        ) : null}
        <button
          className={classNames(styles.button, styles.primary)}
          disabled={pending}
          type="submit"
        >
          {pending ? '登录中…' : '登录'}
        </button>
      </form>
      <p className={styles.footer}>
        没有账号？{' '}
        <Link className={styles.link} href="/register">
          创建账号
        </Link>
      </p>
    </AuthShell>
  );
}

function RegisterPage() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [success, setSuccess] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(undefined);
    setSuccess(false);
    try {
      const response = await postAuth('sign-up/email', {
        name,
        email,
        password,
        callbackURL: '/verify-email?status=verified',
      });
      if (response.ok) {
        setPassword('');
        setSuccess(true);
        setMessage('请检查邮箱并完成验证，然后返回登录。');
      } else if (response.status === 400 || response.status === 422) {
        setMessage('暂时无法创建账号，请检查填写内容后重试。');
      } else {
        setMessage('认证服务暂时不可用，请稍后重试。');
      }
    } catch {
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    setPending(true);
    try {
      const response = await postAuth('send-verification-email', {
        email,
        callbackURL: '/verify-email?status=verified',
      });
      setSuccess(response.ok);
      setMessage(
        response.ok ? '如果该邮箱需要验证，验证邮件将发送到该邮箱。' : '暂时无法发送，请稍后重试。',
      );
    } catch {
      setSuccess(false);
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell active="register" description="验证邮箱后即可进入你的私人工作区" title="创建账号">
      <form
        aria-busy={pending}
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <label className={styles.field}>
          姓名
          <input
            autoComplete="name"
            className={styles.input}
            maxLength={100}
            name="name"
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
            placeholder="请输入姓名"
            required
            value={name}
          />
        </label>
        <EmailField onChange={setEmail} value={email} />
        <PasswordField
          autocomplete="new-password"
          name="new-password"
          onChange={setPassword}
          value={password}
        />
        {message ? <Notice error={!success}>{message}</Notice> : null}
        {success ? (
          <button
            className={styles.button}
            disabled={pending}
            onClick={() => {
              void resend();
            }}
            type="button"
          >
            重新发送验证邮件
          </button>
        ) : null}
        <button
          className={classNames(styles.button, styles.primary)}
          disabled={pending}
          type="submit"
        >
          {pending ? '创建中…' : '创建账号'}
        </button>
      </form>
    </AuthShell>
  );
}

function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setMessage(undefined);
    try {
      const response = await postAuth('request-password-reset', {
        email,
        redirectTo: '/reset-password',
      });
      setError(!response.ok);
      setMessage(
        response.ok ? '如果该邮箱已注册，重置链接将发送到该邮箱。' : '暂时无法受理，请稍后重试。',
      );
    } catch {
      setError(true);
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell description="我们会发送一次性密码重置链接" title="找回密码">
      <form
        aria-busy={pending}
        className={styles.form}
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <EmailField onChange={setEmail} value={email} />
        {message ? <Notice error={error}>{message}</Notice> : null}
        <button
          className={classNames(styles.button, styles.primary)}
          disabled={pending}
          type="submit"
        >
          {pending ? '提交中…' : '发送重置链接'}
        </button>
      </form>
      <p className={styles.footer}>
        <Link className={styles.link} href="/login">
          返回登录
        </Link>
      </p>
    </AuthShell>
  );
}

function ResetPasswordPage({
  token,
  error,
}: {
  token: string | undefined;
  error: string | undefined;
}) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [success, setSuccess] = useState(false);
  const invalid = Boolean(error) || !token;

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmation) {
      setMessage('两次输入的密码不一致。');
      return;
    }
    setPending(true);
    setMessage(undefined);
    try {
      const response = await postAuth('reset-password', { token, newPassword: password });
      if (response.ok) {
        setPassword('');
        setConfirmation('');
        setSuccess(true);
        setMessage('密码已重置，请使用新密码登录。');
      } else if (response.status === 400) {
        setMessage('重置链接无效或已过期，请重新申请。');
      } else {
        setMessage('暂时无法重置密码，请稍后重试。');
      }
    } catch {
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell description="设置一个新的账号密码" title="重置密码">
      {invalid ? (
        <>
          <Notice error>重置链接无效或已过期，请重新申请。</Notice>
          <p className={styles.footer}>
            <Link className={styles.link} href="/forgot-password">
              重新申请
            </Link>
          </p>
        </>
      ) : (
        <form
          aria-busy={pending}
          className={styles.form}
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <PasswordField
            autocomplete="new-password"
            label="新密码"
            name="new-password"
            onChange={setPassword}
            value={password}
          />
          <PasswordField
            autocomplete="new-password"
            label="确认新密码"
            name="confirm-password"
            onChange={setConfirmation}
            value={confirmation}
          />
          {message ? <Notice error={!success}>{message}</Notice> : null}
          {success ? (
            <Link className={styles.link} href="/login">
              返回登录
            </Link>
          ) : (
            <button
              className={classNames(styles.button, styles.primary)}
              disabled={pending}
              type="submit"
            >
              {pending ? '重置中…' : '重置密码'}
            </button>
          )}
        </form>
      )}
    </AuthShell>
  );
}

function VerifyEmailPage({
  status,
  error,
}: {
  status: string | undefined;
  error: string | undefined;
}) {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const verified = status === 'verified' && !error;

  async function resend(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    try {
      const response = await postAuth('send-verification-email', {
        email,
        callbackURL: '/verify-email?status=verified',
      });
      setMessage(
        response.ok ? '如果该邮箱需要验证，验证邮件将发送到该邮箱。' : '暂时无法发送，请稍后重试。',
      );
    } catch {
      setMessage('网络连接失败，请检查网络后重试。');
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell description="验证邮箱后才能访问私人简历" title="邮箱验证">
      {verified ? (
        <Notice>邮箱验证成功，请返回登录。</Notice>
      ) : (
        <form
          aria-busy={pending}
          className={styles.form}
          onSubmit={(event) => {
            void resend(event);
          }}
        >
          {error ? <Notice error>验证链接无效、已过期或已使用。</Notice> : null}
          <EmailField onChange={setEmail} value={email} />
          {message ? <Notice error={!message.startsWith('如果')}>{message}</Notice> : null}
          <button
            className={classNames(styles.button, styles.primary)}
            disabled={pending}
            type="submit"
          >
            {pending ? '发送中…' : '重新发送验证邮件'}
          </button>
        </form>
      )}
      <p className={styles.footer}>
        <Link className={styles.link} href="/login">
          返回登录
        </Link>
      </p>
    </AuthShell>
  );
}

export function AuthPage(props: AuthPageProps) {
  switch (props.mode) {
    case 'login':
      return <LoginPage navigate={props.navigate} returnTo={props.returnTo} />;
    case 'register':
      return <RegisterPage />;
    case 'forgot-password':
      return <ForgotPasswordPage />;
    case 'reset-password':
      return <ResetPasswordPage error={props.verificationError} token={props.token} />;
    case 'verify-email':
      return <VerifyEmailPage error={props.verificationError} status={props.verificationStatus} />;
  }
}
