/**
 * Pure helpers behind the Settings screens. No React rendering here: the
 * screens are exercised on-device, these guard the rules the screens lean
 * on for instant validation, formatting and device naming.
 */

// profile.ts, avatar.ts and device.ts all pull in the Supabase client,
// which reads SUPABASE_URL / SUPABASE_ANON_KEY at import. None of the
// functions under test touch it, so it is replaced with an empty object.
jest.mock('../src/lib/supabase', () => ({ supabase: {} }));

import { avatarPath, base64ToBytes } from '../src/lib/avatar';
import { formatDateTime } from '../src/lib/format';
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  normalizeUsername,
  usernameProblem,
} from '../src/lib/profile';

type DeviceModule = typeof import('../src/lib/device');

/**
 * device.ts reads Platform at call time, and react-native's Platform under
 * Jest is whatever the preset's default platform is. A fresh module registry
 * per call lets each case pretend to be a different device.
 */
function deviceNameOn(platform: {
  OS: string;
  constants: Record<string, string | undefined>;
}): string {
  let name = '';
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: platform }));
    const device = require('../src/lib/device') as DeviceModule;
    name = device.deviceName();
  });
  jest.dontMock('react-native');
  return name;
}

describe('profile: normalizeUsername', () => {
  it('strips the leading @ and lower-cases', () => {
    expect(normalizeUsername('@JReyes')).toBe('jreyes');
  });

  it('strips repeated @ and surrounding whitespace', () => {
    expect(normalizeUsername('  @@Jordan.Reyes  ')).toBe('jordan.reyes');
  });

  it('leaves a clean name alone', () => {
    expect(normalizeUsername('kt_88')).toBe('kt_88');
  });
});

describe('profile: usernameProblem', () => {
  it('rejects names under 3 characters', () => {
    expect(usernameProblem('ab')).toBe('At least 3 characters.');
    expect(usernameProblem('@a')).toBe('At least 3 characters.');
    expect(usernameProblem('')).toBe('At least 3 characters.');
  });

  it('rejects names over 20 characters', () => {
    expect(usernameProblem('a'.repeat(21))).toBe('At most 20 characters.');
    expect(usernameProblem('a'.repeat(20))).toBeNull();
  });

  it('rejects a leading dot or underscore', () => {
    expect(usernameProblem('.jordan')).toBe('Start with a letter or number.');
    expect(usernameProblem('_jordan')).toBe('Start with a letter or number.');
  });

  it('rejects characters outside letters, digits, dots and underscores', () => {
    const problem = 'Letters, numbers, dots and underscores only.';
    expect(usernameProblem('jordan-reyes')).toBe(problem);
    expect(usernameProblem('jordan reyes')).toBe(problem);
    expect(usernameProblem('jordan!')).toBe(problem);
  });

  it('accepts a valid name in any case, with or without the @', () => {
    expect(usernameProblem('jordan.reyes')).toBeNull();
    expect(usernameProblem('@Jordan_Reyes')).toBeNull();
    expect(usernameProblem('kt88')).toBeNull();
  });
});

describe('profile: displayNameProblem', () => {
  it('accepts an empty name (it clears the field)', () => {
    expect(displayNameProblem('')).toBeNull();
    expect(displayNameProblem('   ')).toBeNull();
  });

  it('accepts anything up to the limit', () => {
    expect(displayNameProblem('Jordan Reyes')).toBeNull();
    expect(displayNameProblem('x'.repeat(DISPLAY_NAME_MAX))).toBeNull();
  });

  it('rejects names over the limit, ignoring surrounding whitespace', () => {
    const tooLong = `At most ${DISPLAY_NAME_MAX} characters.`;
    expect(displayNameProblem('x'.repeat(DISPLAY_NAME_MAX + 1))).toBe(tooLong);
    expect(displayNameProblem(`  ${'x'.repeat(DISPLAY_NAME_MAX)}  `)).toBeNull();
  });
});

