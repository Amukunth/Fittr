import React, { useState } from 'react';
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import { fmtMultiplier } from '../lib/soloModes';
import {
  blitzMultiplierBp,
  blitzScoreForMultiplier,
  fmtScore,
} from '../lib/score';
import { colors, fonts, label, radius, space } from '../theme/tokens';

/**
 * The Blitz payout curve: payout multiplier plotted against score, with
 * SCORE on the vertical axis.
 *
 * Drawn with plain Views -- there is no SVG dependency in this app -- as
 * short rotated segments, which is enough for a piecewise-linear curve.
 *
 * WHAT IT SHOWS IS THE REAL FUNCTION, NOT THE REFERENCE'S SHAPE. The
 * reference image sweeps a smooth convex curve from the bottom-left up
 * through Break Even to 2.5x. Fittr's payout is documented as:
 *
 *   below the threshold      0 (stake lost)
 *   at the threshold         1.0x (break even)
 *   threshold .. benchmark   linear up to 2.5x
 *   past the benchmark       2.5x, capped
 *
 * so the honest picture is: a muted line at zero payout climbing the score
 * axis to the threshold, a dotted jump across to 1.0x at that same score,
 * a straight accent line up to 2.5x at the benchmark, and a flat cap
 * beyond it. If the curve is ever changed to something smooth, this
 * component draws whatever blitzMultiplierBp() says, point by point --
 * the sampling below does not assume linearity.
 */
export function PayoutCurve({
  threshold,
  benchmark,
  breakevenBp,
  maxBp,
  markScore,
  height = 300,
}: {
  threshold: number;
  benchmark: number;
  breakevenBp: number;
  maxBp: number;
  /** A score to mark on the curve, e.g. the one just recorded. */
  markScore?: number | null;
  height?: number;
}) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const span = Math.max(1, benchmark - threshold);
  // Room below the threshold to show the muted region, and a little above
  // the benchmark to show the cap.
  const floor = Math.max(0, Math.round(threshold - span * 0.7));
  const ceil = Math.round(benchmark + span * 0.18);
  const domain = Math.max(1, ceil - floor);

  const chartW = Math.max(0, width - AXIS_W);
  const plotL = PAD_X;
  const plotR = chartW - PAD_X;
  const plotT = PAD_Y;
  const plotB = height - PAD_Y;

  const xFor = (bp: number) => plotL + ((plotR - plotL) * bp) / maxBp;
  const yFor = (score: number) => plotB - ((plotB - plotT) * (score - floor)) / domain;

  // Sample the curve above the threshold. Straight today, but sampled so a
  // future non-linear curve draws correctly without touching this file.
  const samples: Array<{ x: number; y: number }> = [];
  const steps = 24;
  for (let i = 0; i <= steps; i += 1) {
    const score = threshold + (span * i) / steps;
    const bp = blitzMultiplierBp(score, threshold, benchmark, breakevenBp, maxBp);
    samples.push({ x: xFor(bp), y: yFor(score) });
  }

  const twoX = blitzScoreForMultiplier(20000, threshold, benchmark, breakevenBp, maxBp);
  const mid = blitzScoreForMultiplier(15000, threshold, benchmark, breakevenBp, maxBp);

  // Right-axis ticks: two muted ones under the bar, then the curve's own
  // checkpoints. The threshold's tick is the break-even label itself.
  const ticks: Array<{ score: number; muted: boolean }> = [
    { score: floor, muted: true },
    { score: Math.round(floor + (threshold - floor) / 2), muted: true },
    { score: threshold, muted: false },
    { score: mid, muted: false },
    { score: twoX, muted: false },
    { score: benchmark, muted: false },
    { score: ceil, muted: false },
  ];

  const markBp =
    markScore === null || markScore === undefined
      ? null
      : blitzMultiplierBp(markScore, threshold, benchmark, breakevenBp, maxBp);
  const markX =
    markScore === null || markScore === undefined || markBp === null
      ? null
      : markBp === 0
        ? xFor(0)
        : xFor(markBp);
  const markY =
    markScore === null || markScore === undefined
      ? null
      : yFor(Math.max(floor, Math.min(ceil, markScore)));

  return (
    <View style={[styles.wrap, { height }]} onLayout={onLayout}>
      {width > 0 ? (
        <>
          <View style={[styles.chart, { width: chartW, height }]}>
            {/* Muted: zero payout, climbing the score axis to the threshold. */}
            <Segment x1={xFor(0)} y1={yFor(floor)} x2={xFor(0)} y2={yFor(threshold)} color={colors.dim} />
            {/* The jump to break-even at the threshold, dotted. */}
            <Dotted x1={xFor(0)} y1={yFor(threshold)} x2={xFor(breakevenBp)} y2={yFor(threshold)} />
            {/* The curve proper, in the accent. */}
            {samples.slice(1).map((p, i) => {
              const q = samples[i]!;
              return (
                <Segment key={i} x1={q.x} y1={q.y} x2={p.x} y2={p.y} color={colors.accent} width={2.5} />
              );
            })}
            {/* The cap: 2.5x however far past the benchmark. */}
            <Segment x1={xFor(maxBp)} y1={yFor(benchmark)} x2={xFor(maxBp)} y2={yFor(ceil)} color={colors.accentOutline} width={2.5} />

            {/* Guides from the checkpoints to the axis. */}
            <Guide y={yFor(threshold)} from={xFor(breakevenBp)} to={chartW} />
            <Guide y={yFor(twoX)} from={xFor(20000)} to={chartW} />
            <Guide y={yFor(benchmark)} from={xFor(maxBp)} to={chartW} />

            <Checkpoint x={xFor(breakevenBp)} y={yFor(threshold)} text="BREAK EVEN" tone="plain" align="left" />
            <Checkpoint x={xFor(20000)} y={yFor(twoX)} text={fmtMultiplier(20000)} tone="accentText" align="left" />
            <Checkpoint x={xFor(maxBp)} y={yFor(benchmark)} text={fmtMultiplier(maxBp)} tone="accent" align="left" />

            {markX !== null && markY !== null ? (
              <View style={[styles.mark, { left: markX - 7, top: markY - 7 }]} accessibilityLabel="Your score" />
            ) : null}

            <Text style={styles.xCaption}>PAYOUT →</Text>
          </View>

          <View style={[styles.axis, { width: AXIS_W, height }]}>
            <Text style={styles.axisTitle}>SCORE</Text>
            <View style={[styles.axisLine, { top: plotT, height: plotB - plotT }]} />
            {ticks.map((t, i) => (
              <View key={i} style={[styles.tick, { top: yFor(t.score) - 9 }]}>
                <View style={styles.tickMark} />
                <Text style={[styles.tickText, t.muted && styles.tickTextMuted]}>
                  {fmtScore(t.score)}
                </Text>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </View>
  );
}

const AXIS_W = 78;
const PAD_X = 14;
const PAD_Y = 22;

/** One straight piece of line between two points, as a rotated View. */
function Segment({
  x1,
  y1,
  x2,
  y2,
  color,
  width = 2,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width?: number;
}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < 0.5) {
    return null;
  }
  const angle = Math.atan2(dy, dx);
  const style = {
    position: 'absolute' as const,
    left: (x1 + x2) / 2 - length / 2,
    top: (y1 + y2) / 2 - width / 2,
    width: length,
    height: width,
    borderRadius: width / 2,
    backgroundColor: color,
    transform: [{ rotate: `${angle}rad` }],
  };
  return <View style={style} />;
}

/** A row of dots between two points on the same horizontal. */
function Dotted({ x1, y1, x2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const gap = 7;
  const count = Math.max(0, Math.floor(Math.abs(x2 - x1) / gap));
  const dir = x2 >= x1 ? 1 : -1;
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.dot, { left: x1 + dir * i * gap, top: y1 - 1.5 }]} />
      ))}
    </>
  );
}

