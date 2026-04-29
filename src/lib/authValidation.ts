export interface SignUpValidationInput {
  email: string;
  password: string;
  confirmPassword: string;
  captchaRequired: boolean;
  captchaToken: string;
}

export function validateSignUpForm(input: SignUpValidationInput): string | null {
  if (!input.email.trim()) {
    return 'Enter an email address.';
  }

  if (!input.password.trim()) {
    return 'Enter a password.';
  }

  if (input.password !== input.confirmPassword) {
    return 'Passwords do not match.';
  }

  if (input.captchaRequired && !input.captchaToken) {
    return 'Please complete the security check.';
  }

  return null;
}
