import type { PeriodStatus } from './finance';

export type DashboardMode = 'first-run' | 'month' | 'year' | 'future-month';
export type DashboardSection =
  | 'first-run'
  | 'health'
  | 'summary'
  | 'budget'
  | 'review'
  | 'deep-analysis'
  | 'other';

export const firstRunCopy = {
  title: 'Välkommen till BudgetApp',
  description: 'Få koll på vart pengarna går, vad som förändras och hur din budget utvecklas.',
  privacy: 'Din data stannar på den här datorn.',
  action: 'Importera din första Excel-fil',
  fileHelp: 'BudgetApp importerar .xlsx-filer från din bank.',
} as const;

export const deepAnalysisInitiallyOpen = false;

export function getDashboardMode(input: {
  transactionCount: number;
  selectedMonth: string;
  periodStatus: PeriodStatus | null;
}): DashboardMode {
  if (input.transactionCount === 0) return 'first-run';
  if (input.selectedMonth === 'all') return 'year';
  return input.periodStatus === 'future' ? 'future-month' : 'month';
}

export function getDashboardSections(mode: DashboardMode): DashboardSection[] {
  if (mode === 'first-run') return ['first-run'];
  if (mode === 'year') return ['health', 'summary', 'budget', 'review', 'other'];
  if (mode === 'future-month') {
    return ['health', 'budget', 'review', 'other'];
  }
  return ['health', 'summary', 'budget', 'review', 'deep-analysis', 'other'];
}

export function shiftMonth(
  year: number,
  month: number,
  direction: -1 | 1
): { year: number; month: number } {
  const shifted = new Date(year, month - 1 + direction, 1);
  return {
    year: shifted.getFullYear(),
    month: shifted.getMonth() + 1,
  };
}
