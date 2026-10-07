import { describe, expect, it } from 'vitest';
import {
  deepAnalysisInitiallyOpen,
  firstRunCopy,
  getDashboardMode,
  getDashboardSections,
  shiftMonth,
} from './dashboardPresentation';

describe('dashboard presentation modes', () => {
  it('shows only the focused first-run experience for an empty database', () => {
    const mode = getDashboardMode({
      transactionCount: 0,
      selectedMonth: 'all',
      periodStatus: null,
    });

    expect(mode).toBe('first-run');
    expect(getDashboardSections(mode)).toEqual(['first-run']);
    expect(firstRunCopy.action).toBe('Importera din första Excel-fil');
    expect(firstRunCopy.privacy).toBe('Din data stannar på den här datorn.');
    expect(firstRunCopy.privacy.toLocaleLowerCase('sv-SE')).not.toContain('cloud');
  });

  it('selects month, year, and future-month sections', () => {
    const month = getDashboardMode({
      transactionCount: 10,
      selectedMonth: '9',
      periodStatus: 'past',
    });
    const year = getDashboardMode({
      transactionCount: 10,
      selectedMonth: 'all',
      periodStatus: null,
    });
    const future = getDashboardMode({
      transactionCount: 10,
      selectedMonth: '11',
      periodStatus: 'future',
    });

    expect(getDashboardSections(month)).toEqual([
      'health', 'summary', 'budget', 'review', 'deep-analysis', 'other',
    ]);
    expect(getDashboardSections(year)).not.toContain('deep-analysis');
    expect(getDashboardSections(future)).not.toContain('summary');
    expect(getDashboardSections(future)).not.toContain('deep-analysis');
    expect(getDashboardSections(future)).toContain('budget');
  });

  it('keeps deep analysis collapsed by default', () => {
    expect(deepAnalysisInitiallyOpen).toBe(false);
  });
});

describe('month navigation', () => {
  it('moves within a year and across both year boundaries', () => {
    expect(shiftMonth(2026, 12, -1)).toEqual({ year: 2026, month: 11 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
  });

  it('allows next navigation into a future planning month', () => {
    const next = shiftMonth(2026, 10, 1);
    expect(next).toEqual({ year: 2026, month: 11 });
  });
});
