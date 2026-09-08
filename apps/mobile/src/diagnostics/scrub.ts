import type {
  ErrorEvent,
  Exception,
  SdkInfo,
  StackFrame,
} from '@sentry/react-native';
import {
  boundedItems,
  diagnosticsIdentity,
  diagnosticsRelease,
  minimizeDiagnosticEvent,
  record,
  type DiagnosticEnvelope,
  type DiagnosticsIdentity,
  type DiagnosticTransport,
} from './privacy';

export type DiagnosticDenyCategory =
  | 'path'
  | 'email'
  | 'token'
  | 'media'
  | 'network'
  | 'identifier'
  | 'unreadable';

interface DenyRule {
  readonly category: DiagnosticDenyCategory;
  readonly pattern: RegExp;
}

const MEDIA_EXTENSIONS =
  'mov|mp4|m4v|3gp|avi|mkv|webm|heic|heif|hif|jpe?g|png|gif|webp|tiff?|bmp|m4a|caf|wav|aac|mp3|aiff?';
const MEDIA_SCHEMES =
  'ph|assets-library|ipod-library|photos-redirect|content|asset|blob|rn-fs|itms-services';
const PATH_ROOTS =
  'Users|private|var|tmp|Library|Applications|System|usr|Containers|Volumes|Developer|Frameworks|data|storage|sdcard|mnt|home|root|etc|opt|dev|proc|bin|sbin|lib';
const UUID =
  '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}';
const TOKEN_SOURCE =
  `\\b(?:bearer|basic|digest)\\s+[A-Za-z0-9._~+/=-]{8,}` +
  `|\\beyJ[A-Za-z0-9_-]{4,}\\.[A-Za-z0-9_-]{4,}(?:\\.[A-Za-z0-9_-]*)?` +
  `|\\b(?:access_token|refresh_token|id_token|auth_token|token|api[_-]?key|apikey|client_secret|secret|password|passwd|pwd|authorization|session[_-]?id|signature|sig|code)=[^&\\s"'<>]+` +
  `|\\b(?:appl_|goog_|test_|strp_|[prs]k_(?:live|test)_|ghp_|gho_|github_pat_|xox[abprs]-|AIza|ya29\\.|sbp_|sk-)[A-Za-z0-9_.-]{8,}`;
const EMAIL_SOURCE =
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';
const NETWORK_SOURCE =
  '\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b|\\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\\b|\\b(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}\\b';
const MEDIA_FILE_SOURCE = `[\\w()\\-]+(?:\\.[\\w()\\-]+)*\\.(?:${MEDIA_EXTENSIONS})\\b`;

// Content that must never leave the device. The gate rules are checked against
// every string (and key) of a finished envelope; the text rules additionally
// consume whole tokens so free text on native events can be redacted.
const GATE_RULES: readonly DenyRule[] = [
  {
    category: 'path',
    pattern: new RegExp(
      `\\bfile:|~/|\\.{1,2}/|[A-Za-z]:\\\\|/(?:${PATH_ROOTS})/`,
    ),
  },
  { category: 'email', pattern: new RegExp(EMAIL_SOURCE) },
  { category: 'token', pattern: new RegExp(TOKEN_SOURCE, 'i') },
  {
    category: 'media',
    pattern: new RegExp(
      `\\b(?:${MEDIA_SCHEMES})://|\\b${UUID}/L0/\\d{3}\\b|\\bdata:[a-z]+/[a-z0-9.+-]+;base64,|${MEDIA_FILE_SOURCE}`,
      'i',
    ),
  },
  { category: 'network', pattern: new RegExp(NETWORK_SOURCE) },
];

