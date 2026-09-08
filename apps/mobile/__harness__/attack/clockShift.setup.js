// Adversarial harness (P0-02): shifts the real wall clock every test file sees
// by PICKLE_ATTACK_CLOCK_SHIFT_MS milliseconds (positive = future, negative =
// past) before any test code or fake-timer install runs. Jest's modern fake
// timers capture the Date that is global at install time, so a suite that
// calls jest.useFakeTimers() without setSystemTime() also starts at the
// shifted "now". Suites that pin an absolute date via setSystemTime() are
// unaffected, which is exactly the property under attack: anything that still
// compares against the real clock (hard-coded expiry dates, "far future"
// fixtures, ISO date fixtures) surfaces as a time bomb.
const shiftMs = Number(process.env.PICKLE_ATTACK_CLOCK_SHIFT_MS ?? '0');
if (!Number.isFinite(shiftMs)) {
  throw new Error(
    `PICKLE_ATTACK_CLOCK_SHIFT_MS must be a finite number, got ${JSON.stringify(
      process.env.PICKLE_ATTACK_CLOCK_SHIFT_MS,
    )}`,
  );
}

if (shiftMs !== 0) {
  const RealDate = Date;
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + shiftMs);
      } else {
        super(...args);
      }
    }
    static now() {
      return RealDate.now() + shiftMs;
    }
  }
  Object.defineProperty(ShiftedDate, 'name', { value: 'Date' });
  globalThis.Date = ShiftedDate;
  globalThis.__PICKLE_ATTACK_CLOCK_SHIFT_MS__ = shiftMs;
}