/** A faint dashed guide from a checkpoint across to the axis. */
function Guide({ y, from, to }: { y: number; from: number; to: number }) {
  const gap = 8;
  const count = Math.max(0, Math.floor((to - from) / gap));
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.dash, { left: from + i * gap, top: y }]} />
      ))}
    </>
  );
}

/** A labelled pill sitting on the curve. */
function Checkpoint({
  x,
  y,
  text,
  tone,
  align,
}: {
  x: number;
  y: number;
  text: string;
  tone: 'plain' | 'accentText' | 'accent';
  align: 'left' | 'right';
}) {
  const pill =
    tone === 'accent'
      ? styles.pillAccent
      : tone === 'accentText'
        ? styles.pillAccentText
        : styles.pillPlain;
  const ink =
    tone === 'accent' ? colors.accent : tone === 'accentText' ? colors.accent : colors.text;
  const pos = align === 'left' ? { right: undefined, left: x - 8 } : { left: undefined, right: x + 8 };
  return (
    <View style={[styles.pill, pill, { top: y - 17 }, pos]} pointerEvents="none">
      <Text style={[styles.pillText, { color: ink }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', width: '100%' },
  chart: { position: 'relative' },
  axis: { position: 'relative' },
  axisTitle: {
    ...label(10, colors.text, 0.14),
    position: 'absolute',
    top: 0,
    right: 0,
  },
  axisLine: {
    position: 'absolute',
    left: 0,
    width: 1,
    backgroundColor: colors.border,
  },
  tick: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 18,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  tickMark: { width: 6, height: 1, backgroundColor: colors.dim },
  tickText: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    includeFontPadding: false,
  },
  tickTextMuted: { color: colors.dim },
  dot: {
    position: 'absolute',
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: colors.dim,
  },
  dash: {
    position: 'absolute',
    width: 4,
    height: 1,
    backgroundColor: colors.slot,
  },
  pill: {
    position: 'absolute',
    height: 34,
    paddingHorizontal: 12,
    borderRadius: radius.tile,
    alignItems: 'center',
    justifyContent: 'center',
    // Pills sit to the right of their point; the plot leaves room for them.
    transform: [{ translateX: 0 }],
  },
  pillPlain: { backgroundColor: colors.raised },
  pillAccentText: { backgroundColor: colors.raised },
  pillAccent: {
    backgroundColor: colors.accentTint,
    borderWidth: 1.5,
    borderColor: colors.accent,
  },
  pillText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    letterSpacing: 0.3,
    includeFontPadding: false,
  },
  mark: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.text,
    borderWidth: 3,
    borderColor: colors.bg,
  },
  xCaption: {
    ...label(9, colors.dim, 0.14),
    position: 'absolute',
    left: space.xs,
    bottom: 0,
  },
});
