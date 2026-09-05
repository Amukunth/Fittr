import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from './tokens';

export type IconName =
  | 'arrow-left'
  | 'x'
  | 'plus'
  | 'minus'
  | 'check'
  | 'share'
  | 'camera'
  | 'bolt'
  | 'user'
  | 'plus-circle'
  | 'refresh'
  | 'rematch'
  | 'flag'
  | 'warning'
  | 'seal-check'
  | 'crosshair'
  | 'signal-off'
  | 'gear'
  | 'pencil'
  | 'barbell'
  | 'timer'
  | 'wall'
  | 'run'
  | 'clock';

interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  /** The check inside `seal-check`. */
  contrast?: string;
  style?: StyleProp<ViewStyle>;
}

/**
 * Icons drawn from Views. No icon font and no SVG runtime is linked in this
 * app, and adding either is a native change, so each glyph is a handful of
 * bars, rings and discs sized off `size`. They tint with `color` exactly
 * like a font icon would. Silhouettes follow the Phosphor Bold set the
 * design canvas uses.
 */
export function Icon({
  name,
  size = 18,
  color = colors.text,
  contrast = colors.bg,
  style,
}: IconProps) {
  const s = size;
  const t = Math.max(2, Math.round(s * 0.13));

  const box: ViewStyle = {
    width: s,
    height: s,
    alignItems: 'center',
    justifyContent: 'center',
  };
  const rot = (deg: number): ViewStyle => ({
    transform: [{ rotate: `${deg}deg` }],
  });
  const bar = (w: number, h: number, extra: ViewStyle = {}): ViewStyle => ({
    position: 'absolute',
    width: w,
    height: h,
    borderRadius: Math.min(w, h) / 2,
    backgroundColor: color,
    ...extra,
  });
  const ring = (d: number, extra: ViewStyle = {}): ViewStyle => ({
    position: 'absolute',
    width: d,
    height: d,
    borderRadius: d / 2,
    borderWidth: t,
    borderColor: color,
    ...extra,
  });
  const disc = (d: number, extra: ViewStyle = {}): ViewStyle => ({
    position: 'absolute',
    width: d,
    height: d,
    borderRadius: d / 2,
    backgroundColor: color,
    ...extra,
  });
  /** A corner of two strokes; rotate it to point the way you need. */
  const chevron = (d: number, extra: ViewStyle = {}): ViewStyle => ({
    position: 'absolute',
    width: d,
    height: d,
    borderLeftWidth: t,
    borderTopWidth: t,
    borderColor: color,
    ...extra,
  });

  let body: React.ReactNode = null;

  switch (name) {
    case 'plus':
      body = (
        <>
          <View style={bar(s * 0.72, t)} />
          <View style={bar(t, s * 0.72)} />
        </>
      );
      break;
    case 'minus':
      body = <View style={bar(s * 0.72, t)} />;
      break;
    case 'x':
      body = (
        <>
          <View style={bar(s * 0.8, t, rot(45))} />
          <View style={bar(s * 0.8, t, rot(-45))} />
        </>
      );
      break;
    case 'arrow-left':
      body = (
        <>
          <View style={bar(s * 0.78, t)} />
          <View style={chevron(s * 0.42, { left: s * 0.12, ...rot(-45) })} />
        </>
      );
      break;
    case 'check': {
      const tick: ViewStyle = {
        width: s * 0.62,
        height: s * 0.34,
        borderLeftWidth: t,
        borderBottomWidth: t,
        borderColor: color,
        marginTop: -s * 0.12,
        ...rot(-45),
      };
      body = <View style={tick} />;
      break;
    }
    case 'share': {
      const tray: ViewStyle = {
        position: 'absolute',
        bottom: s * 0.02,
        width: s * 0.74,
        height: s * 0.5,
        borderWidth: t,
        borderTopWidth: 0,
        borderColor: color,
        borderBottomLeftRadius: t,
        borderBottomRightRadius: t,
      };
      body = (
        <>
          <View style={tray} />
          <View style={bar(t, s * 0.6, { top: s * 0.04 })} />
          <View style={chevron(s * 0.34, { top: s * 0.06, ...rot(45) })} />
        </>
      );
      break;
    }
    case 'camera': {
      const shell: ViewStyle = {
        position: 'absolute',
        bottom: 0,
        width: s,
        height: s * 0.74,
        borderRadius: s * 0.2,
        borderWidth: t,
        borderColor: color,
        alignItems: 'center',
        justifyContent: 'center',
      };
      const lens: ViewStyle = {
        width: s * 0.34,
        height: s * 0.34,
        borderRadius: s * 0.17,
        borderWidth: t,
        borderColor: color,
      };
      body = (
        <>
          <View style={shell}>
            <View style={lens} />
          </View>
          <View
            style={bar(s * 0.32, s * 0.18, {
              top: s * 0.06,
              left: s * 0.3,
              borderRadius: t,
            })}
          />
        </>
      );
      break;
    }
    case 'bolt': {
      // Two slanted bars, the lower one stepped to the right: a Z-shaped flash.
      const upper: ViewStyle = {
        position: 'absolute',
        left: s * 0.42,
        top: 0,
        width: s * 0.28,
        height: s * 0.54,
        borderRadius: 1,
        backgroundColor: color,
        transform: [{ skewX: '-26deg' }],
      };
      const lower: ViewStyle = {
        position: 'absolute',
        left: s * 0.3,
        top: s * 0.46,
        width: s * 0.28,
        height: s * 0.54,
        borderRadius: 1,
        backgroundColor: color,
        transform: [{ skewX: '-26deg' }],
      };
      body = (
        <>
          <View style={upper} />
          <View style={lower} />
        </>
      );
      break;
    }
    case 'user': {
      const shoulders: ViewStyle = {
        position: 'absolute',
        bottom: 0,
        width: s * 0.86,
        height: s * 0.4,
        borderTopLeftRadius: s * 0.43,
        borderTopRightRadius: s * 0.43,
        borderWidth: t,
        borderBottomWidth: 0,
        borderColor: color,
      };
      body = (
        <>
          <View style={ring(s * 0.42, { top: s * 0.02 })} />
          <View style={shoulders} />
        </>
      );
      break;
    }
    case 'plus-circle':
      body = (
        <>
          <View style={ring(s)} />
          <View style={bar(s * 0.44, t)} />
          <View style={bar(t, s * 0.44)} />
        </>
      );
      break;
    case 'refresh':
    case 'rematch': {
      const head: ViewStyle = {
        position: 'absolute',
        top: s * 0.02,
        right: s * 0.04,
        width: 0,
        height: 0,
        borderTopWidth: s * 0.16,
        borderBottomWidth: s * 0.16,
        borderLeftWidth: s * 0.26,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: color,
      };
      const flip: ViewStyle =
        name === 'rematch' ? { transform: [{ scaleX: -1 }] } : {};
      body = (
        <View style={[box, flip]}>
          <View
            style={ring(s * 0.84, {
              borderRightColor: 'transparent',
              ...rot(-35),
            })}
          />
          <View style={head} />
        </View>
      );
      break;
    }
    case 'flag':
      body = (
        <>
          <View style={bar(t, s * 0.96, { left: s * 0.16 })} />
          <View
            style={bar(s * 0.62, s * 0.44, {
              top: s * 0.04,
              left: s * 0.16 + t - 1,
              borderRadius: 0,
              borderTopRightRadius: t,
              borderBottomRightRadius: t,
            })}
          />
        </>
      );
      break;
    case 'warning':
      body = (
        <>
          <View style={ring(s * 0.92)} />
          <View style={bar(t, s * 0.34, { top: s * 0.22 })} />
          <View style={disc(t, { bottom: s * 0.2 })} />
        </>
      );
      break;
    case 'seal-check': {
      const tick: ViewStyle = {
        width: s * 0.5,
        height: s * 0.27,
        borderLeftWidth: Math.max(2, t * 0.9),
        borderBottomWidth: Math.max(2, t * 0.9),
        borderColor: contrast,
        marginTop: -s * 0.08,
        ...rot(-45),
      };
      body = (
        <>
          <View style={disc(s)} />
          <View style={tick} />
        </>
      );
      break;
    }
    case 'crosshair':
      body = (
        <>
          <View style={ring(s * 0.66)} />
          <View style={bar(s * 0.22, t, { left: 0 })} />
          <View style={bar(s * 0.22, t, { right: 0 })} />
          <View style={bar(t, s * 0.22, { top: 0 })} />
          <View style={bar(t, s * 0.22, { bottom: 0 })} />
          <View style={disc(t * 1.4)} />
        </>
      );
      break;
    case 'signal-off':
      body = (
        <>
          <View style={ring(s * 0.92)} />
          <View style={bar(s * 0.9, t, rot(45))} />
        </>
      );
      break;
    case 'gear': {
      const tooth = t * 1.6;
      const teeth = (
        <>
          <View style={bar(tooth, tooth, { top: 0, borderRadius: 1 })} />
          <View style={bar(tooth, tooth, { bottom: 0, borderRadius: 1 })} />
          <View style={bar(tooth, tooth, { left: 0, borderRadius: 1 })} />
          <View style={bar(tooth, tooth, { right: 0, borderRadius: 1 })} />
        </>
      );
      const diagonal: ViewStyle = { ...box, position: 'absolute', ...rot(45) };
      body = (
        <>
          <View style={ring(s * 0.62, { borderWidth: t * 1.4 })} />
          {teeth}
          <View style={diagonal}>{teeth}</View>
        </>
      );
      break;
    }
    case 'pencil':
      body = (
        <>
          <View style={bar(s * 0.92, t * 1.6, rot(-45))} />
          <View style={disc(t * 1.2, { left: s * 0.02, bottom: s * 0.02 })} />
        </>
      );
      break;
    case 'barbell':
      body = (
        <>
          <View style={bar(s, t)} />
          <View style={bar(t * 1.7, s * 0.62, { left: s * 0.14 })} />
          <View style={bar(t * 1.7, s * 0.62, { right: s * 0.14 })} />
          <View style={bar(t, s * 0.36, { left: 0 })} />
          <View style={bar(t, s * 0.36, { right: 0 })} />
        </>
      );
      break;
    case 'timer':
      body = (
        <>
          <View style={ring(s * 0.8, { top: s * 0.18 })} />
          <View style={bar(t, s * 0.24, { top: s * 0.36 })} />
          <View style={bar(s * 0.3, t, { top: s * 0.02 })} />
        </>
      );
      break;
    case 'wall':
      body = (
        <>
          <View style={bar(t, s, { left: s * 0.08 })} />
          <View style={bar(s * 0.5, t, { left: s * 0.08, top: s * 0.52 })} />
          <View style={disc(s * 0.26, { left: s * 0.36, top: s * 0.06 })} />
          <View style={bar(t, s * 0.46, { left: s * 0.52, top: s * 0.52 })} />
        </>
      );
      break;
    case 'run':
      body = (
        <>
          <View style={disc(s * 0.26, { top: 0, right: s * 0.14 })} />
          <View style={bar(t, s * 0.44, { top: s * 0.24, ...rot(25) })} />
          <View
            style={bar(t, s * 0.3, { top: s * 0.3, left: s * 0.14, ...rot(-50) })}
          />
          <View
            style={bar(t, s * 0.42, {
              bottom: s * 0.02,
              left: s * 0.2,
              ...rot(40),
            })}
          />
          <View
            style={bar(t, s * 0.4, { bottom: 0, right: s * 0.2, ...rot(-30) })}
          />
        </>
      );
      break;
    case 'clock':
      body = (
        <>
          <View style={ring(s * 0.92)} />
          <View style={bar(t, s * 0.3, { top: s * 0.2 })} />
          <View
            style={bar(s * 0.26, t, { top: s * 0.5 - t / 2, left: s * 0.5 - t / 2 })}
          />
        </>
      );
      break;
  }

  return (
    <View style={[box, style]} pointerEvents="none">
      {body}
    </View>
  );
}
