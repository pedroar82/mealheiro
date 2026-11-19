import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TransactionForm } from '@/components/transaction-form';
import { Button, Card, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { formatEUR } from '@/lib/format';
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

  if (tx.isLoading) return <ActivityIndicator style={{ marginTop: space.xl }} />;
  if (!tx.data) return <Text style={styles.error}>Movimento não encontrado.</Text>;

  const editable = tx.data.kind === 'expense' || tx.data.kind === 'income';

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll}>
      <View style={styles.inner}>
        <Muted>{SOURCE_LABEL[tx.data.source] ?? tx.data.source}</Muted>
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
  line: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: 6 },
  lineMain: { flex: 1 },
  lineName: { fontSize: 14, color: colors.ink },
  lineCat: { fontSize: 12, color: colors.muted },
  lineAmount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
});
