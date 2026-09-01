/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import { registerBackgroundNotificationHandler } from './src/notifications/service';

// Must be registered outside the component tree: the notification library
// requires a background event handler even though local reminders do no
// background work.
registerBackgroundNotificationHandler();

AppRegistry.registerComponent(appName, () => App);
