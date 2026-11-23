import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SharedCard } from '@/components/shared-card';
import { CategoryPicker } from '@/components/category-picker';
import { ConsumedToggle } from '@/components/split-control';
import { TransactionForm } from '@/components/transaction-form';
import { Button, Card, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { findMatches, mergeReceiptInto } from '@/lib/receipt';
import { supabase } from '@/lib/supabase';
import { useCategories, useDeleteTransaction, useLineItems, useSaveTransaction, useSetConsumed, useSetLineCategory, useTransaction } from '@/lib/queries';
import { isSplit } from '@/lib/shared';

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
  const setConsumed = useSetConsumed();
  const setLineCategory = useSetLineCategory();
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
  // the company behind the shop (e.g. the Lda that runs a restaurant): kept, shown as secondary information
  const merchant = useQuery({
    queryKey: ['merchant', t?.merchant_id],
    enabled: !!t?.merchant_id,
    queryFn: async () => (await supabase.from('merchants').select('name, nif').eq('id', t!.merchant_id!).single()).data as { name: string; nif: string | null } | null,
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
  // split bill: each consumed item carries its share of the user's part (proportionally to its price)
  const split = isSplit(tx.data) && tx.data.my_cents != null;
  const consumedSum = (lines.data ?? []).reduce((s, l) => s + (l.consumed ? l.total_cents : 0), 0);
  const myLine = (c: number) => (split && consumedSum > 0 ? Math.round((c * tx.data!.my_cents!) / consumedSum) : null);

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.inner}>
        <Muted>
          {[SOURCE_LABEL[tx.data.source] ?? tx.data.source, store.data?.name, store.data?.locality].filter(Boolean).join(' · ')}
        </Muted>
        {merchant.data && merchant.data.name !== store.data?.name && merchant.data.name !== tx.data.description && (
          <Muted>
            Empresa: {merchant.data.name}
            {merchant.data.nif ? ` · NIF ${merchant.data.nif}` : ''}
          </Muted>
        )}

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
        <SharedCard tx={tx.data} />

        {(save.error || del.error) && <Text style={styles.error}>{(save.error ?? del.error)!.message}</Text>}

        {editable ? (
          <Card>
            <TransactionForm
              initial={tx.data}
              lines={lines.data}
              submitLabel="Guardar alterações"
              busy={save.isPending}
              onSubmit={(input) => save.mutate({ id, input }, { onSuccess: () => router.back() })}
            />
          </Card>
        ) : (
          tx.data.kind !== 'settlement' && tx.data.kind !== 'payback' && <Muted>Transferências e reembolsos são criados pelas importações e não se editam aqui.</Muted>
        )}

        {(lines.data?.length ?? 0) > 0 && (
          <Card>
            <Text style={styles.h3}>Produtos</Text>
            {split && <Muted>Conta dividida por {tx.data.split_people}: toque em &quot;Consumi&quot; para marcar o que não consumiu.</Muted>}
            <Muted>Mudar a categoria de um produto muda-a também nas outras compras do mesmo produto e fica memorizada.</Muted>
            {setConsumed.error && <Text style={styles.error}>{setConsumed.error.message}</Text>}
            {setLineCategory.error && <Text style={styles.error}>{setLineCategory.error.message}</Text>}
            {lines.data!.map((l) => {
              const mine = l.consumed ? myLine(l.total_cents) : null;
              return (
                <View key={l.id} style={styles.line}>
                  <View style={styles.lineMain}>
                    <Text style={[styles.lineName, split && !l.consumed && styles.notConsumed]} numberOfLines={1}>{l.name}</Text>
                    <CategoryPicker
                      index={index}
                      kind="expense"
                      value={l.category_id}
                      onChange={(categoryId) => categoryId !== l.category_id && setLineCategory.mutate({ rawText: l.raw_text, categoryId })}
                    />
                    {split && (
                      <ConsumedToggle name={l.name} consumed={l.consumed} onChange={(consumed) => setConsumed.mutate({ id: l.id, consumed })} />
                    )}
                  </View>
                  <View style={styles.lineAmounts}>
                    <Text style={[styles.lineAmount, l.total_cents < 0 && { color: colors.income }]}>{formatEUR(mine ?? l.total_cents)}</Text>
                    {split && <Text style={styles.lineCat}>{mine != null ? `de ${formatEUR(l.total_cents)}` : `${formatEUR(l.total_cents)} · não conta`}</Text>}
                  </View>
                </View>
              );
            })}
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
  lineMain: { flex: 1, gap: 2 },
  lineName: { fontSize: 14, color: colors.ink },
  lineCat: { fontSize: 12, color: colors.muted },
  lineAmounts: { alignItems: 'flex-end' },
  notConsumed: { color: colors.muted, textDecorationLine: 'line-through' },
  lineAmount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
});