const TEXT_RULES: readonly DenyRule[] = [
  {
    category: 'media',
    pattern: new RegExp(
      `\\b(?:${MEDIA_SCHEMES})://[^\\s"'<>]*|\\b${UUID}/L0/\\d{3}\\b|\\bdata:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*|${MEDIA_FILE_SOURCE}`,
      'gi',
    ),
  },
  {
    category: 'path',
    pattern: new RegExp(
      `\\bfile:[^\\s"'<>]*|(?:~|\\.{1,2})?/[^\\s"'<>]*|[A-Za-z]:\\\\[^\\s"'<>]*`,
      'g',
    ),
  },
  { category: 'email', pattern: new RegExp(EMAIL_SOURCE, 'g') },
  { category: 'token', pattern: new RegExp(TOKEN_SOURCE, 'gi') },
  { category: 'network', pattern: new RegExp(NETWORK_SOURCE, 'g') },
  {
    category: 'identifier',
    pattern: new RegExp(
      `\\b${UUID}\\b|\\b[0-9A-Fa-f]{32,}\\b|(?=[A-Za-z0-9+/]*[+/=])[A-Za-z0-9+/]{40,}={0,2}|(?:\\+\\d{1,3}[ .-]?)?\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}\\b`,
      'g',
    ),
  },
];

const REDACTED = '[redacted]';
const TEXT_LIMIT = 1024;
const SYMBOL = /^[\x20-\x7e]{1,512}$/;
const ADDRESS = /^0x[0-9a-f]{1,16}$/;
const BASENAME = /^[A-Za-z0-9_.+-]{1,64}$/;
const DEBUG_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const EVENT_ID = /^[a-f0-9]{32}$/;
const SDK_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,32})?$/;
const OS_VERSION = /^\d{1,3}(?:\.\d{1,3}){0,2}$/;
const OS_BUILD = /^[A-Za-z0-9]{1,16}$/;
const DEVICE_MODEL = /^[A-Za-z][A-Za-z0-9]{0,23}(?:,\d{1,3})?$/;
const MECHANISM_NAME = /^[A-Z][A-Z0-9_]{0,31}$/;
const EXCEPTION_TYPE = /^[A-Za-z_][A-Za-z0-9_.:]{0,63}$/;
const NATIVE_MECHANISMS: ReadonlySet<string> = new Set([
  'mach',
  'signal',
  'nsexception',
  'cpp_exception',
]);
const NATIVE_SDKS: ReadonlySet<string> = new Set([
  'sentry.cocoa',
  'sentry.cocoa.react-native',
]);
const OS_NAMES: ReadonlySet<string> = new Set([
  'iOS',
  'iPadOS',
  'macOS',
  'tvOS',
  'watchOS',
  'visionOS',
]);
const ARCHES: ReadonlySet<string> = new Set([
  'arm64',
  'arm64e',
  'arm64_32',
  'armv7',
  'armv7k',
  'x86_64',
  'i386',
]);
const BUILD_TYPES: ReadonlySet<string> = new Set([
  'app store',
  'test flight',
  'ad hoc',
  'enterprise',
  'debug',
  'simulator',
]);
const FRAME_LIMIT = 50;
const IMAGE_LIMIT = 50;
const EXCEPTION_LIMIT = 3;
const WALK_LIMIT = 10_000;

interface NativeStackFrame extends StackFrame {
  package?: string;
  image_addr?: string;
  symbol_addr?: string;
}

interface NativeMechanismMeta {
  signal?: { number?: number; code?: number; name?: string };
  mach_exception?: {
    exception?: number;
    code?: number;
    subcode?: number;
    name?: string;
  };
}

interface NativeException extends Exception {
  mechanism: NonNullable<Exception['mechanism']> & {
    meta?: NativeMechanismMeta;
  };
  stacktrace: { frames: NativeStackFrame[] };
}

interface NativeDebugImage {
  type: 'macho';
  debug_id: string;
  image_addr: string;
  image_size?: number;
  image_vmaddr?: string;
  code_file?: string;
  arch?: string;
}

function firstMatch(rules: readonly DenyRule[], text: string) {
  for (const rule of rules) if (rule.pattern.test(text)) return rule.category;
  return null;
}

export function scrubDiagnosticText(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) return null;
  let text = value;
  for (let pass = 0; pass < 8; pass += 1) {
    let changed = false;
    for (const rule of TEXT_RULES) {
      const next = text.replace(rule.pattern, REDACTED);
      if (next !== text) {
        text = next;
        changed = true;
      }
    }
    if (!changed) return text;
  }
  return REDACTED;
}

