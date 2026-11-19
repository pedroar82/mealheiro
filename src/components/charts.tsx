import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { chartColors, colors, space } from '@/constants/theme';
import { formatEUR } from '@/lib/format';

// ---------------------------------------------------------------------------
// Bar chart: one series, rounded data-ends on the baseline, tap a bar to read it.
// The selected bar (default: the one marked `current`, else the max) shows its value.
// ---------------------------------------------------------------------------
export type Bar = { key: string; label: string; cents: number; current?: boolean };

export function BarChart({ bars, height = 150, label }: { bars: Bar[]; height?: number; label: string }) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const max = Math.max(0, ...bars.map((b) => b.cents));
  const fallback = bars.find((b) => b.current) ?? bars.find((b) => b.cents === max && max > 0);
  const sel = bars.find((b) => b.key === selected) ?? fallback;

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const slot = bars.length ? width / bars.length : 0;
  const barW = Math.max(4, Math.min(28, slot * 0.6));
  const plotH = height - 4;

  return (
    <View style={{ gap: space.sm }}>
      <Text style={styles.readout} accessibilityLiveRegion="polite">
        {sel ? `${sel.label}: ${formatEUR(sel.cents)}` : 'Sem despesas'}
      </Text>
      <View onLayout={onLayout} style={{ height }} accessibilityRole="image" accessibilityLabel={`${label}. ${bars.map((b) => `${b.label} ${formatEUR(b.cents)}`).join(', ')}`}>
        {width > 0 && (
          <Svg width={width} height={height}>
            <Line x1={0} x2={width} y1={plotH} y2={plotH} stroke={chartColors.grid} strokeWidth={1} />
            {bars.map((b, i) => {
              const h = max > 0 ? Math.max(b.cents > 0 ? 3 : 0, (b.cents / max) * (plotH - 8)) : 0;
              const x = i * slot + (slot - barW) / 2;
              const isSel = sel?.key === b.key;
              const r = Math.min(4, barW / 2, h);
              // rounded top, square bottom on the baseline
              const d = h > 0
                ? `M${x},${plotH} V${plotH - h + r} Q${x},${plotH - h} ${x + r},${plotH - h} H${x + barW - r} Q${x + barW},${plotH - h} ${x + barW},${plotH - h + r} V${plotH} Z`
                : '';
              return d ? <Path key={b.key} d={d} fill={isSel ? chartColors.bar : chartColors.barMuted} /> : null;
            })}
          </Svg>
        )}
        {/* hit targets larger than the marks; Pressable instead of SVG onPress (which leaks responder props to the DOM on web) */}
        {width > 0 && (
          <View style={[StyleSheet.absoluteFill, styles.hitRow]}>
            {bars.map((b) => (
              <Pressable key={b.key} style={{ width: slot, height }} onPress={() => setSelected(b.key)} accessible={false} />
            ))}
          </View>
        )}
      </View>
      <View style={styles.axis}>
        {bars.map((b, i) => {
          // thin out labels when there are many bars (e.g. days of a month)
          const every = bars.length > 12 ? 5 : 1;
          const show = i % every === 0 || i === bars.length - 1;
          return (
            <Text key={b.key} style={[styles.tick, { width: slot }]} numberOfLines={1}>
              {show ? b.label : ''}
            </Text>
          );
        })}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Donut + legend with amounts (the legend doubles as the table view).
// ---------------------------------------------------------------------------
export type Slice = { key: string; label: string; cents: number; color: string };

export function Donut({ slices, size = 150, centerLabel }: { slices: Slice[]; size?: number; centerLabel: string }) {
  const total = slices.reduce((s, x) => s + x.cents, 0);
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0; // 2px surface gap between segments
  const lengths = slices.map((s) => (total > 0 ? (s.cents / total) * c : 0));
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));

  return (
    <View style={styles.donutRow}>
      <View style={{ width: size, height: size }}>
        {/* decorative: the legend carries the data. aria-hidden on a View, not on Svg (which forwards props to the DOM on web) */}
        <View aria-hidden>
        <Svg width={size} height={size}>
            {total === 0 && <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />}
            {slices.map((s, i) => {
              const dash = Math.max(0, lengths[i] - gap);
              return (
                <Circle
                  key={s.key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  stroke={s.color}
                  strokeWidth={stroke}
                  fill="none"
                  strokeDasharray={`${dash} ${c - dash}`}
                  // circle strokes start at 3 o'clock; +c/4 starts the first segment at 12 o'clock
                  // (instead of a <G rotation>, whose origin prop leaks as `transform-origin` on web)
                  strokeDashoffset={c / 4 - offsets[i]}
                />
              );
            })}
        </Svg>
        </View>
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={styles.centerSmall}>{centerLabel}</Text>
          <Text style={styles.centerBig}>{formatEUR(total, { decimals: false })}</Text>
        </View>
      </View>
      <View style={styles.legend}>
        {slices.length === 0 && <Text style={styles.legendText}>Sem despesas</Text>}
        {slices.map((s) => (
          <Pressable key={s.key} accessible accessibilityLabel={`${s.label}: ${formatEUR(s.cents)}, ${Math.round((s.cents / total) * 100)}%`} style={styles.legendRow}>
            <View style={[styles.swatch, { backgroundColor: s.color }]} />
            <Text style={styles.legendText} numberOfLines={1}>{s.label}</Text>
            <Text style={styles.legendPct}>{Math.round((s.cents / total) * 100)}%</Text>
            <Text style={styles.legendAmount}>{formatEUR(s.cents)}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { fontSize: 13, color: colors.muted },
  axis: { flexDirection: 'row' },
  hitRow: { flexDirection: 'row' },
  tick: { fontSize: 11, color: colors.muted, textAlign: 'center' },
  donutRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerSmall: { fontSize: 11, color: colors.muted },
  centerBig: { fontSize: 17, fontWeight: '700', color: colors.ink },
  legend: { flex: 1, minWidth: 160, gap: space.sm },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendText: { flex: 1, fontSize: 13, color: colors.ink },
  legendPct: { fontSize: 12, color: colors.muted },
  legendAmount: { fontSize: 13, fontWeight: '600', color: colors.ink, minWidth: 76, textAlign: 'right' },
});
