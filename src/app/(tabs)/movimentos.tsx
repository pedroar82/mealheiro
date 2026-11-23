import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import { MonthSwitcher, useMonth } from '@/components/month-switcher';
import { Screen } from '@/components/screen';
import { myCost } from '@/lib/shared';
import { TransactionRow } from '@/components/transaction-row';
import { Card, Chip, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { formatDayShort, formatEUR } from '@/lib/format';
import { useAccounts, useCategories, useTransactions } from '@/lib/queries';
import type { Transaction } from '@/lib/types';

type Filter = 'all' | 'expense' | 'income' | 'review';

export default function Movimentos() {
  const month = useMonth();
  const tx = useTransactions(month.from, month.to);
  const { index } = useCategories();
  const accounts = useAccounts();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (tx.data ?? []).filter((t) => {
      if (filter === 'expense' && t.kind !== 'expense') return false;
      if (filter === 'income' && t.kind !== 'income') return false;
      if (filter === 'review' && !(t.needs_review || (!t.category_id && t.kind !== 'transfer' && t.kind !== 'refund' && t.kind !== 'settlement' && t.kind !== 'payback'))) return false;
      if (!q) return true;
      return [t.description, categoryPath(index, t.category_id)].some((s) => s?.toLowerCase().includes(q));
    });
    const byDay = new Map<string, Transaction[]>();
    for (const t of list) {
      if (!byDay.has(t.date)) byDay.set(t.date, []);
      byDay.get(t.date)!.push(t);
    }
    return [...byDay.entries()].map(([date, items]) => ({
      date,
      items,
      spent: items.reduce((s, t) => s + (t.kind === 'expense' ? myCost(t) : t.kind === 'refund' ? -t.amount_cents : 0), 0),
    }));
  }, [tx.data, query, filter, index]);

  return (
    <Screen title="Movimentos">
      <MonthSwitcher {...month} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="Procurar descrição ou categoria"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Procurar movimentos"
        style={styles.search}
      />
      <View style={styles.chips}>
        <Chip label="Todos" selected={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="Despesas" selected={filter === 'expense'} onPress={() => setFilter('expense')} />
        <Chip label="Receitas" selected={filter === 'income'} onPress={() => setFilter('income')} />
        <Chip label="Por categorizar" selected={filter === 'review'} onPress={() => setFilter('review')} />
      </View>

      {tx.isLoading && <ActivityIndicator />}
      {tx.error && <Text style={styles.error}>{tx.error.message}</Text>}
      {!tx.isLoading && groups.length === 0 && <Muted>Sem movimentos neste mês.</Muted>}

      {groups.map((g) => (
        <Card key={g.date} style={styles.group}>
          <View style={styles.dayHeader}>
            <Text style={styles.day}>{formatDayShort(g.date)}</Text>
            {g.spent > 0 && <Text style={styles.daySpent}>{formatEUR(g.spent)}</Text>}
          </View>
          {g.items.map((t, i) => (
            <View key={t.id} style={i > 0 && styles.divider}>
              <TransactionRow tx={t} index={index} accounts={accounts.data} />
            </View>
          ))}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { minHeight: 48, borderRadius: radius.md, borderWidth: 1, borderColor: '#D5D8DF', backgroundColor: colors.card, paddingHorizontal: 14, fontSize: 15, color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  group: { gap: 0, paddingVertical: space.sm },
  dayHeader: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: space.xs },
  day: { fontSize: 13, fontWeight: '600', color: colors.muted },
  daySpent: { fontSize: 13, color: colors.muted },
  divider: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  error: { color: colors.danger },
});
