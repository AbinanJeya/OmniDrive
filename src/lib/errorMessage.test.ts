import { describe, expect, it } from 'vitest';
import { toUserFacingErrorMessage } from './errorMessage';

describe('toUserFacingErrorMessage', () => {
  it('returns a plain string rejection as-is', () => {
    expect(
      toUserFacingErrorMessage(
        'failed to refresh access token for drive-a: error sending request for url',
        'fallback',
      ),
    ).toBe('failed to refresh access token for drive-a: error sending request for url');
  });

  it('returns the message from Error instances', () => {
    expect(toUserFacingErrorMessage(new Error('boom'), 'fallback')).toBe('boom');
  });

  it('returns message fields from plain objects', () => {
    expect(
      toUserFacingErrorMessage(
        { message: 'drive snapshots command failed' },
        'fallback',
      ),
    ).toBe('drive snapshots command failed');
  });

  it('falls back when no useful message is available', () => {
    expect(toUserFacingErrorMessage(null, 'fallback')).toBe('fallback');
  });
});
