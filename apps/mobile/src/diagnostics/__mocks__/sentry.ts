export const NATIVE_DIAGNOSTICS_STATUS = 'blocked_unverified_native_filtering';
export const initializeDiagnostics = jest.fn(() => 'disabled' as const);
export const captureGlobalError = jest.fn(
  (_error: unknown, _fatal?: boolean) => false,
);
export const captureBoundaryError = jest.fn((_error: unknown) => false);
export const captureHandledError = jest.fn((_error: unknown) => false);
export const resetDiagnosticsScope = jest.fn(() => false);
export const getDiagnosticsStatus = jest.fn(() => ({
  javascript: 'disabled' as const,
  native: NATIVE_DIAGNOSTICS_STATUS,
  transportEnabled: false,
  persistentQueue: false,
}));
