import { PUBLIC_ID_LENGTH } from './videos.constants';
import { generatePublicId } from './public-id.util';

const BASE62_PATTERN = /^[A-Za-z0-9]+$/;

describe('generatePublicId', () => {
  it('should produce an identifier of the configured length', () => {
    expect(generatePublicId()).toHaveLength(PUBLIC_ID_LENGTH);
  });

  it('should only use URL-safe base62 characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(generatePublicId()).toMatch(BASE62_PATTERN);
    }
  });

  it('should honour an explicit length', () => {
    expect(generatePublicId(5)).toHaveLength(5);
    expect(generatePublicId(21)).toHaveLength(21);
  });

  it('should not repeat across many draws', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => generatePublicId()));

    expect(ids.size).toBe(2000);
  });

  it('should draw from the whole alphabet rather than a slice of it', () => {
    // 62 characters over 11 positions: with a biased byte mapping the tail of the
    // alphabet would be under-represented, and 62k draws would miss characters.
    const seen = new Set(
      Array.from({ length: 1000 }, () => generatePublicId()).join(''),
    );

    expect(seen.size).toBe(62);
  });
});
