export type XYZ = Readonly<{ x: number; y: number; z: number }>;

export type Frame3D = Readonly<{
  timestampMs: number;
  joints: readonly (XYZ & { readonly name: string })[];
}>;

export interface Estimated3DSequence {
  readonly kind: 'estimated-3d';
  readonly units: 'm' | 'cm' | 'mm';
  readonly jointSchema: string;
  readonly coordinateFrame: {
    readonly id: string;
    readonly origin: string;
    readonly axes: 'right-handed-x-right-y-up-z-toward-viewer';
    readonly view: 'front' | 'side' | 'rear' | 'oblique';
    readonly mirrored: false;
  };
  readonly provenance: {
    readonly source: 'recorded-3d-estimate' | 'software-only-fixture';
    readonly sourceId: string;
    readonly description: string;
    readonly estimator: string;
    readonly recordedAtIso: string;
    readonly timebaseId: string;
    readonly timestampUnit: 'ms';
  };
  readonly frames: readonly Frame3D[];
}

export interface Reference3DReview {
  readonly referenceSourceId: string;
  readonly reviewId: string;
  readonly coachName: string;
  readonly reviewedAtIso: string;
  readonly scope: string;
}

export type Reference3DSequence = Estimated3DSequence & {
  readonly coachReview?: Reference3DReview;
};

export interface Comparison3DInterval {
  readonly startMs: number;
  readonly endMs: number;
  readonly userTimestampMs: number | null;
  readonly referenceTimestampMs: number | null;
}

export type Projection3D = Readonly<{ center: XYZ; radius: number }>;
export type Orientation3D = Readonly<{
  yawDegrees: number;
  pitchDegrees: number;
}>;
export type Bone3D = readonly [string, string];

export interface Comparison3DInput {
  readonly user: Estimated3DSequence;
  readonly reference: Reference3DSequence;
  readonly bones: readonly Bone3D[];
  readonly projection: Projection3D;
  readonly alignment: {
    readonly method: 'caller-supplied';
    readonly provenance: string;
    readonly spatialProvenance: string;
    readonly durationMs: number;
    readonly intervals: readonly Comparison3DInterval[];
  };
}

export type Comparison3DUnavailableReason =
  | 'missing-evidence'
  | 'invalid-evidence'
  | 'incompatible-source'
  | 'incompatible-units'
  | 'incompatible-frame'
  | 'invalid-reference-review'
  | 'invalid-alignment'
  | 'invalid-bones'
  | 'invalid-projection'
  | 'no-paired-samples';

export interface Prepared3DComparison {
  readonly status: 'ready';
  readonly input: Comparison3DInput;
  readonly referenceLabel:
    'Illustrative reference' | 'Coach-reviewed reference';
  readonly userFrames: ReadonlyMap<number, Frame3D>;
  readonly referenceFrames: ReadonlyMap<number, Frame3D>;
}

export type Comparison3DModel =
  | Prepared3DComparison
  | {
      readonly status: 'unavailable';
      readonly reason: Comparison3DUnavailableReason;
      readonly message: string;
    };

export type Comparison3DSample =
  | { status: 'paired'; user: Frame3D; reference: Frame3D }
  | { status: 'gap'; user: null; reference: null };

export type Projected3DPoint = Readonly<{
  x: number;
  y: number;
  depth: number;
}>;

export type Projected3DPrimitive =
  | { kind: 'joint'; id: string; point: Projected3DPoint; depth: number }
  | {
      kind: 'bone';
      id: string;
      from: Projected3DPoint;
      to: Projected3DPoint;
      depth: number;
    };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function xyz(value: unknown): value is XYZ {
  return (
    record(value) &&
    ['x', 'y', 'z'].every(
      key =>
        Object.prototype.hasOwnProperty.call(value, key) && finite(value[key]),
    )
  );
}

function sequence(value: unknown): value is Estimated3DSequence {
  if (
    !record(value) ||
    value.kind !== 'estimated-3d' ||
    !(value.units === 'm' || value.units === 'cm' || value.units === 'mm') ||
    !text(value.jointSchema) ||
    !record(value.coordinateFrame) ||
    !record(value.provenance) ||
    !Array.isArray(value.frames) ||
    value.frames.length === 0
  )
    return false;
  const frame = value.coordinateFrame;
  const source = value.provenance;
  if (
    !text(frame.id) ||
    !text(frame.origin) ||
    frame.axes !== 'right-handed-x-right-y-up-z-toward-viewer' ||
    !(
      frame.view === 'front' ||
      frame.view === 'side' ||
      frame.view === 'rear' ||
      frame.view === 'oblique'
    ) ||
    frame.mirrored !== false ||
    !(
      source.source === 'recorded-3d-estimate' ||
      source.source === 'software-only-fixture'
    ) ||
    !text(source.sourceId) ||
    !text(source.description) ||
    !text(source.estimator) ||
    !isoTimestamp(source.recordedAtIso) ||
    !text(source.timebaseId) ||
    source.timestampUnit !== 'ms'
  )
    return false;
  let previous = -1;
  let jointCount = 0;
  for (const sample of value.frames) {
    if (
      !record(sample) ||
      !finite(sample.timestampMs) ||
      sample.timestampMs < 0 ||
      sample.timestampMs <= previous ||
      !Array.isArray(sample.joints)
    )
      return false;
    previous = sample.timestampMs;
    const names = new Set<string>();
    for (const joint of sample.joints) {
      if (!record(joint) || !text(joint.name) || names.has(joint.name))
        return false;
      names.add(joint.name);
      if (!xyz(joint)) return false;
      jointCount += 1;
    }
  }
  return jointCount > 0;
}

