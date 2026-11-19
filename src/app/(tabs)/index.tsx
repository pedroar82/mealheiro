import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { BarChart, Donut, type Bar, type Slice } from '@/components/charts';
import { MonthSwitcher, useMonth } from '@/components/month-switcher';
import { Screen } from '@/components/screen';
import { TransactionRow } from '@/components/transaction-row';
import { Card, Muted, Segmented } from '@/components/ui';
import { colors, otherSeries, seriesPalette, space } from '@/constants/theme';
import { rootOf } from '@/lib/categories';
import { MONTHS_SHORT, WEEKDAYS_SHORT, addDays, formatEUR, fromISO, monthEnd, monthStart, startOfWeek, todayISO } from '@/lib/format';
import { useAccounts, useCategories, useSpendFacts, useTransactions } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

type Period = 'week' | 'month' | 'year';

export default function Inicio() {
  const month = useMonth();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<Period>('week');
  const { index } = useCategories();
  const accounts = useAccounts();

  const today = todayISO();
  const ref = month.isCurrent ? today : month.to; // anchor for "this week" / last 12 months
  const weekStart = startOfWeek(ref);
  const yearFrom = monthStart(month.year, month.month0 - 11);
  const rangeTo = [month.to, addDays(weekStart, 6)].sort().at(-1)!;

  const tx = useTransactions(month.from, month.to);
  const facts = useSpendFacts([yearFrom, weekStart].sort()[0], rangeTo);

  const income = (tx.data ?? []).filter((t) => t.kind === 'income').reduce((s, t) => s + t.amount_cents, 0);
  const monthFacts = useMemo(() => (facts.data ?? []).filter((f) => f.date >= month.from && f.date <= month.to), [facts.data, month.from, month.to]);
  const spent = monthFacts.reduce((s, f) => s + f.amount_cents, 0);
  const balance = income - spent;

  const bars: Bar[] = useMemo(() => {
    const sumBetween = (a: string, b: string) =>
      (facts.data ?? []).filter((f) => f.date >= a && f.date <= b).reduce((s, f) => s + f.amount_cents, 0);
    if (period === 'week') {
      return Array.from({ length: 7 }, (_, i) => {
        const d = addDays(weekStart, i);
        return { key: d, label: WEEKDAYS_SHORT[fromISO(d).getDay()], cents: Math.max(0, sumBetween(d, d)), current: d === today };
      });
    }
    if (period === 'month') {
      const out: Bar[] = [];
      for (let s = startOfWeek(month.from), n = 1; s <= month.to; s = addDays(s, 7), n++) {
        const a = s < month.from ? month.from : s;
        const e = addDays(s, 6) > month.to ? month.to : addDays(s, 6);
        out.push({ key: s, label: `S${n}`, cents: Math.max(0, sumBetween(a, e)), current: today >= a && today <= e });
      }
      return out;
    }
    return Array.from({ length: 12 }, (_, i) => {
      const d = new Date(month.year, month.month0 - 11 + i, 1);
      const a = monthStart(d.getFullYear(), d.getMonth());
      return { key: a, label: MONTHS_SHORT[d.getMonth()], cents: Math.max(0, sumBetween(a, monthEnd(d.getFullYear(), d.getMonth()))), current: i === 11 };
    });
  }, [period, facts.data, weekStart, today, month.from, month.to, month.year, month.month0]);

  const periodTotal = bars.reduce((s, b) => s + b.cents, 0);

  // Top 4 root categories by spend, the rest folded into "Outras" (fixed colour order).
  const slices: Slice[] = useMemo(() => {
    const byRoot = new Map<string, number>();
    for (const f of monthFacts) {
      const root = rootOf(index, f.category_id) ?? 'none';
      byRoot.set(root, (byRoot.get(root) ?? 0) + f.amount_cents);
    }
    const sorted = [...byRoot.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, 4).map(([id, cents], i) => ({
      key: id,
      label: id === 'none' ? 'Por categorizar' : index.byId.get(id)?.name ?? '—',
      cents,
      color: seriesPalette[i],
    }));
    const rest = sorted.slice(4).reduce((s, [, v]) => s + v, 0);
    return rest > 0 ? [...top, { key: 'other', label: 'Outras', cents: rest, color: otherSeries }] : top;
  }, [monthFacts, index]);

  const recent = (tx.data ?? []).slice(0, 5);
  const loading = tx.isLoading || facts.isLoading;
  const pctSpent = income > 0 ? Math.min(100, Math.round((spent / income) * 100)) : null;

  return (
    <Screen title="Início">
      <MonthSwitcher {...month} />
      {(tx.error || facts.error) && <Text style={styles.error}>{(tx.error ?? facts.error)!.message}</Text>}

      <View style={styles.hero}>
        <Text style={styles.heroLabel}>Saldo do mês</Text>
        <Text style={styles.heroValue}>{loading ? '…' : formatEUR(balance)}</Text>
        {pctSpent !== null && (
          <View style={styles.track} accessibilityLabel={`Gastou ${pctSpent}% das receitas`}>
            <View style={[styles.fill, { width: `${pctSpent}%` }]} />
          </View>
        )}
        <View style={styles.heroRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroSmall}>Receitas</Text>
            <Text style={styles.heroNum}>{formatEUR(income)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroSmall}>Despesas{pctSpent !== null ? ` · ${pctSpent}%` : ''}</Text>
            <Text style={styles.heroNum}>{formatEUR(spent)}</Text>
          </View>
        </View>
      </View>

      <Card>
        <Segmented
          options={[
            { value: 'week', label: 'Semana' },
            { value: 'month', label: 'Mês' },
            { value: 'year', label: 'Ano' },
          ]}
          value={period}
          onChange={setPeriod}
        />
        <View>
          <Text style={styles.cardCaption}>
            {period === 'week' ? 'Despesas por dia · semana' : period === 'month' ? 'Despesas por semana · mês' : 'Despesas por mês · 12 meses'}
          </Text>
          <Text style={styles.cardTotal}>{formatEUR(periodTotal)}</Text>
        </View>
        {loading ? <ActivityIndicator /> : <BarChart key={period + month.from} bars={bars} label="Despesas" />}
      </Card>

      <Card>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Para onde foi</Text>
          <Link href="/explorar" style={styles.link}>Explorar</Link>
        </View>
        <Donut slices={slices} centerLabel="Gasto" />
      </Card>

      <Card style={{ gap: 0 }}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>Recentes</Text>
          <Link href="/movimentos" style={styles.link}>Ver todos</Link>
        </View>
        {recent.length === 0 && !loading && <Muted>Ainda sem movimentos neste mês. Use o separador Adicionar.</Muted>}
        {recent.map((t, i) => (
          <View key={t.id} style={i > 0 && styles.divider}>
            <TransactionRow tx={t} index={index} accounts={accounts.data} />
          </View>
        ))}
      </Card>

      <Pressable
        accessibilityRole="button"
        onPress={async () => {
          await supabase.auth.signOut();
          qc.clear();
        }}
        style={styles.signOut}>
        <Text style={styles.link}>Terminar sessão</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { color: colors.danger },
  hero: { backgroundColor: colors.ink, borderRadius: 20, padding: 20, gap: space.md },
  heroLabel: { fontSize: 13, color: '#C9CDD6' },
  heroValue: { fontSize: 34, fontWeight: '700', color: '#fff' },
  track: { height: 8, backgroundColor: '#3A3F4B', borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, backgroundColor: '#F2A65A', borderRadius: 4 },
  heroRow: { flexDirection: 'row', gap: space.md },
  heroSmall: { fontSize: 12, color: '#C9CDD6' },
  heroNum: { fontSize: 18, fontWeight: '600', color: '#fff' },
  cardCaption: { fontSize: 13, color: colors.muted },
  cardTotal: { fontSize: 24, fontWeight: '700', color: colors.ink },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  cardTitle: { fontSize: 16, fontWeight: '600', color: colors.ink },
  link: { fontSize: 14, fontWeight: '600', color: colors.accent, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  signOut: { alignSelf: 'center', minHeight: 44, justifyContent: 'center' },
});
