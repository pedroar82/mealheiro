import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Chip, Segmented } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { addDays, formatDate, fromISO, MONTHS, MONTHS_SHORT, monthEnd, monthStart, todayISO, toISO } from '@/lib/format';

export type Month = { year: number; month0: number };
export type Range = { from: string; to: string };

export function useMonth() {
  const now = new Date();
  const [m, setM] = useState<Month>({ year: now.getFullYear(), month0: now.getMonth() });
  const shift = (delta: number) =>
    setM(({ year, month0 }) => {
      const d = new Date(year, month0 + delta, 1);
      return { year: d.getFullYear(), month0: d.getMonth() };
    });
  const isCurrent = m.year === now.getFullYear() && m.month0 === now.getMonth();
  return { ...m, from: monthStart(m.year, m.month0), to: monthEnd(m.year, m.month0), shift, setMonth: setM, isCurrent };
}

/** A month (arrows) or, when `range` is set, a custom period chosen on the calendar. */
export function usePeriod() {
  const month = useMonth();
  const [range, setRange] = useState<Range | null>(null);
  return {
    month,
    range,
    setRange,
    from: range?.from ?? month.from,
    to: range?.to ?? month.to,
  };
}

type MonthProps = ReturnType<typeof useMonth>;

/** Month title with arrows; tapping the title opens a grid of months (Início). */
export function MonthSwitcher(props: MonthProps) {
  return <PeriodSwitcher month={props} range={null} />;
}

