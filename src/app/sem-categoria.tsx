// Movements (any date) with receipt products still without a category — opened from the notice on Início.
// Choosing the category on the movement screen removes it from this list.

import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TransactionRow } from '@/components/transaction-row';
import { Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { chunks } from '@/lib/import-io';
import { useAccounts, useCategories, useUncategorised } from '@/lib/queries';
import { supabase } from '@/lib/supabase';
import type { Transaction } from '@/lib/types';

export default function SemCategoria() {
  const { index } = useCategories();
  const accounts = useAccounts();
  const loose = useUncategorised();
  const ids = [...(loose.data?.keys() ?? [])].sort();

  const list = useQuery({
    queryKey: ['transactions', 'sem-categoria', ids.join(',')],
    enabled: !!loose.data,
    queryFn: async () => {
      const out: Transaction[] = [];
      for (const part of chunks(ids, 100)) {
        const { data, error } = await supabase.from('transactions').select('*').in('id', part);
        if (error) throw new Error(error.message);
        out.push(...((data ?? []) as Transaction[]));
      }
      return out.sort((a, b) => b.date.localeCompare(a.date));
    },
  });

  const loading = loose.isLoading || list.isLoading;
  const error = loose.error ?? list.error;

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        <Muted>Toque num movimento e escolha a categoria de cada produto assinalado. Os outros produtos iguais passam a usar a mesma categoria.</Muted>
        {loading && <ActivityIndicator />}
        {error && <Text style={styles.error}>{error.message}</Text>}
        {!loading && !error && (list.data?.length ?? 0) === 0 && <Muted>Todos os produtos têm categoria.</Muted>}
        {(list.data?.length ?? 0) > 0 && (
          <Card style={{ gap: 0 }}>
            {list.data!.map((t, i) => (
              <View key={t.id} style={[styles.item, i > 0 && styles.divider]}>
                <TransactionRow tx={t} index={index} accounts={accounts.data} />
                <Text style={styles.names} numberOfLines={2}>
                  {loose.data?.get(t.id)?.join(' · ')}
                </Text>
              </View>
            ))}
          </Card>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: space.md },
  item: { paddingBottom: space.sm },
  names: { fontSize: 13, color: colors.ink, marginLeft: 52 },
  divider: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  error: { color: colors.danger },
});
