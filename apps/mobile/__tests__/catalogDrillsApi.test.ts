import { createTrainingApi } from '../src/training/api';

/**
 * Contract pin for GET /v1/catalog/drills (drill-library-v1 engineering
 * seed). The parser is as strict as the saved-drill parser: a malformed item
 * is rejected outright instead of being partially rendered, unknown fields
 * are ignored, and the UNVALIDATED state is preserved verbatim so the UI can
 * label the catalog honestly.
 */

const catalogItem = {
  id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
  slug: 'dink-target-ladder',
  title: 'Dink Target Ladder',
  description:
    'Land four consecutive cross-court dinks per kitchen zone, then move up.',
  coach_name: 'Engineering draft — not coach-validated',
  equipment: ['paddle', 'balls'],
  difficulty_min: '2.0',
  difficulty_max: '3.5',
  families: ['dink'],
  validation_state: 'UNVALIDATED',
  saved: false,
};

function response(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

function clientFor(payload: unknown, fetchSpy?: jest.Mock) {
  const fetchFn =
    fetchSpy ??
    jest.fn(async (_input: string) => response(200, payload));
  return {
    client: createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    }),
    fetchFn,
  };
}

describe('catalog drill listing', () => {
  it('parses a valid item and ignores unknown fields', async () => {
    const { client } = clientFor({
      items: [{ ...catalogItem, some_future_field: 'ignored' }],
      cursor: null,
    });
    await expect(client.listCatalogDrills({})).resolves.toEqual([
      {
        id: catalogItem.id,
        slug: 'dink-target-ladder',
        title: 'Dink Target Ladder',
        description: catalogItem.description,
        coachName: 'Engineering draft — not coach-validated',
        equipment: ['paddle', 'balls'],
        difficultyMin: '2.0',
        difficultyMax: '3.5',
        families: ['dink'],
        validationState: 'UNVALIDATED',
        saved: false,
      },
    ]);
  });

  it('rejects an item with a missing or malformed required field', async () => {
    const malformed: Record<string, unknown>[] = [
      { ...catalogItem, title: undefined },
      { ...catalogItem, title: '   ' },
      { ...catalogItem, id: 'not-a-uuid' },
      { ...catalogItem, coach_name: undefined },
      { ...catalogItem, description: 42 },
      { ...catalogItem, equipment: ['paddle', 7] },
      { ...catalogItem, equipment: 'paddle' },
      { ...catalogItem, families: null },
      { ...catalogItem, difficulty_min: 2 },
      { ...catalogItem, validation_state: '' },
      { ...catalogItem, saved: 'yes' },
    ];
    for (const item of malformed) {
      const { client } = clientFor({ items: [item], cursor: null });
      await expect(client.listCatalogDrills({})).rejects.toMatchObject({
        code: 'training.invalid_response',
      });
    }
  });

  it('rejects a payload whose items collection is not an array', async () => {
    const { client } = clientFor({ items: { 0: catalogItem }, cursor: null });
    await expect(client.listCatalogDrills({})).rejects.toMatchObject({
      code: 'training.invalid_response',
    });
  });

  it('passes q and family through to the catalog endpoint, encoded', async () => {
    const fetchFn = jest.fn(async (_input: string) =>
      response(200, { items: [catalogItem], cursor: null }),
    );
    const { client } = clientFor(null, fetchFn);
    await client.listCatalogDrills({ q: 'kitchen line', family: 'drop_reset' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.pickle.test/v1/catalog/drills?q=kitchen%20line&family=drop_reset',
      expect.objectContaining({ method: 'GET' }),
    );
    await client.listCatalogDrills({ family: 'dink' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.pickle.test/v1/catalog/drills?family=dink',
      expect.anything(),
    );
    await client.listCatalogDrills({ q: '   ', family: '' });
    expect(fetchFn).toHaveBeenLastCalledWith(
      'https://api.pickle.test/v1/catalog/drills',
      expect.anything(),
    );
  });

  it('keeps a future validation_state verbatim without validating it', async () => {
    const { client } = clientFor({
      items: [
        {
          ...catalogItem,
          validation_state: 'COACH_REVIEW_PENDING',
          difficulty_min: null,
          difficulty_max: null,
        },
      ],
      cursor: null,
    });
    await expect(client.listCatalogDrills({})).resolves.toMatchObject([
      {
        validationState: 'COACH_REVIEW_PENDING',
        difficultyMin: null,
        difficultyMax: null,
      },
    ]);
  });
});