/** Same, plus a custom period (Movimentos). */
export function PeriodSwitcher({ month, range, setRange }: { month: MonthProps; range: Range | null; setRange?: (r: Range | null) => void }) {
  const [open, setOpen] = useState(false);
  const { year, month0, shift, isCurrent } = month;
  const label = range ? `${formatDate(range.from)} – ${formatDate(range.to)}` : `${MONTHS[month0]} ${year}`;

  return (
    <View style={styles.row}>
      {range ? (
        <View style={styles.arrow} />
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel="Mês anterior" onPress={() => shift(-1)} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. Escolher ${setRange ? 'período' : 'mês'}`}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.labelBtn, pressed && { opacity: 0.6 }]}>
        <Text style={[styles.label, range && styles.labelRange]} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.caret}>▾</Text>
      </Pressable>
      {range ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Voltar ao mês" onPress={() => setRange?.(null)} style={styles.arrow}>
          <Text style={styles.clear}>✕</Text>
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Mês seguinte"
          accessibilityState={{ disabled: isCurrent }}
          disabled={isCurrent}
          onPress={() => shift(1)}
          style={[styles.arrow, isCurrent && { opacity: 0.3 }]}>
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      )}
      {open && (
        <PeriodSheet
          month={month}
          range={range}
          allowRange={!!setRange}
          onClose={() => setOpen(false)}
          onMonth={(m) => {
            month.setMonth(m);
            setRange?.(null);
            setOpen(false);
          }}
          onRange={(r) => {
            setRange?.(r);
            setOpen(false);
          }}
        />
      )}
    </View>
  );
}

function PeriodSheet({
  month,
  range,
  allowRange,
  onClose,
  onMonth,
  onRange,
}: {
  month: MonthProps;
  range: Range | null;
  allowRange: boolean;
  onClose: () => void;
  onMonth: (m: Month) => void;
  onRange: (r: Range) => void;
}) {
  // read outside the Modal: inside it the insets come back as 0 (see the category picker)
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<'month' | 'range'>(range ? 'range' : 'month');

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={[styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
        <View style={styles.sheetHeader}>
          <Text style={styles.sheetTitle}>{allowRange ? 'Escolher período' : 'Escolher mês'}</Text>
          <Pressable accessibilityRole="button" onPress={onClose} style={styles.close}>
            <Text style={styles.closeText}>Fechar</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
          {allowRange && (
            <Segmented
              options={[
                { value: 'month', label: 'Mês' },
                { value: 'range', label: 'Personalizado' },
              ]}
              value={tab}
              onChange={setTab}
            />
          )}
          {tab === 'month' ? <MonthGrid month={month} onPick={onMonth} /> : <RangeCalendar initial={range ?? { from: month.from, to: month.to }} onApply={onRange} />}
        </ScrollView>
      </View>
    </Modal>
  );
}

function MonthGrid({ month, onPick }: { month: MonthProps; onPick: (m: Month) => void }) {
  const now = new Date();
  const [year, setYear] = useState(month.year);
  return (
    <View style={{ gap: space.md }}>
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Ano anterior" onPress={() => setYear((y) => y - 1)} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
        <Text style={styles.label}>{year}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Ano seguinte"
          disabled={year >= now.getFullYear()}
          onPress={() => setYear((y) => y + 1)}
          style={[styles.arrow, year >= now.getFullYear() && { opacity: 0.3 }]}>
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {MONTHS_SHORT.map((name, m0) => {
          const future = year > now.getFullYear() || (year === now.getFullYear() && m0 > now.getMonth());
          const on = year === month.year && m0 === month.month0;
          return (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`${MONTHS[m0]} ${year}`}
              accessibilityState={{ selected: on, disabled: future }}
              disabled={future}
              onPress={() => onPick({ year, month0: m0 })}
              style={[styles.monthCell, on && styles.cellOn, future && { opacity: 0.3 }]}>
              <Text style={[styles.cellText, on && styles.cellTextOn]}>{name}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const WEEK = ['S', 'T', 'Q', 'Q', 'S', 'S', 'D']; // Monday first

function RangeCalendar({ initial, onApply }: { initial: Range; onApply: (r: Range) => void }) {
  const today = todayISO();
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string | null>(initial.to > today ? today : initial.to);
  const start = fromISO(initial.from);
  const [view, setView] = useState<Month>({ year: start.getFullYear(), month0: start.getMonth() });

  const tap = (iso: string) => {
    // first tap starts a new period, second tap closes it (either order)
    if (to) {
      setFrom(iso);
      setTo(null);
    } else if (iso < from) {
      setTo(from);
      setFrom(iso);
    } else setTo(iso);
  };

  const preset = (r: Range) => {
    setFrom(r.from);
    setTo(r.to);
    const d = fromISO(r.to);
    setView({ year: d.getFullYear(), month0: d.getMonth() });
  };
  const y = new Date().getFullYear();

  const first = monthStart(view.year, view.month0);
  const lead = (fromISO(first).getDay() + 6) % 7;
  const days = Number(monthEnd(view.year, view.month0).slice(8));
  const cells: (string | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => addDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const move = (delta: number) =>
    setView(({ year, month0 }) => {
      const d = new Date(year, month0 + delta, 1);
      return { year: d.getFullYear(), month0: d.getMonth() };
    });
  const atEnd = first >= monthStart(new Date().getFullYear(), new Date().getMonth());

  return (
    <View style={{ gap: space.md }}>
      <View style={styles.chips}>
        <Chip label="Últimos 7 dias" onPress={() => preset({ from: addDays(today, -6), to: today })} />
        <Chip label="Últimos 30 dias" onPress={() => preset({ from: addDays(today, -29), to: today })} />
        <Chip label="Últimos 3 meses" onPress={() => preset({ from: toISO(new Date(y, new Date().getMonth() - 2, 1)), to: today })} />
        <Chip label="Este ano" onPress={() => preset({ from: `${y}-01-01`, to: today })} />
        <Chip label="Ano passado" onPress={() => preset({ from: `${y - 1}-01-01`, to: `${y - 1}-12-31` })} />
      </View>

      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel="Mês anterior" onPress={() => move(-1)} style={styles.arrow}>
          <Text style={styles.arrowText}>‹</Text>
        </Pressable>
        <Text style={styles.label}>
          {MONTHS[view.month0]} {view.year}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Mês seguinte" disabled={atEnd} onPress={() => move(1)} style={[styles.arrow, atEnd && { opacity: 0.3 }]}>
          <Text style={styles.arrowText}>›</Text>
        </Pressable>
      </View>

      <View>
        <View style={styles.week}>
          {WEEK.map((w, i) => (
            <Text key={i} style={styles.weekday}>
              {w}
            </Text>
          ))}
        </View>
        <View style={styles.week}>
          {cells.map((iso, i) => {
            if (!iso) return <View key={i} style={styles.day} />;
            const future = iso > today;
            const edge = iso === from || iso === to;
            const inside = to != null && iso > from && iso < to;
            return (
              <Pressable
                key={iso}
                accessibilityRole="button"
                accessibilityLabel={formatDate(iso)}
                accessibilityState={{ selected: edge || inside, disabled: future }}
                disabled={future}
                onPress={() => tap(iso)}
                style={[styles.day, inside && styles.dayInside, edge && styles.dayEdge, future && { opacity: 0.3 }]}>
                <Text style={[styles.dayText, edge && styles.cellTextOn]}>{Number(iso.slice(8))}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={styles.summary} accessibilityLiveRegion="polite">
        {to ? `De ${formatDate(from)} a ${formatDate(to)}` : `De ${formatDate(from)} a … (toque no último dia)`}
      </Text>
      <Button label="Aplicar" disabled={!to} onPress={() => to && onApply({ from, to })} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  arrowText: { fontSize: 28, color: colors.ink, lineHeight: 30 },
  clear: { fontSize: 18, color: colors.muted },
  labelBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1, minHeight: 44, paddingHorizontal: space.sm },
  label: { fontSize: 20, fontWeight: '700', color: colors.ink },
  labelRange: { fontSize: 16 },
  caret: { fontSize: 14, color: colors.muted },
  sheet: { flex: 1, backgroundColor: colors.ground },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingVertical: space.sm },
  sheetTitle: { fontSize: 17, fontWeight: '700', color: colors.ink },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  closeText: { fontSize: 16, fontWeight: '600', color: colors.accent },
  body: { padding: space.md, gap: space.md, width: '100%', maxWidth: 520, alignSelf: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  monthCell: { width: '31%', flexGrow: 1, minHeight: 52, borderRadius: radius.md, backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center' },
  cellOn: { backgroundColor: colors.accent },
  cellText: { fontSize: 16, fontWeight: '600', color: colors.ink },
  cellTextOn: { color: '#fff' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  week: { flexDirection: 'row', flexWrap: 'wrap' },
  weekday: { width: `${100 / 7}%`, textAlign: 'center', fontSize: 12, fontWeight: '600', color: colors.muted, paddingVertical: 4 },
  day: { width: `${100 / 7}%`, aspectRatio: 1, maxHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm },
  dayInside: { backgroundColor: colors.accentSoft },
  dayEdge: { backgroundColor: colors.accent },
  dayText: { fontSize: 15, color: colors.ink },
  summary: { fontSize: 15, fontWeight: '600', color: colors.ink, textAlign: 'center' },
});