export function findDeniedDiagnosticContent(
  value: unknown,
): DiagnosticDenyCategory | null {
  const seen = new Set<object>();
  let visited = 0;
  const walk = (node: unknown): DiagnosticDenyCategory | null => {
    if (++visited > WALK_LIMIT) return 'unreadable';
    if (typeof node === 'string') return firstMatch(GATE_RULES, node);
    if (node === null || typeof node !== 'object') return null;
    if (seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item);
        if (found) return found;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const found =
        firstMatch(GATE_RULES, key) ??
        walk((node as Record<string, unknown>)[key]);
      if (found) return found;
    }
    return null;
  };
  try {
    return walk(value);
  } catch {
    return 'unreadable';
  }
}

function address(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 18) return null;
  const lower = value.toLowerCase();
  return ADDRESS.test(lower) ? lower : null;
}

function count(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : null;
}

function basename(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const name = value.replace(/\\/g, '/').split('/').pop() ?? '';
  return BASENAME.test(name) && firstMatch(GATE_RULES, name) === null
    ? name
    : null;
}

function symbol(value: unknown): string | null {
  const text = scrubDiagnosticText(value);
  if (text === null || text === REDACTED) return null;
  const trimmed = text.trim();
  if (!SYMBOL.test(trimmed) || trimmed.replace(/\[redacted\]/g, '') === '')
    return null;
  return trimmed;
}

function member(set: ReadonlySet<string>, value: unknown): string | null {
  return typeof value === 'string' && set.has(value) ? value : null;
}

function matching(pattern: RegExp, value: unknown): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function nativeFrames(value: unknown): NativeStackFrame[] {
  const clean: NativeStackFrame[] = [];
  for (const item of boundedItems(value, FRAME_LIMIT, true)) {
    const frame = record(item);
    if (!frame) continue;
    const instruction = address(frame.instruction_addr);
    if (!instruction) continue;
    const next: NativeStackFrame = { instruction_addr: instruction };
    const fn = symbol(frame.function);
    if (fn) next.function = fn;
    const pkg = basename(frame.package);
    if (pkg) next.package = pkg;
    const symbolAddress = address(frame.symbol_addr);
    if (symbolAddress) next.symbol_addr = symbolAddress;
    const imageAddress = address(frame.image_addr);
    if (imageAddress) next.image_addr = imageAddress;
    next.in_app = frame.in_app === true;
    clean.push(next);
  }
  return clean;
}

function nativeMeta(value: unknown): NativeMechanismMeta | null {
  const meta = record(value);
  if (!meta) return null;
  const clean: NativeMechanismMeta = {};
  const signal = record(meta.signal);
  if (signal) {
    const number = count(signal.number, 1024);
    const code = count(signal.code, 1_000_000);
    const name = matching(MECHANISM_NAME, signal.name);
    if (number !== null || code !== null || name !== null)
      clean.signal = {
        ...(number !== null ? { number } : {}),
        ...(code !== null ? { code } : {}),
        ...(name !== null ? { name } : {}),
      };
  }
  const mach = record(meta.mach_exception);
  if (mach) {
    const exception = count(mach.exception, 1024);
    const code = count(mach.code);
    const subcode = count(mach.subcode);
    const name = matching(MECHANISM_NAME, mach.name);
    if (
      exception !== null ||
      code !== null ||
      subcode !== null ||
      name !== null
    )
      clean.mach_exception = {
        ...(exception !== null ? { exception } : {}),
        ...(code !== null ? { code } : {}),
        ...(subcode !== null ? { subcode } : {}),
        ...(name !== null ? { name } : {}),
      };
  }
  return clean.signal || clean.mach_exception ? clean : null;
}