function reviewMatches(
  value: unknown,
  reference: Estimated3DSequence,
): boolean {
  return (
    record(value) &&
    value.referenceSourceId === reference.provenance.sourceId &&
    text(value.reviewId) &&
    text(value.coachName) &&
    text(value.scope) &&
    isoTimestamp(value.reviewedAtIso)
  );
}

function alignment(value: unknown): value is Comparison3DInput['alignment'] {
  if (
    !record(value) ||
    value.method !== 'caller-supplied' ||
    !text(value.provenance) ||
    !text(value.spatialProvenance) ||
    !finite(value.durationMs) ||
    value.durationMs <= 0 ||
    !Array.isArray(value.intervals) ||
    value.intervals.length === 0
  )
    return false;
  let previousEnd = 0;
  let previousUser = -1;
  let previousReference = -1;
  for (const interval of value.intervals) {
    if (
      !record(interval) ||
      !finite(interval.startMs) ||
      !finite(interval.endMs) ||
      interval.startMs < previousEnd ||
      interval.endMs <= interval.startMs ||
      interval.endMs > value.durationMs ||
      !(
        interval.userTimestampMs === null ||
        (finite(interval.userTimestampMs) && interval.userTimestampMs >= 0)
      ) ||
      !(
        interval.referenceTimestampMs === null ||
        (finite(interval.referenceTimestampMs) &&
          interval.referenceTimestampMs >= 0)
      )
    )
      return false;
    if (interval.userTimestampMs !== null) {
      if (interval.userTimestampMs < previousUser) return false;
      previousUser = interval.userTimestampMs;
    }
    if (interval.referenceTimestampMs !== null) {
      if (interval.referenceTimestampMs < previousReference) return false;
      previousReference = interval.referenceTimestampMs;
    }
    previousEnd = interval.endMs;
  }
  return true;
}

