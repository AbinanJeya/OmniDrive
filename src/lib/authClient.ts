export const AUTH_SESSION_STORAGE_KEY = 'omnidrive:auth-session';

export interface AuthUser {
  id: string;
  email: string;
  emailConfirmedAt: string | null;
}

export interface StoredAuthSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: AuthUser;
}

export interface SupabaseConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

export interface SignInWithPasswordInput extends SupabaseConfig {
  email: string;
  password: string;
  captchaToken?: string;
}

export interface SignUpWithPasswordInput extends SupabaseConfig {
  email: string;
  password: string;
  captchaToken?: string;
}

export interface EmailOnlyRequest extends SupabaseConfig {
  email: string;
  captchaToken?: string;
}

export interface SignOutSessionInput extends SupabaseConfig {
  accessToken?: string;
}

export interface OAuthUrlInput extends SupabaseConfig {
  provider: 'google';
  redirectTo: string;
  captchaToken?: string;
}

export interface SignUpResult {
  email: string;
  userId: string;
  requiresEmailVerification: boolean;
}

interface SupabaseSessionResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user?: SupabaseUserResponse | null;
}

interface SupabaseUserResponse {
  id: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
}

function headers(config: SupabaseConfig, accessToken?: string): HeadersInit {
  const nextHeaders: Record<string, string> = {
    apikey: config.supabaseAnonKey,
    'Content-Type': 'application/json',
  };

  if (accessToken) {
    nextHeaders.Authorization = `Bearer ${accessToken}`;
  }

  return nextHeaders;
}

function normalizeAuthUser(user: SupabaseUserResponse): AuthUser {
  return {
    id: user.id,
    email: user.email ?? '',
    emailConfirmedAt: user.email_confirmed_at ?? user.confirmed_at ?? null,
  };
}

function normalizeSessionPayload(payload: SupabaseSessionResponse, user: SupabaseUserResponse): StoredAuthSession {
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + Math.max(payload.expires_in ?? 0, 0),
    user: normalizeAuthUser(user),
  };
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function fetchCurrentUser(
  config: SupabaseConfig,
  accessToken: string,
): Promise<SupabaseUserResponse> {
  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    method: 'GET',
    headers: headers(config, accessToken),
  });

  return readJsonResponse<SupabaseUserResponse>(response);
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && 'localStorage' in window;
}

export function storeAuthSession(session: StoredAuthSession): void {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.setItem(AUTH_SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function getStoredAuthSession(): StoredAuthSession | null {
  if (!canUseStorage()) {
    return null;
  }

  const rawValue = window.localStorage.getItem(AUTH_SESSION_STORAGE_KEY);
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue) as StoredAuthSession;
  } catch {
    window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
    return null;
  }
}

export function clearStoredAuthSession(): void {
  if (!canUseStorage()) {
    return;
  }

  window.localStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
}

export function isVerifiedSession(session: Pick<StoredAuthSession, 'user'> | null | undefined): boolean {
  return Boolean(session?.user.emailConfirmedAt);
}

export function buildSupabaseOAuthUrl(input: OAuthUrlInput): string {
  const url = new URL(`${input.supabaseUrl}/auth/v1/authorize`);
  url.searchParams.set('provider', input.provider);
  url.searchParams.set('redirect_to', input.redirectTo);
  url.searchParams.set('scopes', 'email profile');
  if (input.captchaToken) {
    url.searchParams.set('captcha_token', input.captchaToken);
  }
  return url.toString();
}

export async function consumeOAuthRedirectSession(
  config: SupabaseConfig,
): Promise<StoredAuthSession | null> {
  if (typeof window === 'undefined' || !window.location.hash.includes('access_token=')) {
    return null;
  }

  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) {
    return null;
  }

  const expiresIn = Number(params.get('expires_in') ?? '3600');
  const userPayload = await fetchCurrentUser(config, accessToken);
  const session: StoredAuthSession = {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Math.max(Number.isFinite(expiresIn) ? expiresIn : 3600, 0),
    user: normalizeAuthUser(userPayload),
  };
  storeAuthSession(session);
  window.history.replaceState(
    {},
    typeof document === 'undefined' ? '' : document.title,
    `${window.location.pathname}${window.location.search}`,
  );
  return session;
}

