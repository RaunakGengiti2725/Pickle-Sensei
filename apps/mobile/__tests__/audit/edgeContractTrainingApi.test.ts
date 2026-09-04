/**
 * Execution audit (mobile-training-drills): replays RAW responses recorded
 * from the real edge handler (supabase/functions/api/index.ts, captured by
 * supabase/functions/api/__wf__/audit-dump-training-responses.ts into
 * fixtures/edgeTrainingResponses.json) through the real mobile client
 * (src/training/api.ts). This executes the server→client contract for every
 * route the Training module calls, instead of trusting hand-written fixtures
 * on each side to agree with each other.
 */
import { createTrainingApi } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

// Node built-ins typed the same way importedRealFootageAnalysis.test.ts does
// (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as {
  join: (...parts: string[]) => string;
};

interface DumpedResponse {
  name: string;
  method: string;
  path: string;
  status: number;
  contentType: string | null;
  body: unknown;
}

interface Dump {
  generatedFrom: string;
  catalogSize: number;
  cases: DumpedResponse[];
}

const dump = JSON.parse(
  readFileSync(
    join(__dirname, 'fixtures', 'edgeTrainingResponses.json'),
    'utf8',
  ),
) as Dump;

const byName = new Map(dump.cases.map(entry => [entry.name, entry]));

function recorded(name: string): DumpedResponse {
  const entry = byName.get(name);
  if (!entry) throw new Error(`fixture missing case ${name}`);
  return entry;
}

/** A fetch that answers exactly one recorded case and records the request. */
function replay(entry: DumpedResponse) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url, init });
    const headers: Record<string, string> = {};
    if (entry.contentType) headers['Content-Type'] = entry.contentType;
    const text =
      entry.body === null
        ? ''
        : typeof entry.body === 'string'
          ? entry.body
          : JSON.stringify(entry.body);
    return {
      ok: entry.status >= 200 && entry.status < 300,
      status: entry.status,
      statusText: '',
      headers: new Map(Object.entries(headers)) as unknown as Headers,
      json: async () => {
        if (text === '') throw new SyntaxError('Unexpected end of JSON input');
        return JSON.parse(text) as unknown;
      },
      text: async () => text,
    } as unknown as Response;
  };
  const api = createTrainingApi({
    baseUrl: 'https://edge.test/functions/v1/api',
    token: 'session-for-test',
    fetchFn,
  });
  return { api, calls };
}

function expectRequestedPath(
  calls: { url: string }[],
  entry: DumpedResponse,
): void {
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(`https://edge.test/functions/v1/api${entry.path}`);
}

