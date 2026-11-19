import { Link } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';

import { Screen } from '@/components/screen';
import { TransactionForm } from '@/components/transaction-form';
import { Card } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { formatEUR } from '@/lib/format';
import { useSaveTransaction } from '@/lib/queries';

export default function Adicionar() {
  const save = useSaveTransaction();
  const [formKey, setFormKey] = useState(0);
  const [saved, setSaved] = useState<string | null>(null);

  return (
    <Screen title="Adicionar">
      <View style={styles.sources}>
        <View style={[styles.source, styles.sourceOn]}>
          <Text style={[styles.sourceText, { color: colors.accent }]}>Manual</Text>
        </View>
        <View style={styles.source} accessibilityState={{ disabled: true }}>
          <Text style={styles.sourceText}>Digitalizar</Text>
          <Text style={styles.soon}>em breve</Text>
        </View>
        <View style={styles.source} accessibilityState={{ disabled: true }}>
          <Text style={styles.sourceText}>PDF</Text>
          <Text style={styles.soon}>em breve</Text>
        </View>
      </View>

      {saved && (
        <View style={styles.saved} accessibilityLiveRegion="polite">
          <Text style={styles.savedText}>{saved}</Text>
        </View>
      )}
      {save.error && <Text style={styles.error}>Não foi possível guardar: {save.error.message}</Text>}

      <Card>
        <TransactionForm
          key={formKey}
          submitLabel="Guardar"
          busy={save.isPending}
          onSubmit={(input) =>
            save.mutate(
              { input },
              {
                onSuccess: () => {
                  setSaved(`${input.kind === 'income' ? 'Receita' : 'Despesa'} de ${formatEUR(input.amount_cents)} guardada.`);
                  setFormKey((k) => k + 1);
                },
              },
            )
          }
        />
      </Card>

      {Platform.OS === 'web' && (
        <View>
          <Link href="/importar-extrato" style={styles.importLink}>
            Importar extrato CGD (CSV) ›
          </Link>
          <Link href="/importar-excel" style={styles.importLink}>
            Importar histórico do Excel ›
          </Link>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sources: { flexDirection: 'row', gap: space.sm },
  source: { flex: 1, minHeight: 64, borderRadius: radius.md, borderWidth: 1, borderColor: '#D5D8DF', backgroundColor: colors.card, alignItems: 'center', justifyContent: 'center', opacity: 0.6 },
  sourceOn: { borderWidth: 2, borderColor: colors.accent, backgroundColor: colors.accentSoft, opacity: 1 },
  sourceText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  soon: { fontSize: 11, color: colors.muted },
  saved: { backgroundColor: '#DDF2E9', borderRadius: radius.md, padding: space.md },
  savedText: { color: '#11573F', fontSize: 14, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
  importLink: { color: colors.accent, fontSize: 15, fontWeight: '600', paddingVertical: space.sm },
});