export async function signInWithPassword(input: SignInWithPasswordInput): Promise<StoredAuthSession> {
  const body: Record<string, unknown> = {
    email: input.email,
    password: input.password,
  };

  if (input.captchaToken) {
    body.gotrue_meta_security = {
      captcha_token: input.captchaToken,
    };
  }

  const sessionResponse = await fetch(`${input.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: headers(input),
    body: JSON.stringify(body),
  });
  const sessionPayload = await readJsonResponse<SupabaseSessionResponse>(sessionResponse);
  const userPayload = await fetchCurrentUser(input, sessionPayload.access_token);
  const session = normalizeSessionPayload(sessionPayload, userPayload);
  storeAuthSession(session);
  return session;
}

async function refreshStoredSession(
  config: SupabaseConfig,
  refreshToken: string,
): Promise<StoredAuthSession> {
  const refreshResponse = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: headers(config),
    body: JSON.stringify({
      refresh_token: refreshToken,
    }),
  });
  const refreshedPayload = await readJsonResponse<SupabaseSessionResponse>(refreshResponse);
  const userPayload = await fetchCurrentUser(config, refreshedPayload.access_token);
  const session = normalizeSessionPayload(refreshedPayload, userPayload);
  storeAuthSession(session);
  return session;
}

export async function restoreAuthSession(config: SupabaseConfig): Promise<StoredAuthSession | null> {
  const storedSession = getStoredAuthSession();
  if (!storedSession) {
    return null;
  }

  const nowUnix = Math.floor(Date.now() / 1000);
  if (storedSession.expiresAt > nowUnix + 60) {
    return storedSession;
  }

  try {
    return await refreshStoredSession(config, storedSession.refreshToken);
  } catch {
    clearStoredAuthSession();
    return null;
  }
}

export async function signUpWithPassword(input: SignUpWithPasswordInput): Promise<SignUpResult> {
  const body: Record<string, unknown> = {
    email: input.email,
    password: input.password,
  };

  if (input.captchaToken) {
    body.gotrue_meta_security = {
      captcha_token: input.captchaToken,
    };
  }

  const response = await fetch(`${input.supabaseUrl}/auth/v1/signup`, {
    method: 'POST',
    headers: headers(input),
    body: JSON.stringify(body),
  });
  const payload = await readJsonResponse<{
    user?: SupabaseUserResponse | null;
    session?: SupabaseSessionResponse | null;
  }>(response);
  const user = payload.user ?? payload.session?.user ?? null;

  return {
    email: user?.email ?? input.email,
    userId: user?.id ?? input.email,
    requiresEmailVerification: true,
  };
}

export async function resendVerificationEmail(input: EmailOnlyRequest): Promise<void> {
  const body: Record<string, unknown> = {
    type: 'signup',
    email: input.email,
  };

  if (input.captchaToken) {
    body.gotrue_meta_security = {
      captcha_token: input.captchaToken,
    };
  }

  const response = await fetch(`${input.supabaseUrl}/auth/v1/resend`, {
    method: 'POST',
    headers: headers(input),
    body: JSON.stringify(body),
  });

  await readJsonResponse<Record<string, never>>(response);
}

export async function requestPasswordReset(input: EmailOnlyRequest): Promise<void> {
  const body: Record<string, unknown> = {
    email: input.email,
  };

  if (input.captchaToken) {
    body.gotrue_meta_security = {
      captcha_token: input.captchaToken,
    };
  }

  const response = await fetch(`${input.supabaseUrl}/auth/v1/recover`, {
    method: 'POST',
    headers: headers(input),
    body: JSON.stringify(body),
  });

  await readJsonResponse<Record<string, never>>(response);
}

export async function signOutSession(input: SignOutSessionInput): Promise<void> {
  if (!input.accessToken) {
    clearStoredAuthSession();
    return;
  }

  const response = await fetch(`${input.supabaseUrl}/auth/v1/logout`, {
    method: 'POST',
    headers: headers(input, input.accessToken),
  });

  if (!response.ok && response.status !== 204) {
    const message = await response.text();
    throw new Error(message || `Request failed with status ${response.status}`);
  }

  clearStoredAuthSession();
}
