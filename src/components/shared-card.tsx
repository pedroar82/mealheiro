import { useMutation, useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { Button, Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { formatEUR } from '@/lib/format';
import { isHalfOfTheirs, isShared, isSplit, myShare } from '@/lib/shared';
import { supabase } from '@/lib/supabase';
import type { Transaction } from '@/lib/types';

const KEYS = ['transactions', 'transaction', 'spend', 'explore', 'incomes', 'recurring'];

/** Movement detail: shared-expense switch (50%), "acerto da casa" (flatmate) and "acerto de contas" (friends). */
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
  if (tx.kind === 'expense' && isSplit(tx)) return null; // a split bill: "Dividir a conta" in the form instead
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
  if (tx.kind === 'payback') {
    return (
      <Card>
        <Text style={styles.label}>Acerto de contas</Text>
        <Muted>
          Alguém a devolver a parte dele de uma conta que pagou (ex.: um jantar dividido). Não conta como receita: nos seus
          gastos já só conta a sua parte.
        </Muted>
        <Button
          label="Afinal é uma receita"
          variant="secondary"
          busy={update.isPending}
          onPress={() => update.mutate({ kind: 'income' })}
        />
        {update.error && <Text style={styles.error}>{update.error.message}</Text>}
      </Card>
    );
  }
  if (tx.kind === 'income') {
    return (
      <Card>
        <Text style={styles.label}>É um acerto?</Text>
        <Muted>
          Se esta entrada é alguém a pagar a parte dele de uma despesa (contas da casa, um jantar dividido…), não é receita.
        </Muted>
        <Button
          label="Acerto da casa (colega de casa)"
          variant="secondary"
          busy={update.isPending}
          onPress={() => update.mutate({ kind: 'settlement', category_id: null, recurring: false })}
        />
        <Button
          label="Acerto de contas (parte de uma conta dividida)"
          variant="secondary"
          busy={update.isPending}
          onPress={() => update.mutate({ kind: 'payback', category_id: null, recurring: false })}
        />
        {update.error && <Text style={styles.error}>{update.error.message}</Text>}
      </Card>
    );
  }
  if (tx.kind === 'settlement') {
    return (
      <Card>
        <Text style={styles.label}>Acerto da casa</Text>
        <Muted>Transferência da colega de casa para acertar as contas partilhadas. Não conta como receita (as despesas já estão a metade).</Muted>
        <Button label="Afinal é uma receita" variant="secondary" busy={update.isPending} onPress={() => update.mutate({ kind: 'income' })} />
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
