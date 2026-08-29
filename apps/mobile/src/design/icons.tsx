import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

export type IconName =
  | 'home'
  | 'library'
  | 'progress'
  | 'settings'
  | 'plus'
  | 'camera'
  | 'upload'
  | 'court'
  | 'arrow'
  | 'chevron'
  | 'back'
  | 'close'
  | 'check'
  | 'pause'
  | 'play'
  | 'lock'
  | 'person'
  | 'volume'
  | 'shield'
  | 'flame'
  | 'bookmark'
  | 'crown'
  | 'spark';

export function Icon(props: {
  name: IconName;
  size?: number;
  color?: string;
  strokeWidth?: number;
}) {
  const size = props.size ?? 22;
  const stroke = props.color ?? '#0B1713';
  const strokeWidth = props.strokeWidth ?? 1.8;
  const common = {
    stroke,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
  };

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {props.name === 'home' && (
        <>
          <Path d="M3.5 10.5 12 3.8l8.5 6.7" {...common} />
          <Path d="M5.5 9.5v10.2h13V9.5M9.5 19.7v-6h5v6" {...common} />
        </>
      )}
      {props.name === 'library' && (
        <>
          <Rect x="4" y="3.5" width="16" height="17" rx="2.5" {...common} />
          <Line x1="8" y1="8" x2="16" y2="8" {...common} />
          <Line x1="8" y1="12" x2="16" y2="12" {...common} />
          <Line x1="8" y1="16" x2="13" y2="16" {...common} />
        </>
      )}
      {props.name === 'progress' && (
        <>
          <Path d="M4 18.5 9 13l3.5 3 7-9" {...common} />
          <Polyline points="15.5,7 19.5,7 19.5,11" {...common} />
        </>
      )}
      {props.name === 'settings' && (
        <>
          <Circle cx="12" cy="12" r="3" {...common} />
          <Path
            d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
            {...common}
          />
        </>
      )}
      {props.name === 'plus' && (
        <>
          <Line x1="12" y1="5" x2="12" y2="19" {...common} />
          <Line x1="5" y1="12" x2="19" y2="12" {...common} />
        </>
      )}
      {props.name === 'camera' && (
        <>
          <Rect x="3" y="6.5" width="18" height="13" rx="3" {...common} />
          <Path d="M8 6.5 9.4 4.5h5.2L16 6.5" {...common} />
          <Circle cx="12" cy="13" r="3.5" {...common} />
        </>
      )}
      {props.name === 'upload' && (
        <>
          <Path d="M12 15V4M8 8l4-4 4 4" {...common} />
          <Path
            d="M5 13v5.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V13"
            {...common}
          />
        </>
      )}
      {props.name === 'court' && (
        <>
          <Rect x="3" y="3.5" width="18" height="17" rx="2" {...common} />
          <Line x1="12" y1="3.5" x2="12" y2="20.5" {...common} />
          <Line x1="3" y1="9" x2="21" y2="9" {...common} />
          <Line x1="3" y1="15" x2="21" y2="15" {...common} />
        </>
      )}
      {props.name === 'arrow' && (
        <>
          <Line x1="5" y1="12" x2="19" y2="12" {...common} />
          <Polyline points="14,7 19,12 14,17" {...common} />
        </>
      )}
      {props.name === 'chevron' && (
        <Polyline points="9,5 16,12 9,19" {...common} />
      )}
      {props.name === 'back' && (
        <>
          <Line x1="19" y1="12" x2="5" y2="12" {...common} />
          <Polyline points="10,7 5,12 10,17" {...common} />
        </>
      )}
      {props.name === 'close' && (
        <>
          <Line x1="6" y1="6" x2="18" y2="18" {...common} />
          <Line x1="18" y1="6" x2="6" y2="18" {...common} />
        </>
      )}
      {props.name === 'check' && (
        <Polyline points="5,12.5 9.5,17 19,7" {...common} />
      )}
      {props.name === 'pause' && (
        <>
          <Line x1="9" y1="7" x2="9" y2="17" {...common} />
          <Line x1="15" y1="7" x2="15" y2="17" {...common} />
        </>
      )}
      {props.name === 'play' && <Path d="m9 7 8 5-8 5Z" {...common} />}
      {props.name === 'lock' && (
        <>
          <Rect x="5" y="10" width="14" height="11" rx="2.5" {...common} />
          <Path d="M8 10V7.5a4 4 0 0 1 8 0V10" {...common} />
        </>
      )}
      {props.name === 'person' && (
        <>
          <Circle cx="12" cy="8" r="3.5" {...common} />
          <Path d="M5.5 20a6.5 6.5 0 0 1 13 0" {...common} />
        </>
      )}
      {props.name === 'volume' && (
        <>
          <Path d="M4 10h3l4-4v12l-4-4H4Z" {...common} />
          <Path
            d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11"
            {...common}
          />
        </>
      )}
      {props.name === 'shield' && (
        <Path
          d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6Z"
          {...common}
        />
      )}
      {props.name === 'flame' && (
        <Path
          d="M13.2 2.8c.7 3.5-1.6 4.8-2.7 6.4-.9 1.3-.8 2.7.3 3.7-.1-2.3 1.5-3.4 3-4.4.2 2 2.9 3.6 2.9 6.8 0 3.3-2.2 5.7-5.2 5.7s-5.3-2.3-5.3-5.6c0-4 3.2-6.2 7-12.6Z"
          {...common}
        />
      )}
      {props.name === 'bookmark' && (
        <Path d="M6 3.5h12v17L12 17l-6 3.5Z" {...common} />
      )}
      {props.name === 'crown' && (
        <>
          <Path d="m4 8 4 3 4-6 4 6 4-3-1.5 10h-13Z" {...common} />
          <Line x1="6" y1="21" x2="18" y2="21" {...common} />
        </>
      )}
      {props.name === 'spark' && (
        <Path
          d="m12 2 1.5 6.5L20 10l-6.5 1.5L12 18l-1.5-6.5L4 10l6.5-1.5Z"
          {...common}
        />
      )}
    </Svg>
  );
}
