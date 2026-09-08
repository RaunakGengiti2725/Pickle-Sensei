/**
 * INT-security-privacy adversary — analytics redaction guard.
 *
 * `packages/analytics` documents its guard as refusing "raw media references,
 * filesystem/object-store paths, contact details, blob payloads, oversized
 * free-form values, and forbidden field names", and its buffer as something
 * that "must never crash the app" with bounded re-buffering on failed
 * delivery. Each attack below feeds the guard an event a real client could
 * plausibly emit (the `AnalyticsEvent` union is widened through `unknown`,
 * exactly as an untyped call site or a JSON round trip would) and asserts the
 * documented promise.
 *
 * Note: the shipping iOS app (`apps/mobile/src`) and the production Edge
 * Function do not import this package; its consumers are the legacy
 * `services/api` and `services/media-worker` (rg '@pickle/analytics'). Findings
 * here are scoped accordingly.
 *
 * Blocks: "documented denials" pins the rules the module lists (a failure
 * there is a broken documented rule); "coverage gap" probes shapes the header
 * promise covers but no rule names (a failure is a gap, not a broken rule);
 * "hostile structure" and "retention" pin the never-crash / bounded-buffer
 * promises.
 *
 *   cd apps/mobile && npx jest --ci --runInBand __tests__/adv/analyticsRedactionGuard.attack.test.ts
 */
import {
  BufferedAnalytics,
  findPrivacyViolations,
  MAX_ANALYTICS_ARRAY_LENGTH,
  MAX_ANALYTICS_STRING_LENGTH,
  type AnalyticsEvent,
  type PrivacyViolation,
} from '../../../../packages/analytics/src/index';

const at = '2026-09-08T12:00:00.000Z';
const MARKER = 'ADV_ANALYTICS_MARKER';

function event(extra: Record<string, unknown>): AnalyticsEvent {
  return {
    name: 'analysis_failed',
    at,
    failureKind: 'pose_extraction_error',
    ...extra,
  } as AnalyticsEvent;
}

function rules(violations: PrivacyViolation[]): string[] {
  return violations.map(violation => violation.rule).sort();
}

