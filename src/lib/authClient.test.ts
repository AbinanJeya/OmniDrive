import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_SESSION_STORAGE_KEY,
  clearStoredAuthSession,
  getStoredAuthSession,
  isVerifiedSession,
  buildSupabaseOAuthUrl,
  consumeOAuthRedirectSession,
  requestPasswordReset,
  resendVerificationEmail,
  restoreAuthSession,
  signInWithPassword,
  signOutSession,
  signUpWithPassword,
  storeAuthSession,
  type StoredAuthSession,
} from './authClient';

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function createVerifiedSession(overrides: Partial<StoredAuthSession> = {}): StoredAuthSession {
  return {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: 'user-1',
      email: 'zia@example.com',
      emailConfirmedAt: '2026-04-28T12:00:00.000Z',
    },
    ...overrides,
  };
}

function installLocalStorageMock() {
  const storage = new Map<string, string>();
  const localStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
  };

  vi.stubGlobal('window', {
    localStorage,
  });

  return { storage, localStorage };
}

describe('authClient', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
    if (originalWindow) {
      vi.stubGlobal('window', originalWindow);
    }
  });

  it('stores and clears auth sessions in localStorage', () => {
    const { storage, localStorage } = installLocalStorageMock();
    const session = createVerifiedSession();

    storeAuthSession(session);
    expect(storage.get(AUTH_SESSION_STORAGE_KEY)).toContain('access-token');
    expect(getStoredAuthSession()?.user.email).toBe('zia@example.com');

    clearStoredAuthSession();
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
    expect(localStorage.removeItem).toHaveBeenCalledWith(AUTH_SESSION_STORAGE_KEY);
  });

  it('signs in with password and returns a verified session', async () => {
    installLocalStorageMock();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-token',
            refresh_token: 'refresh-token',
            expires_in: 3600,
            user: {
              id: 'user-1',
              email: 'zia@example.com',
              email_confirmed_at: '2026-04-28T12:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'user-1',
            email: 'zia@example.com',
            email_confirmed_at: '2026-04-28T12:00:00.000Z',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const session = await signInWithPassword({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      email: 'zia@example.com',
      password: 'password123',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://demo.supabase.co/auth/v1/token?grant_type=password',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(session.user.email).toBe('zia@example.com');
    expect(isVerifiedSession(session)).toBe(true);
  });

  it('restores a stored session by refreshing expired credentials', async () => {
    installLocalStorageMock();
    storeAuthSession(createVerifiedSession({ expiresAt: Math.floor(Date.now() / 1000) - 5 }));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
            user: {
              id: 'user-1',
              email: 'zia@example.com',
              email_confirmed_at: '2026-04-28T12:00:00.000Z',
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 'user-1',
            email: 'zia@example.com',
            email_confirmed_at: '2026-04-28T12:00:00.000Z',
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const restored = await restoreAuthSession({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://demo.supabase.co/auth/v1/token?grant_type=refresh_token',
      expect.any(Object),
    );
    expect(restored?.accessToken).toBe('fresh-access');
  });

  it('signs up and returns an unverified session state', async () => {
    installLocalStorageMock();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'user-2',
            email: 'new@example.com',
            email_confirmed_at: null,
          },
          session: null,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await signUpWithPassword({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      email: 'new@example.com',
      password: 'password123',
    });

    expect(result.email).toBe('new@example.com');
    expect(result.requiresEmailVerification).toBe(true);
  });

  it('sends a captcha token when signing up with captcha enabled', async () => {
    installLocalStorageMock();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          user: {
            id: 'user-2',
            email: 'new@example.com',
            email_confirmed_at: null,
          },
          session: null,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await signUpWithPassword({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      email: 'new@example.com',
      password: 'password123',
      captchaToken: 'captcha-token',
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      email: 'new@example.com',
      password: 'password123',
      gotrue_meta_security: {
        captcha_token: 'captcha-token',
      },
    });
  });

  it('supports resend verification, password reset, and sign out requests', async () => {
    const { storage } = installLocalStorageMock();
    storeAuthSession(createVerifiedSession());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await resendVerificationEmail({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      email: 'zia@example.com',
    });
    await requestPasswordReset({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      email: 'zia@example.com',
    });
    await signOutSession({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      accessToken: 'access-token',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://demo.supabase.co/auth/v1/resend',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://demo.supabase.co/auth/v1/recover',
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://demo.supabase.co/auth/v1/logout',
      expect.any(Object),
    );
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it('clears stored sessions even when signing out without an access token', async () => {
    const { storage } = installLocalStorageMock();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    storeAuthSession(createVerifiedSession());

    await signOutSession({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.has(AUTH_SESSION_STORAGE_KEY)).toBe(false);
  });

  it('builds a Google OAuth URL for browser sign in', () => {
    const url = new URL(buildSupabaseOAuthUrl({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
      provider: 'google',
      redirectTo: 'http://localhost:5173',
    }));

    expect(url.href.startsWith('https://demo.supabase.co/auth/v1/authorize')).toBe(true);
    expect(url.searchParams.get('provider')).toBe('google');
    expect(url.searchParams.get('redirect_to')).toBe('http://localhost:5173');
  });

  it('consumes an implicit OAuth redirect hash into a stored session', async () => {
    const { storage } = installLocalStorageMock();
    vi.stubGlobal('window', {
      localStorage: window.localStorage,
      location: {
        hash: '#access_token=oauth-access&refresh_token=oauth-refresh&expires_in=3600',
        pathname: '/',
        search: '',
      },
      history: {
        replaceState: vi.fn(),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'user-google',
          email: 'google@example.com',
          email_confirmed_at: '2026-04-29T12:00:00.000Z',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = await consumeOAuthRedirectSession({
      supabaseUrl: 'https://demo.supabase.co',
      supabaseAnonKey: 'anon-key',
    });

    expect(session?.accessToken).toBe('oauth-access');
    expect(session?.user.email).toBe('google@example.com');
    expect(storage.get(AUTH_SESSION_STORAGE_KEY)).toContain('oauth-refresh');
  });
});