function bones(value: unknown): value is readonly Bone3D[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set<string>();
  for (const bone of value) {
    if (
      !Array.isArray(bone) ||
      bone.length !== 2 ||
      !text(bone[0]) ||
      !text(bone[1]) ||
      bone[0] === bone[1]
    )
      return false;
    const key = JSON.stringify([...bone].sort());
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function projection(value: unknown): value is Projection3D {
  return (
    record(value) &&
    xyz(value.center) &&
    finite(value.radius) &&
    value.radius > 0
  );
}

function canPair(
  user: Frame3D | undefined,
  reference: Frame3D | undefined,
): boolean {
  if (!user || !reference) return false;
  const names = new Set(user.joints.map(joint => joint.name));
  return reference.joints.some(joint => names.has(joint.name));
}

function unavailable(
  reason: Comparison3DUnavailableReason,
  message: string,
): Comparison3DModel {
  return { status: 'unavailable', reason, message };
}

export function prepare3DComparison(value: unknown): Comparison3DModel {
  if (!record(value) || value.user == null || value.reference == null) {
    return unavailable(
      'missing-evidence',
      'Supply an explicit XYZ estimate and a reference with provenance. Existing 2D poses cannot supply depth.',
    );
  }
  if (!sequence(value.user) || !sequence(value.reference)) {
    return unavailable(
      'invalid-evidence',
      'Both sources need finite estimated XYZ, original timestamps, known units, unmirrored axes and complete provenance.',
    );
  }
  const { user, reference } = value;
  if (user.provenance.source !== reference.provenance.source) {
    return unavailable(
      'incompatible-source',
      'Software-only fixtures cannot be compared with a recording.',
    );
  }
  if (user.units !== reference.units) {
    return unavailable(
      'incompatible-units',
      'The supplied units differ. No unit conversion is inferred.',
    );
  }
  if (
    user.jointSchema !== reference.jointSchema ||
    user.coordinateFrame.id !== reference.coordinateFrame.id ||
    user.coordinateFrame.origin !== reference.coordinateFrame.origin ||
    user.coordinateFrame.view !== reference.coordinateFrame.view
  ) {
    return unavailable(
      'incompatible-frame',
      'The sources do not share a declared coordinate frame, origin, view and joint schema. No body fitting or mirroring is inferred.',
    );
  }
  const review = (reference as Reference3DSequence).coachReview;
  if (review !== undefined && !reviewMatches(review, reference)) {
    return unavailable(
      'invalid-reference-review',
      'The supplied coach review is incomplete or belongs to a different reference.',
    );
  }
  if (!alignment(value.alignment)) {
    return unavailable(
      'invalid-alignment',
      'Supply ordered, non-overlapping playback intervals with exact original timestamps and spatial/time alignment provenance.',
    );
  }
  if (!bones(value.bones)) {
    return unavailable(
      'invalid-bones',
      'Supply distinct joint connections. No body template is generated.',
    );
  }
  if (!projection(value.projection)) {
    return unavailable(
      'invalid-projection',
      'Supply one finite view center and positive radius in the shared units.',
    );
  }
  const volume = value.projection;
  for (const source of [user, reference]) {
    for (const frame of source.frames) {
      for (const joint of frame.joints) {
        if (!projectXYZ(joint, volume, { yawDegrees: 0, pitchDegrees: 0 })) {
          return unavailable(
            'invalid-projection',
            'The shared view bounds do not contain both sources. No independent resizing or recentering is applied.',
          );
        }
      }
    }
  }
  const userFrames = new Map(
    user.frames.map(frame => [frame.timestampMs, frame]),
  );
  const referenceFrames = new Map(
    reference.frames.map(frame => [frame.timestampMs, frame]),
  );
  if (
    !value.alignment.intervals.some(
      interval =>
        interval.userTimestampMs !== null &&
        interval.referenceTimestampMs !== null &&
        canPair(
          userFrames.get(interval.userTimestampMs),
          referenceFrames.get(interval.referenceTimestampMs),
        ),
    )
  ) {
    return unavailable(
      'no-paired-samples',
      'No supplied interval has an exact recorded pair with shared observed joints.',
    );
  }
  return {
    status: 'ready',
    input: value as unknown as Comparison3DInput,
    referenceLabel:
      review && reference.provenance.source === 'recorded-3d-estimate'
        ? 'Coach-reviewed reference'
        : 'Illustrative reference',
    userFrames,
    referenceFrames,
  };
}

export function sample3DComparison(
  model: Prepared3DComparison,
  timeMs: number,
): Comparison3DSample {
  const gap: Comparison3DSample = {
    status: 'gap',
    user: null,
    reference: null,
  };
  const { intervals, durationMs } = model.input.alignment;
  if (!finite(timeMs) || timeMs < 0 || timeMs > durationMs) return gap;
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (intervals[mid]!.startMs <= timeMs) low = mid + 1;
    else high = mid;
  }
  const interval = intervals[low - 1];
  if (
    !interval ||
    (timeMs >= interval.endMs &&
      !(timeMs === durationMs && interval.endMs === durationMs))
  )
    return gap;
  if (
    interval.userTimestampMs === null ||
    interval.referenceTimestampMs === null
  )
    return gap;
  const user = model.userFrames.get(interval.userTimestampMs);
  const reference = model.referenceFrames.get(interval.referenceTimestampMs);
  if (!user || !reference || !canPair(user, reference)) return gap;
  return { status: 'paired', user, reference };
}

export function projectXYZ(
  point: XYZ,
  volume: Projection3D,
  orientation: Orientation3D,
): Projected3DPoint | null {
  if (
    !xyz(point) ||
    !projection(volume) ||
    !record(orientation) ||
    !finite(orientation.yawDegrees) ||
    !finite(orientation.pitchDegrees)
  )
    return null;
  const x = (point.x - volume.center.x) / volume.radius;
  const y = (point.y - volume.center.y) / volume.radius;
  const z = (point.z - volume.center.z) / volume.radius;
  if (!Number.isFinite(Math.hypot(x, y, z)) || Math.hypot(x, y, z) > 1 + 1e-9)
    return null;
  const yaw = ((orientation.yawDegrees % 360) * Math.PI) / 180;
  const pitch = ((orientation.pitchDegrees % 360) * Math.PI) / 180;
  const rotatedX = x * Math.cos(yaw) + z * Math.sin(yaw);
  const rotatedZ = -x * Math.sin(yaw) + z * Math.cos(yaw);
  return {
    x: rotatedX,
    y: y * Math.cos(pitch) - rotatedZ * Math.sin(pitch),
    depth: y * Math.sin(pitch) + rotatedZ * Math.cos(pitch),
  };
}

export function project3DFrame(
  frame: Frame3D,
  connections: readonly Bone3D[],
  volume: Projection3D,
  orientation: Orientation3D,
): readonly Projected3DPrimitive[] | null {
  const points = new Map<string, Projected3DPoint>();
  const primitives: Projected3DPrimitive[] = [];
  for (const joint of frame.joints) {
    const point = projectXYZ(joint, volume, orientation);
    if (!point || points.has(joint.name)) return null;
    points.set(joint.name, point);
  }
  for (const [fromName, toName] of connections) {
    const from = points.get(fromName);
    const to = points.get(toName);
    if (from && to)
      primitives.push({
        kind: 'bone',
        id: JSON.stringify([fromName, toName]),
        from,
        to,
        depth: (from.depth + to.depth) / 2,
      });
  }
  for (const [id, point] of points) {
    primitives.push({ kind: 'joint', id, point, depth: point.depth });
  }
  return primitives.sort((a, b) => a.depth - b.depth);
}