function nativeExceptions(value: unknown): NativeException[] {
  const clean: NativeException[] = [];
  for (const item of boundedItems(record(value)?.values, EXCEPTION_LIMIT)) {
    const exception = record(item);
    if (!exception) continue;
    const mechanism = record(exception.mechanism);
    const nativeMechanism = member(NATIVE_MECHANISMS, mechanism?.type);
    if (!mechanism || !nativeMechanism) continue;
    const frames = nativeFrames(record(exception.stacktrace)?.frames);
    if (frames.length === 0) continue;
    const next: NativeException = {
      type: matching(EXCEPTION_TYPE, exception.type) ?? 'Error',
      value: 'Error details removed',
      mechanism: {
        type: 'pickle.native_crash',
        handled: false,
        data: { native_mechanism: nativeMechanism },
      },
      stacktrace: { frames },
    };
    const threadId = count(exception.thread_id, 1_000_000);
    if (threadId !== null) next.thread_id = threadId;
    const meta = nativeMeta(mechanism.meta);
    if (meta) next.mechanism.meta = meta;
    clean.push(next);
  }
  return clean;
}

function referenced(
  image: { address: bigint; size: number | null },
  frames: readonly NativeStackFrame[],
): boolean {
  for (const frame of frames) {
    if (
      frame.image_addr !== undefined &&
      BigInt(frame.image_addr) === image.address
    )
      return true;
    if (image.size !== null) {
      const instruction = BigInt(frame.instruction_addr ?? '0x0');
      if (
        instruction >= image.address &&
        instruction < image.address + BigInt(image.size)
      )
        return true;
    }
  }
  return false;
}

function nativeImages(
  value: unknown,
  frames: readonly NativeStackFrame[],
): NativeDebugImage[] {
  const clean: NativeDebugImage[] = [];
  const images = record(value)?.images;
  if (!Array.isArray(images)) return clean;
  for (
    let index = 0;
    index < images.length && clean.length < IMAGE_LIMIT;
    index += 1
  ) {
    const image = record(images[index]);
    if (!image || image.type !== 'macho') continue;
    const imageAddress = address(image.image_addr);
    const debugId =
      typeof image.debug_id === 'string' && image.debug_id.length === 36
        ? image.debug_id.toLowerCase()
        : null;
    if (!imageAddress || !debugId || !DEBUG_ID.test(debugId)) continue;
    const size = count(image.image_size, 2 ** 40);
    if (!referenced({ address: BigInt(imageAddress), size }, frames)) continue;
    const next: NativeDebugImage = {
      type: 'macho',
      debug_id: debugId,
      image_addr: imageAddress,
    };
    if (size !== null) next.image_size = size;
    const vmAddress = address(image.image_vmaddr);
    if (vmAddress) next.image_vmaddr = vmAddress;
    const codeFile = basename(image.code_file);
    if (codeFile) next.code_file = codeFile;
    const arch = member(ARCHES, image.arch);
    if (arch) next.arch = arch;
    clean.push(next);
  }
  return clean;
}

function nativeContexts(value: unknown): ErrorEvent['contexts'] {
  const contexts = record(value);
  if (!contexts) return undefined;
  const clean: NonNullable<ErrorEvent['contexts']> = {};
  const app = record(contexts.app);
  if (app) {
    const buildType = member(BUILD_TYPES, app.build_type);
    const next: Record<string, unknown> = {
      ...(buildType ? { build_type: buildType } : {}),
      ...(typeof app.in_foreground === 'boolean'
        ? { in_foreground: app.in_foreground }
        : {}),
    };
    if (Object.keys(next).length) clean.app = next;
  }
  const device = record(contexts.device);
  if (device) {
    const model = matching(DEVICE_MODEL, device.model);
    const modelId = matching(OS_BUILD, device.model_id);
    const arch = member(ARCHES, device.arch);
    const memorySize = count(device.memory_size);
    const freeMemory = count(device.free_memory);
    const usableMemory = count(device.usable_memory);
    const next: Record<string, unknown> = {
      ...(device.family === 'iOS' ? { family: 'iOS' } : {}),
      ...(model ? { model } : {}),
      ...(modelId ? { model_id: modelId } : {}),
      ...(arch ? { arch } : {}),
      ...(typeof device.simulator === 'boolean'
        ? { simulator: device.simulator }
        : {}),
      ...(memorySize !== null ? { memory_size: memorySize } : {}),
      ...(freeMemory !== null ? { free_memory: freeMemory } : {}),
      ...(usableMemory !== null ? { usable_memory: usableMemory } : {}),
      ...(typeof device.low_memory === 'boolean'
        ? { low_memory: device.low_memory }
        : {}),
    };
    if (Object.keys(next).length) clean.device = next;
  }
  const os = record(contexts.os);
  if (os) {
    const name = member(OS_NAMES, os.name);
    const version = matching(OS_VERSION, os.version);
    const build = matching(OS_BUILD, os.build);
    const next: Record<string, unknown> = {
      ...(name ? { name } : {}),
      ...(version ? { version } : {}),
      ...(build ? { build } : {}),
    };
    if (Object.keys(next).length) clean.os = next;
  }
  return Object.keys(clean).length ? clean : undefined;
}

