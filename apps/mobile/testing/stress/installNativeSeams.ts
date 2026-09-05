/**
 * Side-effect import: installs the fake `PickleVideoCapture` bridge into
 * `NativeModules` BEFORE any production module that binds it at import time
 * (`src/camera/capture.ts`). Import this first in a stress test file.
 */
import { installFakeVideoCaptureBridge } from './fakeVideoCaptureBridge';

installFakeVideoCaptureBridge();
