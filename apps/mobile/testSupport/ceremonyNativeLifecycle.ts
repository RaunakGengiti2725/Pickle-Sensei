import { AppState, BackHandler } from 'react-native';

const backHandlers = new Set<
  Parameters<typeof BackHandler.addEventListener>[1]
>();
let backSubscription: jest.SpyInstance;

beforeEach(() => {
  AppState.currentState = 'active';
  backHandlers.clear();
  backSubscription = jest
    .spyOn(BackHandler, 'addEventListener')
    .mockImplementation((_event, handler) => {
      backHandlers.add(handler);
      return { remove: () => backHandlers.delete(handler) };
    });
});

afterEach(() => {
  backSubscription.mockRestore();
});

export function dispatchHardwareBack(): boolean {
  for (const handler of [...backHandlers].reverse()) {
    if (handler({ type: 'hardwareBackPress', timeStamp: Date.now() }))
      return true;
  }
  return false;
}
