import { describe, it, expect } from 'vitest';
import { formatDate, formatRelativeDate } from '../../src/utils/marshal.js';

describe('formatDate time zones', () => {
  const due = '2025-11-25T03:30:00.000Z';

  it('always names the zone', () => {
    expect(formatDate(due, 'UTC')).toBe('Tue, Nov 25, 2025, 3:30 AM UTC');
  });

  it('shows the date in the chosen zone (here the previous evening)', () => {
    expect(formatDate(due, 'America/Toronto')).toBe('Mon, Nov 24, 2025, 10:30 PM EST');
  });

  it('returns null for an unparseable date', () => {
    expect(formatDate('not a date', 'UTC')).toBeNull();
  });
});

describe('formatRelativeDate calendar days', () => {
  const morning = new Date('2025-11-24T08:00:00Z');

  it('calls 23:59 tonight "today" (rounding hours used to say "tomorrow")', () => {
    expect(formatRelativeDate('2025-11-24T23:59:00Z', morning, 'UTC')).toBe('today');
  });

  it('calls 00:30 the next day "tomorrow" even though it is under a day away', () => {
    const lateNight = new Date('2025-11-24T23:00:00Z');
    expect(formatRelativeDate('2025-11-25T00:30:00Z', lateNight, 'UTC')).toBe('tomorrow');
  });

  it('counts days in the display zone, not UTC', () => {
    // 03:30 UTC on the 25th is still the evening of the 24th in Toronto.
    expect(formatRelativeDate('2025-11-25T03:30:00Z', morning, 'America/Toronto')).toBe('today');
    expect(formatRelativeDate('2025-11-25T03:30:00Z', morning, 'UTC')).toBe('tomorrow');
  });

  it('uses "in N days" / "N days ago" within a week, the full date beyond', () => {
    expect(formatRelativeDate('2025-11-27T12:00:00Z', morning, 'UTC')).toBe('in 3 days');
    expect(formatRelativeDate('2025-11-22T12:00:00Z', morning, 'UTC')).toBe('2 days ago');
    expect(formatRelativeDate('2025-12-10T12:00:00Z', morning, 'UTC')).toMatch(/Dec 10, 2025/);
  });
});
