import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { Button, Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { formatEUR } from '@/lib/format';
import { isHalfOfTheirs, isShared, myShare } from '@/lib/shared';
import { supabase } from '@/lib/supabase';
import type { Transaction } from '@/lib/types';

const KEYS = ['transactions', 'transaction', 'spend', 'explore', 'incomes', 'recurring'];

/** Movement detail: shared-expense switch (50%) and the flatmate "acerto da casa". */
export function SharedCard({ tx }: { tx: Transaction }) {
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: async (patch: Partial<Transaction>) => {
      const { error } = await supabase.from('transactions').update(patch).eq('id', tx.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: () => KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })),
  });

  if (tx.kind === 'expense' && isHalfOfTheirs(tx)) {
    return (
      <Card>
        <Text style={styles.label}>👥 A sua metade de uma conta da casa</Text>
        <Muted>
          Esta conta foi paga pela outra pessoa; este valor já é só a sua metade ({formatEUR(tx.amount_cents)}), por isso não
          se divide outra vez. Vem da importação das contas da casa.
        </Muted>
        {isShared(tx) && (
          <Button
            label={`Corrigir: contar ${formatEUR(tx.amount_cents)} (estava a contar metade)`}
            variant="secondary"
            busy={update.isPending}
            onPress={() => update.mutate({ share_pct: null })}
          />
        )}
        {update.error && <Text style={styles.error}>{update.error.message}</Text>}
      </Card>
    );
  }
  if (tx.kind === 'expense') {
    const shared = isShared(tx);
    return (
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.label}>👥 Despesa partilhada (50%)</Text>
            <Muted>
              {shared
                ? `Pagou ${formatEUR(tx.amount_cents)} · a sua parte ${formatEUR(myShare(tx))} (é o que conta nos gastos)`
                : 'Renda, água, gás, luz, internet da casa: só metade é sua.'}
            </Muted>
          </View>
          <Switch
            value={shared}
            disabled={update.isPending}
            onValueChange={(v) => update.mutate({ share_pct: v ? 50 : null })}
            accessibilityLabel="Despesa partilhada, 50%"
          />
        </View>
        {update.error && <Text style={styles.error}>{update.error.message}</Text>}
      </Card>
    );
  }
  if (tx.kind === 'income' || tx.kind === 'settlement') {
    const settlement = tx.kind === 'settlement';
    return (
      <Card>
        <Text style={styles.label}>{settlement ? 'Acerto da casa' : 'É o acerto da casa?'}</Text>
        <Muted>
          {settlement
            ? 'Transferência da colega de casa para acertar as contas partilhadas. Não conta como receita (as despesas já estão a metade).'
            : 'Se esta entrada é a colega de casa a pagar a parte dela das contas, não é receita.'}
        </Muted>
        <Button
          label={settlement ? 'Afinal é uma receita' : 'Sim, é acerto da casa'}
          variant="secondary"
          busy={update.isPending}
          onPress={() => update.mutate(settlement ? { kind: 'income' } : { kind: 'settlement', category_id: null, recurring: false })}
        />
        {update.error && <Text style={styles.error}>{update.error.message}</Text>}
      </Card>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  label: { fontSize: 15, fontWeight: '600', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
});