function nativeSdk(value: unknown): SdkInfo {
  const sdk = record(value);
  const version = matching(SDK_VERSION, sdk?.version);
  return {
    name: member(NATIVE_SDKS, sdk?.name) ?? 'sentry.cocoa',
    ...(version ? { version } : {}),
    settings: { infer_ip: 'never' },
  };
}

function timestamp(value: unknown): number | null {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.length <= 40
        ? Date.parse(value) / 1000
        : Number.NaN;
  return Number.isFinite(seconds) && seconds >= 0 && seconds < 100_000_000_000
    ? seconds
    : null;
}

export function minimizeNativeDiagnosticEvent(
  input: unknown,
  identity: DiagnosticsIdentity,
): ErrorEvent | null {
  try {
    const releaseIdentity = diagnosticsIdentity(identity);
    const event = record(input);
    if (!event || !releaseIdentity) return null;
    const { type, platform, level, exception, event_id, debug_meta } = event;
    if (
      type !== undefined ||
      platform !== 'cocoa' ||
      (level !== 'error' && level !== 'fatal')
    )
      return null;
    const exceptions = nativeExceptions(exception);
    if (exceptions.length === 0) return null;
    const frames = exceptions.flatMap(item => item.stacktrace.frames);
    const clean: ErrorEvent = {
      type: undefined,
      platform: 'cocoa',
      level,
      release: diagnosticsRelease(releaseIdentity),
      dist: releaseIdentity.nativeBuildNumber,
      environment: releaseIdentity.environment,
      tags: {
        diagnostic_origin: 'native_crash',
        source_revision: releaseIdentity.sourceRevision,
        model_version: releaseIdentity.modelVersion,
        policy_version: releaseIdentity.policyVersion,
      },
      sdk: nativeSdk(event.sdk),
      exception: { values: exceptions },
    };
    if (typeof event_id === 'string' && EVENT_ID.test(event_id))
      clean.event_id = event_id;
    const seconds = timestamp(event.timestamp);
    if (seconds !== null) clean.timestamp = seconds;
    const contexts = nativeContexts(event.contexts);
    if (contexts) clean.contexts = contexts;
    const images = nativeImages(debug_meta, frames);
    if (images.length) clean.debug_meta = { images };
    return clean;
  } catch {
    return null;
  }
}

export function scrubDiagnosticEvent(
  input: unknown,
  identity: DiagnosticsIdentity,
): ErrorEvent | null {
  try {
    const platform = record(input)?.platform;
    const clean =
      platform === 'cocoa'
        ? minimizeNativeDiagnosticEvent(input, identity)
        : platform === 'javascript'
          ? minimizeDiagnosticEvent(input, identity)
          : null;
    return clean && findDeniedDiagnosticContent(clean) === null ? clean : null;
  } catch {
    return null;
  }
}

export function scrubDiagnosticEnvelope(
  input: unknown,
  identity: DiagnosticsIdentity,
): DiagnosticEnvelope | null {
  try {
    if (!Array.isArray(input) || input.length !== 2) return null;
    for (const item of boundedItems(input[1], 20)) {
      if (!Array.isArray(item) || record(item[0])?.type !== 'event') continue;
      const event = scrubDiagnosticEvent(item[1], identity);
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

export function createScrubbedTransport(
  sink: DiagnosticTransport,
  identity: DiagnosticsIdentity,
): DiagnosticTransport {
  const releaseIdentity = diagnosticsIdentity(identity);
  return {
    async send(envelope) {
      try {
        const clean =
          releaseIdentity && scrubDiagnosticEnvelope(envelope, releaseIdentity);
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
