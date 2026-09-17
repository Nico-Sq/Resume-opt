import type { CurrentIdentity, IdentityProvider } from '@resume/application';

export interface FixedIdentityOptions {
  appEnvironment: 'local' | 'test' | 'staging' | 'production';
  userId: string;
}

export class FixedIdentityProvider implements IdentityProvider {
  readonly #identity: CurrentIdentity;

  constructor(options: FixedIdentityOptions) {
    if (!['local', 'test'].includes(options.appEnvironment)) {
      throw new Error('固定测试身份只能用于 local/test');
    }
    this.#identity = { userId: options.userId };
  }

  requireIdentity(): Promise<CurrentIdentity> {
    return Promise.resolve(this.#identity);
  }
}
