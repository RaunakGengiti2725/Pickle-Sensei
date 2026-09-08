import type {
  ErrorEvent,
  ReactNativeOptions,
  StackFrame,
} from '@sentry/react-native';

export type DiagnosticTransportFactory = NonNullable<
  ReactNativeOptions['transport']
>;
export type DiagnosticTransport = ReturnType<DiagnosticTransportFactory>;
export type DiagnosticEnvelope = Parameters<DiagnosticTransport['send']>[0];
export type DiagnosticOrigin = 'global_js' | 'react_boundary' | 'handled_js';

export interface DiagnosticsIdentity {
  readonly bundleIdentifier: 'com.picklesensei';
  readonly marketingVersion: string;
  readonly nativeBuildNumber: string;
  readonly sourceRevision: string;
  readonly environment: 'development' | 'test' | 'production';
  readonly modelVersion: string;
  readonly policyVersion: string;
}

const ERROR_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'URIError',
  'EvalError',
  'AggregateError',
]);
const BUNDLE_NAMES = new Set([
  'main.jsbundle',
  'index.bundle',
  'index.ios.bundle',
  'index.android.bundle',
]);
const EVENT_ID = /^[a-f0-9]{32}$/;
const DEBUG_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function diagnosticsIdentity(
  input: unknown,
): DiagnosticsIdentity | null {
  try {
    const value = record(input);
    if (!value) return null;
    const {
      bundleIdentifier,
      marketingVersion,
      nativeBuildNumber,
      sourceRevision,
      environment,
      modelVersion,
      policyVersion,
    } = value;
    if (
      bundleIdentifier !== 'com.picklesensei' ||
      typeof marketingVersion !== 'string' ||
      !/^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(marketingVersion) ||
      typeof nativeBuildNumber !== 'string' ||
      !/^\d{1,8}(?:\.\d{1,4}){0,2}$/.test(nativeBuildNumber) ||
      typeof sourceRevision !== 'string' ||
      !/^[a-f0-9]{40}$/.test(sourceRevision) ||
      (environment !== 'development' &&
        environment !== 'test' &&
        environment !== 'production') ||
      typeof modelVersion !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(modelVersion) ||
      typeof policyVersion !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(policyVersion)
    )
      return null;
    return Object.freeze({
      bundleIdentifier,
      marketingVersion,
      nativeBuildNumber,
      sourceRevision,
      environment,
      modelVersion,
      policyVersion,
    });
  } catch {
    return null;
  }
}

function bundleFilename(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const filename = value.split(/[?#]/)[0]?.replace(/\\/g, '/').split('/').pop();
  return filename && BUNDLE_NAMES.has(filename) ? `app:///${filename}` : null;
}

function coordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 100_000_000
  );
}

export function boundedItems(
  value: unknown,
  limit: number,
  fromEnd = false,
): unknown[] {
  if (!Array.isArray(value)) return [];
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0) return [];
  const start = fromEnd ? Math.max(0, length - limit) : 0;
  const end = fromEnd ? length : Math.min(length, limit);
  const items: unknown[] = [];
  for (let index = start; index < end; index += 1) items.push(value[index]);
  return items;
}

function frames(value: unknown): StackFrame[] {
  const clean: StackFrame[] = [];
  for (const item of boundedItems(value, 50, true)) {
    const frame = record(item);
    if (!frame) continue;
    const filename = bundleFilename(frame.filename);
    const { lineno, colno } = frame;
    if (!filename || !coordinate(lineno) || lineno < 1 || !coordinate(colno))
      continue;
    clean.push({ filename, lineno, colno, in_app: true });
  }
  return clean;
}

export function diagnosticErrorType(value: unknown): string {
  return typeof value === 'string' && ERROR_TYPES.has(value) ? value : 'Error';
}

function origin(value: unknown): DiagnosticOrigin {
  return value === 'global_js' || value === 'react_boundary'
    ? value
    : 'handled_js';
}

export function diagnosticsRelease(identity: DiagnosticsIdentity): string {
  return `${identity.bundleIdentifier}@${identity.marketingVersion}+${identity.nativeBuildNumber}`;
}

