import { describe, expect, it } from 'vitest';
import { validateSignUpForm } from './authValidation';

describe('authValidation', () => {
  it('requires matching signup passwords', () => {
    expect(validateSignUpForm({
      email: 'zia@example.com',
      password: 'password123',
      confirmPassword: 'password321',
      captchaRequired: false,
      captchaToken: '',
    })).toEqual('Passwords do not match.');
  });

  it('requires a captcha token when captcha is enabled', () => {
    expect(validateSignUpForm({
      email: 'zia@example.com',
      password: 'password123',
      confirmPassword: 'password123',
      captchaRequired: true,
      captchaToken: '',
    })).toEqual('Please complete the security check.');
  });

  it('accepts a complete signup form', () => {
    expect(validateSignUpForm({
      email: 'zia@example.com',
      password: 'password123',
      confirmPassword: 'password123',
      captchaRequired: true,
      captchaToken: 'captcha-token',
    })).toBeNull();
  });
});
