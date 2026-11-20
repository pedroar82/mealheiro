import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TransactionForm } from '@/components/transaction-form';
import { Button, Card, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { findMatches, mergeReceiptInto } from '@/lib/receipt';
import { supabase } from '@/lib/supabase';
import { useCategories, useDeleteTransaction, useLineItems, useSaveTransaction, useTransaction } from '@/lib/queries';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Registo manual',
  receipt: 'Talão digitalizado',
  pdf: 'Fatura PDF',
  excel: 'Importado do Excel',
  bank_csv: 'Extrato bancário',
};

export default function EditMovimento() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const tx = useTransaction(id);
  const save = useSaveTransaction();
  const del = useDeleteTransaction();
  const [confirm, setConfirm] = useState(false);
  const lines = useLineItems(id);
  const { index } = useCategories();
  const qc = useQueryClient();
  const [merging, setMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const t = tx.data;
  const fromReceipt = t?.source === 'receipt' || t?.source === 'pdf';
  const matches = useQuery({
    queryKey: ['matches', id, t?.date, t?.amount_cents],
    enabled: !!t && fromReceipt,
    queryFn: () => findMatches(t!.date, t!.amount_cents, id),
  });
  const store = useQuery({
    queryKey: ['store', t?.store_id],
    enabled: !!t?.store_id,
    queryFn: async () => (await supabase.from('stores').select('name, locality').eq('id', t!.store_id!).single()).data as { name: string; locality: string | null } | null,
  });

  const merge = async (targetId: string) => {
    setMerging(true);
    setMergeError(null);
    try {
      await mergeReceiptInto(id, targetId);
      ['transactions', 'transaction', 'spend', 'line_items', 'matches'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      router.replace({ pathname: '/movimento/[id]', params: { id: targetId } });
    } catch (e) {
      setMergeError(errorText(e));
      setMerging(false);
    }
  };

  if (tx.isLoading) return <ActivityIndicator style={{ marginTop: space.xl }} />;
  if (!tx.data) return <Text style={styles.error}>Movimento não encontrado.</Text>;

  const editable = tx.data.kind === 'expense' || tx.data.kind === 'income';

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.inner}>
        <Muted>
          {[SOURCE_LABEL[tx.data.source] ?? tx.data.source, store.data?.name, store.data?.locality].filter(Boolean).join(' · ')}
        </Muted>

        {(matches.data?.length ?? 0) > 0 && (
          <Card style={styles.matchCard}>
            <Text style={styles.h3}>Possível duplicado</Text>
            <Muted>Há outro movimento com o mesmo valor em datas próximas, sem talão. Se for a mesma compra, junte-os: os produtos passam para esse movimento e este é apagado.</Muted>
            {matches.data!.map((m) => (
              <Button key={m.id} variant="secondary" busy={merging} label={`Juntar a: ${m.description ?? 'Despesa'} · ${formatDate(m.date)}`} onPress={() => merge(m.id)} />
            ))}
            {mergeError && <Text style={styles.error}>{mergeError}</Text>}
          </Card>
        )}
        {(save.error || del.error) && <Text style={styles.error}>{(save.error ?? del.error)!.message}</Text>}

        {editable ? (
          <Card>
            <TransactionForm
              initial={tx.data}
              submitLabel="Guardar alterações"
              busy={save.isPending}
              onSubmit={(input) => save.mutate({ id, input }, { onSuccess: () => router.back() })}
            />
          </Card>
        ) : (
          <Muted>Transferências e reembolsos são criados pelas importações e não se editam aqui.</Muted>
        )}

        {(lines.data?.length ?? 0) > 0 && (
          <Card>
            <Text style={styles.h3}>Produtos</Text>
            {lines.data!.map((l) => (
              <View key={l.id} style={styles.line}>
                <View style={styles.lineMain}>
                  <Text style={styles.lineName} numberOfLines={1}>{l.name}</Text>
                  <Text style={[styles.lineCat, !l.category_id && { color: colors.warning }]} numberOfLines={1}>
                    {categoryPath(index, l.category_id)}
                  </Text>
                </View>
                <Text style={[styles.lineAmount, l.total_cents < 0 && { color: colors.income }]}>{formatEUR(l.total_cents)}</Text>
              </View>
            ))}
          </Card>
        )}

        {confirm ? (
          <Card>
            <Text style={styles.confirmText}>Apagar este movimento? Não é possível desfazer.</Text>
            <Button label="Sim, apagar" variant="danger" busy={del.isPending} onPress={() => del.mutate(id, { onSuccess: () => router.back() })} />
            <Button label="Cancelar" variant="secondary" onPress={() => setConfirm(false)} />
          </Card>
        ) : (
          <Button label="Apagar movimento" variant="danger" onPress={() => setConfirm(true)} />
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  error: { color: colors.danger, fontSize: 14, padding: space.md },
  confirmText: { fontSize: 15, color: colors.ink },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  matchCard: { borderWidth: 1, borderColor: colors.accent },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 6 },
  lineMain: { flex: 1 },
  lineName: { fontSize: 14, color: colors.ink },
  lineCat: { fontSize: 12, color: colors.muted },
  lineAmount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
});
