import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/theme';
import { MONTHS, monthEnd, monthStart } from '@/lib/format';

export type Month = { year: number; month0: number };

export function useMonth() {
  const now = new Date();
  const [m, setM] = useState<Month>({ year: now.getFullYear(), month0: now.getMonth() });
  const shift = (delta: number) =>
    setM(({ year, month0 }) => {
      const d = new Date(year, month0 + delta, 1);
      return { year: d.getFullYear(), month0: d.getMonth() };
    });
  const isCurrent = m.year === now.getFullYear() && m.month0 === now.getMonth();
  return { ...m, from: monthStart(m.year, m.month0), to: monthEnd(m.year, m.month0), shift, isCurrent };
}

export function MonthSwitcher({ year, month0, shift, isCurrent }: ReturnType<typeof useMonth>) {
  return (
    <View style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel="Mês anterior" onPress={() => shift(-1)} style={styles.arrow}>
        <Text style={styles.arrowText}>‹</Text>
      </Pressable>
      <Text accessibilityRole="header" style={styles.label}>
        {MONTHS[month0]} {year}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Mês seguinte"
        accessibilityState={{ disabled: isCurrent }}
        disabled={isCurrent}
        onPress={() => shift(1)}
        style={[styles.arrow, isCurrent && { opacity: 0.3 }]}>
        <Text style={styles.arrowText}>›</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  arrowText: { fontSize: 28, color: colors.ink, lineHeight: 30 },
  label: { fontSize: 20, fontWeight: '700', color: colors.ink },
});