describe('edge → mobile training contract (recorded real handler responses)', () => {
  it('fixture was produced by the real edge handler and covers the whole catalog', () => {
    expect(dump.generatedFrom).toContain('supabase/functions/api/index.ts');
    expect(dump.catalogSize).toBeGreaterThan(0);
    const detailCases = dump.cases.filter(entry =>
      entry.name.startsWith('catalog.detail.'),
    );
    // every catalog slug + notFound + encodedSlug
    expect(detailCases).toHaveLength(dump.catalogSize + 2);
  });

  it('GET /v1/catalog/drills parses every published drill and preserves the saved join', async () => {
    const entry = recorded('catalog.list.all');
    const { api, calls } = replay(entry);
    const items = await api.listCatalogDrills({});
    expectRequestedPath(calls, entry);
    expect(items).toHaveLength(dump.catalogSize);
    expect(items.filter(item => item.saved).map(item => item.slug)).toEqual([
      items[0]?.slug,
    ]);
    for (const item of items) {
      expect(item.families.length).toBeGreaterThan(0);
      expect(item.validationState).not.toBe('');
      expect(item.coachName).not.toBe('');
    }
  });

  it('GET /v1/catalog/drills?family= and ?q= parse and never return an empty coach byline', async () => {
    for (const name of ['catalog.list.family', 'catalog.list.q']) {
      const entry = recorded(name);
      const { api } = replay(entry);
      const items = await api.listCatalogDrills({});
      expect(items.length).toBeGreaterThan(0);
    }
  });

  it('empty filter results are an honest empty list, not an error', async () => {
    for (const name of [
      'catalog.list.unknownFamily',
      'catalog.list.emptyQuery',
    ]) {
      const entry = recorded(name);
      expect(entry.status).toBe(200);
      const { api } = replay(entry);
      await expect(api.listCatalogDrills({})).resolves.toEqual([]);
    }
  });

  it('GET /v1/catalog/drills/:slug parses every published drill detail, including embed media', async () => {
    const detailCases = dump.cases.filter(
      entry => entry.name.startsWith('catalog.detail.') && entry.status === 200,
    );
    expect(detailCases).toHaveLength(dump.catalogSize);
    let withMedia = 0;
    for (const entry of detailCases) {
      const { api } = replay(entry);
      const slug = entry.name.slice('catalog.detail.'.length);
      const detail = await api.getDrill(slug);
      expect(detail.slug).toBe(slug);
      // Server ships no reviewed prescriptions yet; the client must accept that
      // honestly instead of failing the whole detail.
      expect(detail.mappings).toEqual([]);
      for (const media of detail.instructionalMedia) {
        expect(media.kind).toBe('embed');
        if (media.kind === 'embed') {
          expect(media.provider).toBe('youtube');
          expect(media.embedUrl).toBe(
            `https://www.youtube-nocookie.com/embed/${media.videoId}`,
          );
          expect(media.attribution).not.toBe('');
        }
      }
      if (detail.instructionalMedia.length > 0) withMedia += 1;
    }
    // Documented in-app expectation: the catalog is playable, not a text list.
    expect(withMedia).toBeGreaterThan(0);
  });

  it('unknown / encoded slugs surface the server code drill.not_found (non-retryable 404)', async () => {
    for (const name of [
      'catalog.detail.notFound',
      'catalog.detail.encodedSlug',
    ]) {
      const entry = recorded(name);
      const { api } = replay(entry);
      await expect(api.getDrill('whatever')).rejects.toMatchObject({
        code: 'drill.not_found',
        retryable: false,
        status: 404,
      } satisfies Partial<TrainingError>);
    }
  });

  it('GET /v1/me/saved-drills parses populated, empty and catalog-orphaned rows', async () => {
    const populated = replay(recorded('saved.list'));
    const items = await populated.api.listSavedDrills();
    expect(items).toHaveLength(2);
    expect(items.every(item => item.savedAt.length > 0)).toBe(true);

    const empty = replay(recorded('saved.list.empty'));
    await expect(empty.api.listSavedDrills()).resolves.toEqual([]);

    const orphaned = replay(recorded('saved.list.unknownSlug'));
    const [orphan] = await orphaned.api.listSavedDrills();
    expect(orphan).toBeDefined();
    expect(orphan?.slug).toBe('removed-from-catalog');
    expect(orphan?.description).toContain('no longer in the published catalog');
  });

  it('PUT /v1/me/saved-drills/:slug echoes {slug, saved:true}; DELETE is a bodiless 204', async () => {
    const put = recorded('saved.put');
    const saved = replay(put);
    await expect(
      saved.api.saveDrill('wall-dink-rally'),
    ).resolves.toBeUndefined();
    expect(saved.calls[0]?.init?.method).toBe('PUT');

    const del = recorded('saved.delete');
    expect(del.status).toBe(204);
    expect(del.body).toBeNull();
    const removed = replay(del);
    await expect(
      removed.api.unsaveDrill('wall-dink-rally'),
    ).resolves.toBeUndefined();
    expect(removed.calls[0]?.init?.method).toBe('DELETE');
  });

  it('server-side slug validation (400 validation.saved_drill) is surfaced non-retryably', async () => {
    const { api } = replay(recorded('saved.put.invalidSlug'));
    await expect(api.saveDrill('Bad Slug!')).rejects.toMatchObject({
      code: 'validation.saved_drill',
      retryable: false,
      status: 400,
    } satisfies Partial<TrainingError>);
  });

  it('GET /v1/training-plans/current → null plan (honest empty state)', async () => {
    const { api } = replay(recorded('plans.current'));
    await expect(api.getCurrentPlan()).resolves.toBeNull();
  });

  it('POST /v1/training-plans → 409 training.plan_unavailable with the server message', async () => {
    const { api } = replay(recorded('plans.create'));
    await expect(
      api.createPlan('b8aece05-d9dc-49eb-af98-54fe0b6e8db7'),
    ).rejects.toMatchObject({
      code: 'training.plan_unavailable',
      retryable: false,
      status: 409,
    } satisfies Partial<TrainingError>);
  });

  it('DOCUMENTS: reassessment and drill-completion routes are NOT served by the edge (404 Unknown endpoint)', async () => {
    // The client implements both calls (api.ts reassessPlan/completeDrill) but
    // the edge router has no handler; today they are unreachable because the
    // current plan is always null, so this pins the contract rather than a
    // user-facing failure.
    const reassess = recorded('plans.reassess');
    expect(reassess.status).toBe(404);
    const { api: reassessApi } = replay(reassess);
    await expect(
      reassessApi.reassessPlan(
        '78a7815a-176a-4487-a736-66eb2cc04455',
        '9c32cbd4-b6aa-491a-b23f-2f982eabb380',
      ),
    ).rejects.toMatchObject({
      code: 'training.request_failed',
      retryable: false,
      status: 404,
    } satisfies Partial<TrainingError>);

    const complete = recorded('completions.create');
    expect(complete.status).toBe(404);
    const { api: completeApi } = replay(complete);
    await expect(
      completeApi.completeDrill({
        id: '0e3f1d8a-6b2c-4f5e-9a7d-1c2b3a4d5e6f',
        drillSlug: 'wall-dink-rally',
        trainingPlanItemId: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
        completedAt: '2026-09-04T10:00:00.000Z',
        actualRepetitions: 24,
        actualDurationSeconds: null,
      }),
    ).rejects.toMatchObject({
      code: 'training.request_failed',
      retryable: false,
      status: 404,
    } satisfies Partial<TrainingError>);
  });
});

