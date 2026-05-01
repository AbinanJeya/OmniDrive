import { describe, expect, it } from 'vitest';
import { dragPreviewTransform } from './dragPresentation';

describe('dragPresentation', () => {
  it('keeps the grabbed preview tucked under the pointer instead of trailing away from it', () => {
    expect(dragPreviewTransform(200, 120)).toBe('translate3d(182px, 102px, 0)');
  });
});
