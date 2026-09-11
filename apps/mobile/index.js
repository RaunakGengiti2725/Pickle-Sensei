/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import { stabilitySlo } from './src/analysis/stabilityTelemetry';
import { registerBackgroundNotificationHandler } from './src/notifications/service';
import {
  captureGlobalError,
  initializeDiagnostics,
} from './src/diagnostics/sentry';

function djb2(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 33 + text.charCodeAt(i)) % 4294967296;
  }
  return hash.toString(16).padStart(8, '0');
}

// Stable hash of the top frame (never a stack body) — the stability-slo-v1
// crash fingerprint. Falls back to name+message when no frame is available.
function crashFingerprint(error) {
  const isObject = typeof error === 'object' && error !== null;
  const name =
    isObject && typeof error.name === 'string' && error.name !== ''
      ? error.name
      : 'Error';
  const stack = isObject && typeof error.stack === 'string' ? error.stack : '';
  const topFrame = stack
    .split('\n')
    .map(line => line.trim())
    .find(line => line.startsWith('at '));
  const message = isObject ? String(error.message ?? '') : String(error);
  return djb2(`${name}|${topFrame ?? message}`);
}

function attemptDiagnostics(operation) {
  try {
    return operation();
  } catch {
    return false;
  }
}

function installGlobalErrorHandler() {
  const errorUtils = global.ErrorUtils;
  if (
    !errorUtils ||
    typeof errorUtils.setGlobalHandler !== 'function' ||
    typeof errorUtils.getGlobalHandler !== 'function'
  )
    return;
  const previous = errorUtils.getGlobalHandler();
  const installedKey = Symbol.for('pickle.globalErrorHandler.v1');
  if (typeof previous !== 'function' || previous[installedKey]) return;
  const handler = (error, isFatal) => {
    attemptDiagnostics(() => captureGlobalError(error, isFatal === true));
    try {
      stabilitySlo.record({
        kind: 'crash',
        fatal: isFatal === true,
        fingerprint: crashFingerprint(error),
      });
    } catch {
      // Telemetry must never stand between an error and its handler.
    }
    previous(error, isFatal);
  };
  handler[installedKey] = true;
  errorUtils.setGlobalHandler(handler);
}

function toError(rejection) {
  if (rejection instanceof Error) return rejection;
  let detail;
  try {
    detail =
      typeof rejection === 'string' ? rejection : JSON.stringify(rejection);
  } catch {
    detail = String(rejection);
  }
  return new Error(`Unhandled promise rejection: ${detail}`);
}

// React Native only tracks unhandled rejections in development builds
// (LogBox). In Release, route them through the global handler as non-fatal
// errors so they are logged natively and counted by stability telemetry
// instead of vanishing.
function installPromiseRejectionTracking() {
  if (__DEV__) return;
  const hermes = global.HermesInternal;
  if (!hermes || typeof hermes.enablePromiseRejectionTracker !== 'function') {
    return;
  }
  hermes.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (id, rejection) => {
      const error = toError(rejection);
      const errorUtils = global.ErrorUtils;
      if (errorUtils && typeof errorUtils.reportError === 'function') {
        errorUtils.reportError(error);
      } else {
        console.error(`Unhandled promise rejection (id: ${id})`, error);
      }
    },
    onHandled: id => {
      console.warn(`Promise rejection handled late (id: ${id})`);
    },
  });
}

attemptDiagnostics(initializeDiagnostics);
installGlobalErrorHandler();
installPromiseRejectionTracking();

const App = require('./App').default;

// Must be registered outside the component tree: the notification library
// requires a background event handler even though local reminders do no
// background work.
registerBackgroundNotificationHandler();

AppRegistry.registerComponent(appName, () => App);