describe('INT-security-privacy: analytics redaction guard', () => {
  describe('documented denials still hold under variation', () => {
    it.each([
      ['iOS photo library uri', `ph://${MARKER}/L0/001`],
      ['upper-case file scheme', `FILE:///var/mobile/${MARKER}/clip.mov`],
      ['assets-library uri', `assets-library://asset/asset.MOV?id=${MARKER}`],
      ['content uri', `content://media/external/video/${MARKER}`],
      ['s3 object uri', `s3://pickle-media/${MARKER}.mov`],
      ['blob uri', `blob:https://app/${MARKER}`],
      ['data uri', 'data:image/jpeg;base64,/9j/4AAQ'],
      [
        'absolute container path',
        `/var/mobile/Containers/Data/Application/${MARKER}/Documents/clip.mov`,
      ],
      ['absolute private path', `/private/var/mobile/${MARKER}`],
      ['quoted absolute path', `path="/var/mobile/${MARKER}"`],
      ['email', `${MARKER.toLowerCase()}@example.com`],
      ['email with subdomain and plus', 'coach+pickle@mail.example.co.uk'],
      ['long base64 run', 'A'.repeat(120)],
      ['oversized string', 'x'.repeat(MAX_ANALYTICS_STRING_LENGTH + 1)],
    ])('%s is refused when carried in a string field', (_title, value) => {
      expect(
        findPrivacyViolations(event({ failureKind: value })).length,
      ).toBeGreaterThan(0);
    });

    it.each([
      'uri',
      'URL',
      'Path',
      'filePath',
      'fileUri',
      'objectKey',
      'masterKey',
      'email',
      'phone',
      'address',
      'deviceId',
      'IDFA',
      'aaid',
      'serial',
      'stack',
      'stackTrace',
      'rawFrame',
      'imageData',
      'videoData',
      'poseFrames',
    ])('forbidden key %s is refused even with an innocuous value', key => {
      expect(rules(findPrivacyViolations(event({ [key]: 'label' })))).toContain(
        'forbidden_key',
      );
    });

    it('oversized arrays and nested violations are located by path', () => {
      const violations = findPrivacyViolations(
        event({
          failedDimensions: Array.from(
            { length: MAX_ANALYTICS_ARRAY_LENGTH + 1 },
            () => 'brightness',
          ),
          nested: { deeper: [{ email: 'x' }] },
        }),
      );
      expect(rules(violations)).toEqual(['forbidden_key', 'oversized_array']);
      expect(violations.map(violation => violation.path)).toEqual([
        'failedDimensions',
        'nested.deeper[0].email',
      ]);
    });
  });

  describe('coverage gap: media, path, contact and token shapes a client could plausibly emit', () => {
    it.each([
      ['snake_case device identifier key', { device_id: 'label' }],
      ['snake_case file path key', { file_path: 'label' }],
      ['snake_case email key', { user_email: 'label' }],
      ['identifier-for-vendor key', { idfv: 'label' }],
      ['camelCase mediaUri key', { mediaUri: 'label' }],
      ['videoUri key', { videoUri: 'label' }],
      ['ipAddress key', { ipAddress: 'label' }],
    ])('%s is refused as a forbidden field name', (_title, extra) => {
      expect(rules(findPrivacyViolations(event(extra)))).toContain(
        'forbidden_key',
      );
    });

    it.each([
      ['media filename without scheme', `IMG_${MARKER}.MOV`],
      ['relative container path', `Documents/${MARKER}/clip.mov`],
      ['relative library cache path', `Library/Caches/${MARKER}.mp4`],
      ['absolute path after a colon', `path:/var/mobile/${MARKER}/clip.mov`],
      ['absolute path after a comma', `a,/var/mobile/${MARKER}/clip.mov`],
      ['absolute path in a non-listed root', `/Volumes/${MARKER}/clip.mov`],
      [
        'https presigned object url',
        `https://pickle-media.s3.amazonaws.com/${MARKER}.mov?X-Amz-Signature=abc`,
      ],
      ['rn-fs media uri', `rn-fs://${MARKER}/clip.mov`],
      ['asset media uri', `asset://${MARKER}/clip.mov`],
      ['phone number', '+1 (415) 555-0123'],
      ['bearer token', `Bearer ${MARKER}`],
      ['jwt', `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIke${MARKER}In0.sig`],
      ['supabase secret key prefix', `sb_secret_${MARKER}`],
      ['ipv4 address', '203.0.113.77'],
      ['fullwidth-at email', `${MARKER.toLowerCase()}＠example.com`],
      [
        'short base64 image chunk',
        `/9j/4AAQSkZJRgABAQAAAQABAAD${'A'.repeat(60)}`,
      ],
    ])('%s is refused when carried in a string field', (_title, value) => {
      expect(
        findPrivacyViolations(event({ failureKind: value })).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('attack: hostile structure must not crash the caller or bypass the guard', () => {
    it('a cyclic event does not hang or throw; it is refused or bounded', () => {
      const cyclic: Record<string, unknown> = {
        name: 'analysis_failed',
        at,
        failureKind: 'pose_extraction_error',
      };
      cyclic.self = cyclic;
      const sink = new BufferedAnalytics(async () => undefined, 10);
      expect(() => sink.track(event(cyclic))).not.toThrow();
      expect(sink.pendingCount()).toBeLessThanOrEqual(1);
    });

    it('a deeply nested event does not overflow the stack', () => {
      let nested: unknown = 'leaf';
      for (let depth = 0; depth < 50_000; depth += 1) nested = [nested];
      const sink = new BufferedAnalytics(async () => undefined, 10);
      expect(() => sink.track(event({ nested }))).not.toThrow();
    });

    it('a throwing getter cannot escape track()', () => {
      const hostile = event({});
      Object.defineProperty(hostile, 'failureKind', {
        enumerable: true,
        get() {
          throw new Error(MARKER);
        },
      });
      const sink = new BufferedAnalytics(async () => undefined, 10);
      expect(() => sink.track(hostile)).not.toThrow();
      expect(sink.pendingCount()).toBe(0);
    });

    it('violations reported through onViolation never carry the offending value', () => {
      const reported: Array<[string, PrivacyViolation[]]> = [];
      const sink = new BufferedAnalytics(
        async () => undefined,
        10,
        (name, violations) => reported.push([name, violations]),
      );
      sink.track(event({ failureKind: `${MARKER.toLowerCase()}@example.com` }));
      expect(reported).toHaveLength(1);
      expect(JSON.stringify(reported)).not.toContain(MARKER.toLowerCase());
      expect(sink.droppedViolationCount()).toBe(1);
      expect(sink.pendingCount()).toBe(0);
    });
  });

  describe('attack: retention stays bounded when delivery keeps failing', () => {
    it('keeps at most a bounded number of events in memory under permanent transport failure', async () => {
      const attempts: number[] = [];
      const sink = new BufferedAnalytics(async batch => {
        attempts.push(batch.length);
        throw new Error('network loss');
      }, 5);
      // A device offline for a while keeps emitting; every 5th track() starts a
      // flush that fails asynchronously and re-buffers its batch.
      for (let index = 0; index < 1_000; index += 1) {
        sink.track(event({ latencyMs: index }));
      }
      await sink.flush();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(attempts.length).toBeGreaterThan(0);
      // maxBuffer is 5; "bounded" re-buffering can hold at most one failed batch
      // plus one in-flight batch.
      expect(sink.pendingCount()).toBeLessThanOrEqual(10);
    });

    it('a rejecting transport never propagates out of track() or flush()', async () => {
      const sink = new BufferedAnalytics(async () => {
        throw new Error(MARKER);
      }, 1);
      expect(() => sink.track(event({}))).not.toThrow();
      await expect(sink.flush()).resolves.toBeUndefined();
    });
  });
});