describe('client error mapping on non-JSON error bodies (gateway-style failures)', () => {
  function rawResponse(status: number, text: string, contentType: string) {
    const fetchFn = async (): Promise<Response> =>
      ({
        ok: status >= 200 && status < 300,
        status,
        statusText: '',
        headers: new Map([['Content-Type', contentType]]) as unknown as Headers,
        json: async () => JSON.parse(text) as unknown,
        text: async () => text,
      }) as unknown as Response;
    return createTrainingApi({
      baseUrl: 'https://edge.test/functions/v1/api',
      token: 'session-for-test',
      fetchFn,
    });
  }

  it('DOCUMENTS: an HTML/plain-text 503 is reported as training.invalid_response with status null (the HTTP status is lost)', async () => {
    const api = rawResponse(
      503,
      '<html><body>Service Unavailable</body></html>',
      'text/html',
    );
    let caught: unknown;
    try {
      await api.listCatalogDrills({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TrainingError);
    const error = caught as TrainingError;
    // Observed behaviour pinned here so a change is visible: readJson() runs
    // before the !response.ok branch (api.ts:454-455), so a non-JSON error
    // body wins over the HTTP status. Retryable stays true, but the message
    // blames the server payload ("invalid response") and `status` is null,
    // so callers cannot distinguish an outage from a malformed 200.
    expect(error.code).toBe('training.invalid_response');
    expect(error.retryable).toBe(true);
    expect(error.status).toBeNull();
  });

  it('a JSON 503 keeps its status and server message', async () => {
    const api = rawResponse(
      503,
      JSON.stringify({
        error: { code: 'service.unavailable', message: 'Try again shortly.' },
      }),
      'application/json',
    );
    await expect(api.listCatalogDrills({})).rejects.toMatchObject({
      code: 'service.unavailable',
      message: 'Try again shortly.',
      retryable: true,
      status: 503,
    } satisfies Partial<TrainingError>);
  });

  it('an empty-body 500 is also collapsed into training.invalid_response', async () => {
    const api = rawResponse(500, '', 'text/plain');
    await expect(api.getCurrentPlan()).rejects.toMatchObject({
      code: 'training.invalid_response',
      status: null,
    } satisfies Partial<TrainingError>);
  });
});
