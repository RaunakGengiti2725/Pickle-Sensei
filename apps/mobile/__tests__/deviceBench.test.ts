import fixture from './fixtures/deviceBenchExport.fixture.json';
import {
  DEVICE_BENCH_SCHEMA_VERSION,
  DeviceBenchRecorder,
  deviceBenchExportFilename,
  validateDeviceBenchExport,
  type DeviceBenchExportV1,
} from '../src/camera/deviceBench';

/**
 * D10 — device-bench export contract (pickle.device-bench.v1). The fixture is
 * SYNTHETIC (no physical iPhone exists — BLOCKED_EXTERNAL); these tests pin
 * the schema and the recorder's refusal to emit unexplained missing signals.
 */

function clone(): DeviceBenchExportV1 {
  return JSON.parse(JSON.stringify(fixture)) as DeviceBenchExportV1;
}

describe('validateDeviceBenchExport', () => {
  it('accepts the synthetic fixture', () => {
    expect(validateDeviceBenchExport(clone())).toEqual([]);
  });

  it('rejects a wrong schema version', () => {
    const doc = clone();
    (doc as { schemaVersion: string }).schemaVersion = 'pickle.device-bench.v2';
    expect(validateDeviceBenchExport(doc)).toEqual([
      'schemaVersion: expected "pickle.device-bench.v1", got "pickle.device-bench.v2"',
    ]);
  });

  it('rejects an empty series without an unavailableReason', () => {
    const doc = clone();
    doc.thermal = { samples: [], unavailableReason: null };
    expect(validateDeviceBenchExport(doc)).toEqual([
      'thermal: empty series requires a nonempty unavailableReason',
    ]);
  });

  it('accepts an empty series WITH a reason (missing signal stays missing)', () => {
    const doc = clone();
    doc.memory = {
      samples: [],
      unavailableReason: 'memory polling not wired on this build',
    };
    expect(validateDeviceBenchExport(doc)).toEqual([]);
  });

  it('rejects an unavailableReason alongside samples', () => {
    const doc = clone();
    doc.fps.unavailableReason = 'stale reason';
    expect(validateDeviceBenchExport(doc)).toEqual([
      'fps: unavailableReason must be null when samples exist',
    ]);
  });

  it('rejects unknown thermal states and non-monotonic timestamps', () => {
    const doc = clone();
    doc.thermal.samples = [
      { tMs: 1000, state: 'nominal' },
      { tMs: 500, state: 'melting' as never },
    ];
    expect(validateDeviceBenchExport(doc)).toEqual([
      'thermal.samples[1].tMs: not monotonically non-decreasing',
      'thermal.samples[1].state: not one of nominal|fair|serious|critical',
    ]);
  });

  it('rejects non-finite fps and non-positive windows', () => {
    const doc = clone();
    doc.fps.samples = [{ tMs: 0, fps: Number.NaN, windowMs: 0 }];
    expect(validateDeviceBenchExport(doc)).toEqual([
      'fps.samples[0].fps: not a finite non-negative number',
      'fps.samples[0].windowMs: not a finite positive number',
    ]);
  });

  it('rejects malformed capture refs', () => {
    const doc = clone();
    doc.captures = [
      {
        clipUri: '',
        finalizedAtMs: -1,
        completionStrategy: 'other' as never,
        telemetrySchemas: [''],
      },
    ];
    expect(validateDeviceBenchExport(doc)).toEqual([
      'captures[0].clipUri: not a nonempty string',
      'captures[0].finalizedAtMs: not a finite non-negative number',
      'captures[0].completionStrategy: not "fixed" | "adaptive"',
      'captures[0].telemetrySchemas: not an array of nonempty strings',
    ]);
  });

  it('handles garbage without throwing', () => {
    expect(validateDeviceBenchExport(null)).toEqual([
      'document: not an object',
    ]);
    expect(validateDeviceBenchExport(42).length).toBeGreaterThan(0);
  });
});

describe('DeviceBenchRecorder', () => {
  const init = {
    deviceModel: 'iPhone16,1',
    osVersion: 'iOS 18.5',
    appVersion: '0.1.0 (42)',
    startedAtIso: '2026-08-29T00:00:00.000Z',
  };

  it('produces a valid export from pushed samples', () => {
    const recorder = new DeviceBenchRecorder(init);
    recorder.pushThermal({ tMs: 0, state: 'nominal' });
    recorder.pushFps({ tMs: 1000, fps: 60, windowMs: 1000 });
    recorder.pushMemory({ tMs: 2000, footprintBytes: 400_000_000 });
    recorder.pushCapture({
      clipUri: 'file:///clip.mov',
      finalizedAtMs: 2500,
      completionStrategy: 'adaptive',
      telemetrySchemas: ['capture-completion-telemetry-v1'],
    });
    recorder.addNote('bench run');
    const doc = recorder.finalize();
    expect(doc.schemaVersion).toBe(DEVICE_BENCH_SCHEMA_VERSION);
    expect(doc.durationMs).toBe(2500);
    expect(doc.captures).toHaveLength(1);
    expect(validateDeviceBenchExport(doc)).toEqual([]);
  });

  it('refuses to finalize an unexplained empty series', () => {
    const recorder = new DeviceBenchRecorder(init);
    recorder.pushFps({ tMs: 1000, fps: 60, windowMs: 1000 });
    expect(() => recorder.finalize({ thermal: 'no thermal bridge' })).toThrow(
      /memory: empty series requires a nonempty unavailableReason/,
    );
  });

  it('finalizes when every empty series carries a reason', () => {
    const recorder = new DeviceBenchRecorder(init);
    const doc = recorder.finalize({
      thermal: 'no thermal bridge in this build',
      fps: 'camera never started',
      memory: 'memory polling not wired',
    });
    expect(doc.durationMs).toBe(0);
    expect(doc.thermal.unavailableReason).toBe(
      'no thermal bridge in this build',
    );
    expect(validateDeviceBenchExport(doc)).toEqual([]);
  });
});

describe('deviceBenchExportFilename', () => {
  it('produces a filesystem-safe name', () => {
    expect(deviceBenchExportFilename('2026-08-29T00:00:00.000Z')).toBe(
      'device-bench-2026-08-29T00-00-00-000Z.json',
    );
  });
});
