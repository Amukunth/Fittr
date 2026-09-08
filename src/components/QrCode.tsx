import React, { useMemo } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import QRCode from 'qrcode';
import { colors, radius, space } from '../theme/tokens';

/** One horizontal stretch of same-coloured modules. */
interface Run {
  dark: boolean;
  length: number;
}

interface Matrix {
  rows: Run[][];
  /** Side of one module, in px. */
  cell: number;
  /** Side of the whole symbol, in px. */
  side: number;
}

function encode(value: string, size: number): Matrix | null {
  let modules: { size: number; data: Uint8Array };
  try {
    modules = QRCode.create(value, { errorCorrectionLevel: 'M' }).modules;
  } catch {
    // Empty input or more data than a QR code can hold. Nothing to draw.
    return null;
  }
  const n = modules.size;
  const cell = Math.round((size / n) * 100) / 100;
  const rows: Run[][] = [];
  for (let y = 0; y < n; y += 1) {
    const runs: Run[] = [];
    for (let x = 0; x < n; x += 1) {
      const dark = modules.data[y * n + x] === 1;
      const last = runs[runs.length - 1];
      if (last && last.dark === dark) {
        last.length += 1;
      } else {
        runs.push({ dark, length: 1 });
      }
    }
    rows.push(runs);
  }
  return { rows, cell, side: cell * n };
}

/**
 * A QR code drawn from plain Views: no SVG runtime or canvas is linked in
 * this app. Each row of modules is a flex row of equal-height rectangles,
 * adjacent same-coloured modules merged into one View so a 41-module
 * symbol is a few hundred nodes rather than 1,700. The light frame is the
 * one deliberately light surface in the app: scanners need a pale quiet
 * zone around the symbol, so it is an image, not a background, and it
 * belongs inside a card.
 */
export function QrCode({
  value,
  size = 200,
  color = colors.onAccent,
  background = colors.text,
}: {
  value: string;
  size?: number;
  color?: string;
  background?: string;
}) {
  const matrix = useMemo(() => encode(value, size), [value, size]);

  if (!matrix) {
    return null;
  }

  const frame: ViewStyle = { backgroundColor: background };
  const symbol: ViewStyle = { width: matrix.side, height: matrix.side };
  const rowStyle: ViewStyle = { height: matrix.cell };

  return (
    <View
      style={[styles.frame, frame]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="QR code"
    >
      <View style={symbol}>
        {matrix.rows.map((runs, y) => (
          <View key={y} style={[styles.row, rowStyle]}>
            {runs.map((run, i) => {
              const cellStyle: ViewStyle = {
                width: matrix.cell * run.length,
                height: matrix.cell,
                backgroundColor: run.dark ? color : background,
              };
              return <View key={i} style={cellStyle} />;
            })}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: space.md,
    borderRadius: radius.control,
    alignSelf: 'center',
  },
  row: { flexDirection: 'row' },
});
