import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Line, Path, Polyline } from 'react-native-svg';

import { chartColors, colors, space } from '@/constants/theme';
import { formatDate, formatEUR } from '@/lib/format';

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

/**
 * Donut with a legend. Tap a segment or a legend row to select it (again to clear): the centre shows its amount and %,
 * the others fade, and the actions below let the parent drill into it or open it elsewhere.
 */
export function Donut({
  slices,
  size = 150,
  centerLabel,
  canDrill,
  onDrill,
  canOpen,
  onOpen,
  onSelect,
}: {
  slices: Slice[];
  size?: number;
  centerLabel: string;
  canDrill?: (key: string) => boolean;
  onDrill?: (key: string) => void;
  canOpen?: (key: string) => boolean;
  onOpen?: (key: string) => void;
  onSelect?: (key: string | null) => void; // the parent shows what is behind the selected slice
}) {
  const [sel, setSelState] = useState<string | null>(null);
  const setSel = (next: string | null | ((k: string | null) => string | null)) => {
    const v = typeof next === 'function' ? next(sel) : next;
    setSelState(v);
    if (v !== sel) onSelect?.(v);
  };
  const total = slices.reduce((s, x) => s + x.cents, 0);
  const stroke = 20;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const gap = slices.length > 1 ? 2 : 0; // 2px surface gap between segments
  const lengths = slices.map((s) => (total > 0 ? (s.cents / total) * c : 0));
  const offsets = lengths.map((_, i) => lengths.slice(0, i).reduce((a, b) => a + b, 0));
  const selected = slices.find((s) => s.key === sel) ?? null;
  const pct = (cents: number) => (total > 0 ? Math.round((cents / total) * 100) : 0);
  const toggle = (key: string) => setSel((k) => (k === key ? null : key));

  // which segment was touched: angle from 12 o'clock, clockwise (segments are drawn the same way)
  const touch = (e: GestureResponderEvent) => {
    // native: locationX/Y; web: a mouse event may only carry offsetX/Y
    const ne = e.nativeEvent as { locationX?: number; locationY?: number; offsetX?: number; offsetY?: number };
    const x = ne.locationX ?? ne.offsetX;
    const y = ne.locationY ?? ne.offsetY;
    if (x == null || y == null) return;
    const dx = x - size / 2;
    const dy = y - size / 2;
    const dist = Math.hypot(dx, dy);
    if (dist < r - stroke / 2 - 8 || dist > r + stroke / 2 + 8) return; // the hole or outside the ring
    let a = Math.atan2(dx, -dy);
    if (a < 0) a += 2 * Math.PI;
    const at = (a / (2 * Math.PI)) * c;
    const i = offsets.findIndex((o, j) => at >= o && at < o + lengths[j]);
    if (i >= 0) toggle(slices[i].key);
  };

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.donutRow}>
        <Pressable
          accessibilityLabel="Gráfico circular das despesas (a legenda tem os valores)"
          onPress={touch}
          style={{ width: size, height: size }}>
          {/* aria-hidden on a View, not on Svg (which forwards props to the DOM on web) */}
          <View aria-hidden pointerEvents="none">
            <Svg width={size} height={size}>
              {total === 0 && <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />}
              {slices.map((s, i) => {
                const dash = Math.max(0, lengths[i] - gap);
                const on = s.key === sel;
                return (
                  <Circle
                    key={s.key}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    stroke={s.color}
                    strokeWidth={on ? stroke + 6 : stroke}
                    strokeOpacity={sel && !on ? 0.3 : 1}
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
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            {selected ? (
              <>
                <Text style={[styles.centerSmall, { maxWidth: size - 2 * stroke - 12, textAlign: 'center' }]} numberOfLines={2}>
                  {selected.label}
                </Text>
                <Text style={styles.centerBig}>{formatEUR(selected.cents, { decimals: false })}</Text>
                <Text style={styles.centerSmall}>{pct(selected.cents)}%</Text>
              </>
            ) : (
              <>
                <Text style={styles.centerSmall}>{centerLabel}</Text>
                <Text style={styles.centerBig}>{formatEUR(total, { decimals: false })}</Text>
              </>
            )}
          </View>
        </Pressable>
        <View style={styles.legend}>
          {slices.length === 0 && <Text style={styles.legendText}>Sem despesas</Text>}
          {slices.map((s) => {
            const on = s.key === sel;
            return (
              <Pressable
                key={s.key}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${s.label}: ${formatEUR(s.cents)}, ${pct(s.cents)}%`}
                onPress={() => toggle(s.key)}
                style={[styles.legendRow, sel && !on && { opacity: 0.45 }]}>
                <View style={[styles.swatch, { backgroundColor: s.color }]} />
                <Text style={[styles.legendText, on && { fontWeight: '700' }]} numberOfLines={1}>
                  {s.label}
                </Text>
                <Text style={styles.legendPct}>{pct(s.cents)}%</Text>
                <Text style={styles.legendAmount}>{formatEUR(s.cents)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      {selected && ((onDrill && canDrill?.(selected.key)) || (onOpen && (canOpen?.(selected.key) ?? true))) && (
        <View style={styles.donutActions}>
          {onDrill && canDrill?.(selected.key) && (
            <Pressable accessibilityRole="button" onPress={() => (setSel(null), onDrill(selected.key))} style={styles.donutAction}>
              <Text style={styles.donutActionText}>Ver subcategorias ›</Text>
            </Pressable>
          )}
          {onOpen && (canOpen?.(selected.key) ?? true) && (
            <Pressable accessibilityRole="button" onPress={() => onOpen(selected.key)} style={styles.donutAction}>
              <Text style={styles.donutActionText}>Abrir no Explorar ›</Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Paired bars (income vs expense per month). Tapping a month selects it (parent decides what that means).
// ---------------------------------------------------------------------------
export type Pair = { key: string; label: string; a: number; b: number };

const roundedTop = (x: number, w: number, h: number, base: number) => {
  if (h <= 0) return '';
  const r = Math.min(3, w / 2, h);
  return `M${x},${base} V${base - h + r} Q${x},${base - h} ${x + r},${base - h} H${x + w - r} Q${x + w},${base - h} ${x + w},${base - h + r} V${base} Z`;
};

export function PairedBars({
  pairs,
  selected,
  onSelect,
  height = 150,
  labels,
  label,
}: {
  pairs: Pair[];
  selected: string;
  onSelect: (key: string) => void;
  height?: number;
  labels: [string, string];
  label: string;
}) {
  const [width, setWidth] = useState(0);
  const max = Math.max(1, ...pairs.flatMap((p) => [p.a, p.b]));
  const slot = pairs.length ? width / pairs.length : 0;
  const barW = Math.max(4, Math.min(16, slot * 0.3));
  const base = height - 2;
  const h = (v: number) => (v > 0 ? Math.max(2, (v / max) * (base - 6)) : 0);
  return (
    <View style={{ gap: space.sm }}>
      <View
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height }}
        accessibilityRole="image"
        accessibilityLabel={`${label}. ${pairs.map((p) => `${p.label}: ${labels[0]} ${formatEUR(p.a)}, ${labels[1]} ${formatEUR(p.b)}`).join('; ')}`}>
        {width > 0 && (
          <Svg width={width} height={height}>
            <Line x1={0} x2={width} y1={base} y2={base} stroke={chartColors.grid} strokeWidth={1} />
            {pairs.map((p, i) => {
              const cx = i * slot + slot / 2;
              const dim = p.key !== selected ? 0.45 : 1;
              return [
                <Path key={`${p.key}a`} d={roundedTop(cx - barW - 1, barW, h(p.a), base)} fill={chartColors.income} fillOpacity={dim} />,
                <Path key={`${p.key}b`} d={roundedTop(cx + 1, barW, h(p.b), base)} fill={chartColors.expense} fillOpacity={dim} />,
              ];
            })}
          </Svg>
        )}
        {width > 0 && (
          <View style={[StyleSheet.absoluteFill, styles.hitRow]}>
            {pairs.map((p) => (
              <Pressable key={p.key} style={{ width: slot, height }} onPress={() => onSelect(p.key)} accessibilityRole="button" accessibilityLabel={`Ver ${p.label}`} />
            ))}
          </View>
        )}
      </View>
      <View style={styles.axis}>
        {pairs.map((p) => (
          <Text key={p.key} style={[styles.tick, { width: slot }, p.key === selected && styles.tickSel]} numberOfLines={1}>
            {p.label}
          </Text>
        ))}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Price line: one point per purchase, first and last price labelled.
// ---------------------------------------------------------------------------
export function PriceLine({ points, height = 100, label }: { points: { date: string; cents: number }[]; height?: number; label: string }) {
  const [width, setWidth] = useState(0);
  const vals = points.map((p) => p.cents);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const pad = 14;
  const top = 18;
  const base = height - 6;
  const x = (i: number) => (points.length === 1 ? width / 2 : pad + (i / (points.length - 1)) * (width - 2 * pad));
  const y = (v: number) => (hi === lo ? (top + base) / 2 : base - ((v - lo) / (hi - lo)) * (base - top));
  const last = points.length - 1;
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{ height }}
      accessibilityRole="image"
      accessibilityLabel={`${label}: ${points.map((p) => `${formatDate(p.date)} ${formatEUR(p.cents)}`).join(', ')}`}>
      {width > 0 && points.length > 0 && (
        <View aria-hidden>
          <Svg width={width} height={height}>
            <Line x1={0} x2={width} y1={base} y2={base} stroke={chartColors.grid} strokeWidth={1} />
            <Polyline
              points={points.map((p, i) => `${x(i)},${y(p.cents)}`).join(' ')}
              fill="none"
              stroke={chartColors.bar}
              strokeWidth={2.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map((p, i) => (
              <Circle key={i} cx={x(i)} cy={y(p.cents)} r={i === last ? 4.5 : 3} fill={chartColors.bar} />
            ))}
          </Svg>
        </View>
      )}
      {width > 0 && points.length > 0 && (
        <>
          <Text style={[styles.priceTag, { left: Math.max(0, x(0) - 4), top: Math.max(0, y(points[0].cents) - 18) }]}>{formatEUR(points[0].cents)}</Text>
          {last > 0 && (
            <Text style={[styles.priceTag, styles.priceTagLast, { right: Math.max(0, width - x(last) - 4), top: Math.max(0, y(points[last].cents) - 20) }]}>
              {formatEUR(points[last].cents)}
            </Text>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  readout: { fontSize: 13, color: colors.muted },
  axis: { flexDirection: 'row' },
  hitRow: { flexDirection: 'row' },
  tick: { fontSize: 11, color: colors.muted, textAlign: 'center' },
  tickSel: { color: colors.ink, fontWeight: '700' },
  priceTag: { position: 'absolute', fontSize: 11, color: colors.muted },
  priceTagLast: { color: colors.ink, fontWeight: '600' },
  donutRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.md },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerSmall: { fontSize: 11, color: colors.muted },
  centerBig: { fontSize: 17, fontWeight: '700', color: colors.ink },
  donutActions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  donutAction: { minHeight: 40, paddingHorizontal: space.md, borderRadius: 10, backgroundColor: colors.accentSoft, justifyContent: 'center' },
  donutActionText: { fontSize: 14, fontWeight: '600', color: colors.accent },
  legend: { flex: 1, minWidth: 160, gap: space.sm },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 24 },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  legendText: { flex: 1, fontSize: 13, color: colors.ink },
  legendPct: { fontSize: 12, color: colors.muted },
  legendAmount: { fontSize: 13, fontWeight: '600', color: colors.ink, minWidth: 76, textAlign: 'right' },
});