describe('format: formatDateTime', () => {
  // Local-time constructors keep the expected strings independent of the
  // machine's time zone.
  const now = new Date(2026, 8, 6, 12, 0, 0);

  it('omits the year when it is this year', () => {
    const when = new Date(2026, 8, 6, 23, 37).toISOString();
    expect(formatDateTime(when, now)).toBe('Sep 6 · 11:37 PM');
  });

  it('adds the year when it is not this year', () => {
    const when = new Date(2025, 11, 31, 9, 5).toISOString();
    expect(formatDateTime(when, now)).toBe('Dec 31, 2025 · 9:05 AM');
  });

  it('uses 12 for midnight and noon', () => {
    expect(formatDateTime(new Date(2026, 0, 1, 0, 0).toISOString(), now)).toBe(
      'Jan 1 · 12:00 AM',
    );
    expect(formatDateTime(new Date(2026, 0, 1, 12, 30).toISOString(), now)).toBe(
      'Jan 1 · 12:30 PM',
    );
  });

  it('returns an empty string for an unparseable date', () => {
    expect(formatDateTime('not a date', now)).toBe('');
    expect(formatDateTime('', now)).toBe('');
  });
});

describe('avatar: base64ToBytes', () => {
  const hello = [104, 101, 108, 108, 111];

  it('decodes plain base64', () => {
    expect(Array.from(base64ToBytes('aGVsbG8='))).toEqual(hello);
  });

  it('strips a data: URL prefix first', () => {
    expect(Array.from(base64ToBytes('data:image/png;base64,aGVsbG8='))).toEqual(
      hello,
    );
  });

  it('ignores whitespace and line breaks inside the payload', () => {
    expect(Array.from(base64ToBytes('aGVs\nbG8='))).toEqual(hello);
  });

  it('returns a Uint8Array of the decoded length', () => {
    const bytes = base64ToBytes('aGVsbG8=');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(5);
  });
});

describe('avatar: avatarPath', () => {
  it('keeps the file inside the user folder with the extension for the mime', () => {
    expect(avatarPath('user-1', 'image/jpeg')).toBe('user-1/avatar.jpg');
    expect(avatarPath('user-1', 'image/png')).toBe('user-1/avatar.png');
    expect(avatarPath('user-1', 'image/webp')).toBe('user-1/avatar.webp');
  });

  it('falls back to jpg for anything else', () => {
    expect(avatarPath('user-1', 'image/heic')).toBe('user-1/avatar.jpg');
    expect(avatarPath('user-1', '')).toBe('user-1/avatar.jpg');
  });
});

describe('device: deviceName', () => {
  it('names an iPhone by its iOS version', () => {
    expect(
      deviceNameOn({
        OS: 'ios',
        constants: { interfaceIdiom: 'phone', systemName: 'iOS', osVersion: '18.2' },
      }),
    ).toBe('iPhone · iOS 18.2');
  });

  it('names an iPad by its iPadOS version', () => {
    expect(
      deviceNameOn({
        OS: 'ios',
        constants: { interfaceIdiom: 'pad', systemName: 'iPadOS', osVersion: '18' },
      }),
    ).toBe('iPad · iPadOS 18');
  });

  it('assumes iOS when the system name is missing', () => {
    expect(
      deviceNameOn({
        OS: 'ios',
        constants: { interfaceIdiom: 'phone', osVersion: '17.0' },
      }),
    ).toBe('iPhone · iOS 17.0');
  });

  it('names an Android device by capitalised brand, model and release', () => {
    expect(
      deviceNameOn({
        OS: 'android',
        constants: { Brand: 'google', Model: 'Pixel 8', Release: '15' },
      }),
    ).toBe('Google Pixel 8 · Android 15');
  });

  it('falls back to a generic Android name without brand or model', () => {
    expect(deviceNameOn({ OS: 'android', constants: { Release: '14' } })).toBe(
      'Android device · Android 14',
    );
  });

  it('returns the bare platform for anything else', () => {
    expect(deviceNameOn({ OS: 'web', constants: {} })).toBe('web');
  });
});
