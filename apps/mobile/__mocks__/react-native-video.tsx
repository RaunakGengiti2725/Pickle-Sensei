/**
 * Jest auto-mock for react-native-video. Renders an inert host view that
 * carries the player's props and callbacks, so tests can read the playback
 * configuration and drive playback events (onProgress / onEnd / onError)
 * directly; nothing native is touched.
 */

import React from 'react';
import { View } from 'react-native';

const Video = React.forwardRef<View, Record<string, unknown>>(
  function VideoMock(props, ref) {
    return <View ref={ref} {...props} />;
  },
);

export default Video;
export { Video };
