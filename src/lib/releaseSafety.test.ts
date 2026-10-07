import { describe, expect, it, vi } from 'vitest';
import {
  buildBulkConfirmation,
  buildRememberForwardConfirmation,
  createLatestRunGuard,
  getUserFacingError,
  importAnalysisPhaseText,
  importControlsDisabled,
  runConfirmedAction,
  runDatabaseInitialization,
  runSequentialFileImports,
} from './releaseSafety';

describe('import analysis safety', () => {
  it('allows only the latest analysis run to apply its result', () => {
    const guard = createLatestRunGuard();
    const runA = guard.begin();
    const runB = guard.begin();

    expect(guard.isLatest(runB)).toBe(true);
    expect(guard.isLatest(runA)).toBe(false);
  });

  it('disables controls while analysis or import is active and restores them afterward', () => {
    expect(importControlsDisabled({
      dbReady: true,
      isAnalyzingImport: true,
      isImporting: false,
    })).toBe(true);
    expect(importControlsDisabled({
      dbReady: true,
      isAnalyzingImport: false,
      isImporting: true,
    })).toBe(true);
    expect(importControlsDisabled({
      dbReady: true,
      isAnalyzingImport: false,
      isImporting: false,
    })).toBe(false);
  });

  it('describes the active file and phase', () => {
    expect(importAnalysisPhaseText('reading-workbook', 2, 4))
      .toBe('Analyserar fil 2 av 4. Läser Excel-filen...');
  });
});

describe('multi-file import outcomes', () => {
  it('reports imported, failed, and skipped files without implying a rollback', async () => {
    const files = [
      { fileName: 'januari.xlsx' },
      { fileName: 'februari.xlsx' },
      { fileName: 'mars.xlsx' },
      { fileName: 'april.xlsx' },
    ];
    const result = await runSequentialFileImports(files, async (file) => {
      if (file.fileName === 'mars.xlsx') throw new Error('disk full');
      return { transactionCount: file.fileName === 'januari.xlsx' ? 143 : 151 };
    });

    expect(result.firstFailedIndex).toBe(2);
    expect(result.outcomes).toEqual([
      { status: 'imported', fileName: 'januari.xlsx', transactionCount: 143 },
      { status: 'imported', fileName: 'februari.xlsx', transactionCount: 151 },
      expect.objectContaining({
        status: 'failed',
        fileName: 'mars.xlsx',
        message: 'Importen av mars.xlsx misslyckades. Inga transaktioner från den filen sparades.',
      }),
      {
        status: 'skipped',
        fileName: 'april.xlsx',
        reason: 'Importerades inte eftersom en tidigare fil misslyckades.',
      },
    ]);
  });

  it('can retry only the files that were not previously imported', async () => {
    const importFile = vi.fn(async (file: { fileName: string }) => ({
      transactionCount: file.fileName === 'mars.xlsx' ? 120 : 130,
    }));

    const result = await runSequentialFileImports(
      [{ fileName: 'mars.xlsx' }, { fileName: 'april.xlsx' }],
      importFile
    );

    expect(result.firstFailedIndex).toBe(-1);
    expect(result.outcomes.map((outcome) => outcome.status)).toEqual(['imported', 'imported']);
    expect(importFile).toHaveBeenCalledTimes(2);
  });
});

describe('review safety copy and confirmation', () => {
  it('does not run a bulk action before confirmation and respects cancellation', async () => {
    const action = vi.fn(async () => undefined);
    const message = buildBulkConfirmation({
      kind: 'category',
      merchant: 'ICA MAXI',
      count: 12,
      newValue: 'Mat / Dagligvaror',
    });

    await expect(runConfirmedAction(() => false, message, action)).resolves.toBe(false);
    expect(action).not.toHaveBeenCalled();
    expect(message).toContain('12 befintliga transaktioner');
    expect(message).toContain('ICA MAXI');
    expect(message).toContain('Mat / Dagligvaror');
  });

  it('runs the confirmed action exactly once and explains future rules', async () => {
    const action = vi.fn(async () => undefined);
    const futureMessage = buildRememberForwardConfirmation({
      kind: 'transaction-type',
      merchant: 'Swish mottaget',
      newValue: 'Inkomst',
    });

    await expect(runConfirmedAction(() => true, futureMessage, action)).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(futureMessage).toContain('ändras nu');
    expect(futureMessage).toContain('framtida importer');
  });
});

describe('user-facing error mapping', () => {
  it('maps database, import, and duplicate errors to stable Swedish copy', () => {
    const database = getUserFacingError(
      new Error('SQLITE_CANTOPEN: unable to open database file\nDatabasfil: C:\\Data\\budgetapp.sqlite'),
      'database-init'
    );
    const imported = getUserFacingError(
      new Error('file already imported'),
      'import-file',
      'januari.xlsx'
    );
    const failedImport = getUserFacingError(
      new Error('SQLITE_FULL'),
      'import-file',
      'mars.xlsx'
    );

    expect(database.message).toContain('kunde inte öppna den lokala databasen');
    expect(database.message).not.toContain('SQLITE_CANTOPEN');
    expect(database.dataLocation).toBe('C:\\Data\\budgetapp.sqlite');
    expect(imported.message).toBe('Den här filen har redan importerats. Tidigare importerade transaktioner finns kvar.');
    expect(failedImport.message).toBe(
      'Importen av mars.xlsx misslyckades. Inga transaktioner från den filen sparades.'
    );
    expect(failedImport.technicalDetails).toBe('SQLITE_FULL');
  });

  it('returns a blocking fatal result and allows the same initialization to be retried', async () => {
    const initialize = vi.fn()
      .mockRejectedValueOnce(new Error(
        'SQLITE_CANTOPEN\nDatabasfil: C:\\Data\\budgetapp.sqlite'
      ))
      .mockResolvedValueOnce({ path: 'C:\\Data\\budgetapp.sqlite' });

    const failed = await runDatabaseInitialization(initialize);
    const retried = await runDatabaseInitialization(initialize);

    expect(failed).toMatchObject({
      status: 'fatal',
      error: {
        message: expect.stringContaining('kunde inte öppna den lokala databasen'),
        dataLocation: 'C:\\Data\\budgetapp.sqlite',
      },
    });
    expect(failed.status === 'fatal' && failed.error.message).not.toContain('SQLITE_CANTOPEN');
    expect(retried).toEqual({
      status: 'ready',
      value: { path: 'C:\\Data\\budgetapp.sqlite' },
    });
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
