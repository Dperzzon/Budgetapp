export type ImportAnalysisPhase =
  | 'preparing'
  | 'checking-duplicate'
  | 'reading-workbook'
  | 'validating';

export type FileImportOutcome =
  | {
      status: 'imported';
      fileName: string;
      transactionCount: number;
    }
  | {
      status: 'failed';
      fileName: string;
      message: string;
      technicalDetails?: string;
    }
  | {
      status: 'skipped';
      fileName: string;
      reason: string;
    };

export type ErrorContext =
  | 'database-init'
  | 'budget-load'
  | 'budget-save'
  | 'import-analysis'
  | 'import-file'
  | 'review-update'
  | 'transaction-delete'
  | 'import-history'
  | 'import-undo';

export type UserFacingError = {
  message: string;
  technicalDetails: string;
  dataLocation?: string;
};

export type SequentialImportResult = {
  outcomes: FileImportOutcome[];
  firstFailedIndex: number;
};

export type DatabaseInitializationResult<T> =
  | { status: 'ready'; value: T }
  | { status: 'fatal'; error: UserFacingError };

const technicalMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function getUserFacingError(
  error: unknown,
  context: ErrorContext,
  fileName?: string
): UserFacingError {
  const technicalDetails = technicalMessage(error);
  const normalized = technicalDetails.toLocaleLowerCase('sv-SE');
  const dataLocation = context === 'database-init'
    ? technicalDetails.match(/Databasfil:\s*(.+)/)?.[1]?.trim()
    : undefined;

  if (
    normalized.includes('redan importer') ||
    normalized.includes('already import') ||
    normalized.includes('file_sha256')
  ) {
    return {
      message: 'Den här filen har redan importerats. Tidigare importerade transaktioner finns kvar.',
      technicalDetails,
    };
  }

  const messages: Record<ErrorContext, string> = {
    'database-init':
      'BudgetApp kunde inte öppna den lokala databasen. Dina tidigare data har inte ersatts. Försök igen.',
    'budget-load':
      'Budgeten kunde inte läsas från den lokala databasen. Tidigare data finns kvar.',
    'budget-save':
      'Budgeten kunde inte sparas. Det tidigare värdet finns kvar. Försök igen.',
    'import-analysis':
      'Filen kunde inte läsas och inga transaktioner sparades. Kontrollera filen och försök igen.',
    'import-file':
      `${fileName ? `Importen av ${fileName}` : 'Importen'} misslyckades. Inga transaktioner från den filen sparades.`,
    'review-update':
      'Ändringen kunde inte sparas. Tidigare transaktionsdata finns kvar. Försök igen.',
    'transaction-delete':
      'Transaktionen kunde inte tas bort och finns kvar.',
    'import-history':
      'Importinformationen kunde inte läsas. Dina transaktioner finns kvar.',
    'import-undo':
      'Importen kunde inte ångras. Inga transaktioner togs bort.',
  };

  return { message: messages[context], technicalDetails, dataLocation };
}

export async function runDatabaseInitialization<T>(
  initialize: () => Promise<T>
): Promise<DatabaseInitializationResult<T>> {
  try {
    return { status: 'ready', value: await initialize() };
  } catch (error) {
    return {
      status: 'fatal',
      error: getUserFacingError(error, 'database-init'),
    };
  }
}

export function createLatestRunGuard() {
  let latestRunId = 0;
  return {
    begin(): number {
      latestRunId += 1;
      return latestRunId;
    },
    isLatest(runId: number): boolean {
      return runId === latestRunId;
    },
  };
}

export function importControlsDisabled(input: {
  dbReady: boolean;
  isAnalyzingImport: boolean;
  isImporting: boolean;
}): boolean {
  return !input.dbReady || input.isAnalyzingImport || input.isImporting;
}

export async function runSequentialFileImports<T extends { fileName: string }>(
  files: T[],
  importFile: (file: T) => Promise<{ transactionCount: number }>
): Promise<SequentialImportResult> {
  const outcomes: FileImportOutcome[] = [];
  for (const [index, file] of files.entries()) {
    try {
      const imported = await importFile(file);
      outcomes.push({
        status: 'imported',
        fileName: file.fileName,
        transactionCount: imported.transactionCount,
      });
    } catch (error) {
      const userError = getUserFacingError(error, 'import-file', file.fileName);
      outcomes.push({
        status: 'failed',
        fileName: file.fileName,
        message: userError.message,
        technicalDetails: userError.technicalDetails,
      });
      for (const skipped of files.slice(index + 1)) {
        outcomes.push({
          status: 'skipped',
          fileName: skipped.fileName,
          reason: 'Importerades inte eftersom en tidigare fil misslyckades.',
        });
      }
      return { outcomes, firstFailedIndex: index };
    }
  }
  return { outcomes, firstFailedIndex: -1 };
}

export function importAnalysisPhaseText(
  phase: ImportAnalysisPhase,
  fileIndex: number,
  fileCount: number
): string {
  const prefix = fileCount > 1 ? `Analyserar fil ${fileIndex} av ${fileCount}. ` : '';
  const phaseText: Record<ImportAnalysisPhase, string> = {
    preparing: 'Förbereder filen...',
    'checking-duplicate': 'Kontrollerar om filen redan har importerats...',
    'reading-workbook': 'Läser Excel-filen...',
    validating: 'Kontrollerar transaktionerna...',
  };
  return `${prefix}${phaseText[phase]}`;
}

export function buildBulkConfirmation(input: {
  kind: 'category' | 'transaction-type';
  merchant: string;
  count: number;
  newValue: string;
}): string {
  const label = input.kind === 'category' ? 'kategori' : 'ekonomisk typ';
  return [
    `Ändra ${label} för ${input.count} transaktioner?`,
    '',
    'Butik/mottagare:',
    input.merchant,
    '',
    `Ny ${label}:`,
    input.newValue,
    '',
    `Detta ändrar ${input.count} befintliga transaktioner.`,
  ].join('\n');
}

export function buildRememberForwardConfirmation(input: {
  kind: 'category' | 'transaction-type';
  merchant: string;
  newValue: string;
}): string {
  const label = input.kind === 'category' ? 'kategori' : 'ekonomisk typ';
  return [
    `Använd ${input.newValue} även för framtida importer?`,
    '',
    `${input.merchant} ändras nu. Samma butik/mottagare får automatiskt denna ${label} i framtida importer.`,
  ].join('\n');
}

export async function runConfirmedAction(
  confirmAction: (message: string) => boolean,
  message: string,
  action: () => Promise<void>
): Promise<boolean> {
  if (!confirmAction(message)) return false;
  await action();
  return true;
}