export function minimizeDiagnosticEvent(
  input: unknown,
  identity: DiagnosticsIdentity,
): ErrorEvent | null {
  try {
    const releaseIdentity = diagnosticsIdentity(identity);
    const event = record(input);
    if (!event || !releaseIdentity) return null;
    const {
      type,
      platform,
      level,
      exception,
      tags,
      event_id,
      timestamp,
      debug_meta,
    } = event;
    if (
      type !== undefined ||
      platform !== 'javascript' ||
      (level !== 'error' && level !== 'fatal')
    )
      return null;
    const values = boundedItems(record(exception)?.values, 3);
    if (values.length === 0) return null;
    const diagnosticOrigin = origin(record(tags)?.diagnostic_origin);
    const exceptions: NonNullable<ErrorEvent['exception']>['values'] = [];
    for (const item of values) {
      const exceptionValue = record(item);
      if (!exceptionValue) continue;
      const cleanFrames = frames(record(exceptionValue.stacktrace)?.frames);
      exceptions.push({
        type: diagnosticErrorType(exceptionValue.type),
        value: 'Error details removed',
        mechanism: {
          type: `pickle.${diagnosticOrigin}`,
          handled: diagnosticOrigin !== 'global_js',
        },
        ...(cleanFrames.length ? { stacktrace: { frames: cleanFrames } } : {}),
      });
    }
    if (exceptions.length === 0) return null;
    const clean: ErrorEvent = {
      type: undefined,
      platform: 'javascript',
      level,
      release: diagnosticsRelease(releaseIdentity),
      dist: releaseIdentity.nativeBuildNumber,
      environment: releaseIdentity.environment,
      tags: {
        diagnostic_origin: diagnosticOrigin,
        source_revision: releaseIdentity.sourceRevision,
        model_version: releaseIdentity.modelVersion,
        policy_version: releaseIdentity.policyVersion,
      },
      sdk: {
        name: 'sentry.javascript.react-native',
        version: '8.24.0',
        settings: { infer_ip: 'never' },
      },
      exception: { values: exceptions },
    };
    if (typeof event_id === 'string' && EVENT_ID.test(event_id))
      clean.event_id = event_id;
    if (
      typeof timestamp === 'number' &&
      Number.isFinite(timestamp) &&
      timestamp >= 0 &&
      timestamp < 100_000_000_000
    )
      clean.timestamp = timestamp;
    const images = boundedItems(record(debug_meta)?.images, 4);
    if (images.length) {
      const cleanImages: NonNullable<
        NonNullable<ErrorEvent['debug_meta']>['images']
      > = [];
      for (const item of images) {
        const image = record(item);
        if (!image) continue;
        const codeFile = bundleFilename(image.code_file);
        const { type: imageType, debug_id } = image;
        if (
          imageType !== 'sourcemap' ||
          !codeFile ||
          typeof debug_id !== 'string' ||
          !DEBUG_ID.test(debug_id)
        )
          continue;
        cleanImages.push({ type: 'sourcemap', code_file: codeFile, debug_id });
      }
      if (cleanImages.length) clean.debug_meta = { images: cleanImages };
    }
    return clean;
  } catch {
    return null;
  }
}

export function minimizeDiagnosticEnvelope(
  input: unknown,
  identity: DiagnosticsIdentity,
): DiagnosticEnvelope | null {
  try {
    if (!Array.isArray(input) || input.length !== 2) return null;
    for (const item of boundedItems(input[1], 20)) {
      if (!Array.isArray(item) || record(item[0])?.type !== 'event') continue;
      const event = minimizeDiagnosticEvent(item[1], identity);
      if (!event?.event_id || event.timestamp === undefined) continue;
      return [
        {
          event_id: event.event_id,
          sent_at: new Date(event.timestamp * 1000).toISOString(),
        },
        [[{ type: 'event' }, event]],
      ];
    }
    return null;
  } catch {
    return null;
  }
}

export function createFilteredTransport(
  sink: DiagnosticTransport,
  identity: DiagnosticsIdentity,
): DiagnosticTransport {
  const releaseIdentity = diagnosticsIdentity(identity);
  return {
    async send(envelope) {
      try {
        const clean =
          releaseIdentity &&
          minimizeDiagnosticEnvelope(envelope, releaseIdentity);
        return clean ? await sink.send(clean) : {};
      } catch {
        return {};
      }
    },
    async flush(timeout) {
      try {
        return await sink.flush(timeout);
      } catch {
        return false;
      }
    },
  };
}
