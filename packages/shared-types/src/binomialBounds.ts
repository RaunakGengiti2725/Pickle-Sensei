export function zeroEventUpperBound95(independentTrials: number): number {
  if (!Number.isSafeInteger(independentTrials) || independentTrials < 0) {
    throw new RangeError("Independent trial count must be a nonnegative safe integer.");
  }
  if (independentTrials === 0) return 1;
  return -Math.expm1(Math.log(0.05) / independentTrials);
}

export function independentTrialsForZeroEventUpperBound95(target: number): number {
  if (!Number.isFinite(target) || target <= 0 || target >= 1) {
    throw new RangeError("The target bound must be strictly between zero and one.");
  }
  const count = Math.ceil(Math.log(0.05) / Math.log1p(-target));
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError("The required independent trial count is not representable.");
  }
  return count;
}
