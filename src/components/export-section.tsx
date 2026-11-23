// Definições → Exportar: readable spreadsheet and full JSON backup of all the user's data.
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button, Card, Muted } from '@/components/ui';
import { colors, space } from '@/constants/theme';
import { buildWorkbook, loadAll, saveFile, XLSX_MIME } from '@/lib/export';
import { todayISO } from '@/lib/format';
import { errorText } from '@/lib/import-io';

const TABLE_LABEL: Record<string, string> = {
  accounts: 'contas',
  categories: 'categorias',
  merchants: 'comerciantes',
  stores: 'lojas',
  products: 'produtos',
  documents: 'documentos',
  imports: 'importações',
  transactions: 'movimentos',
  line_items: 'linhas de talão',
  bank_lines: 'linhas de extrato',
  rules: 'regras',
};

export function ExportSection() {
  const [busy, setBusy] = useState<'xlsx' | 'json' | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (what: 'xlsx' | 'json') => {
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      const backup = await loadAll((t) => setStep(`A ler ${TABLE_LABEL[t] ?? t}…`));
      const day = todayISO();
      if (what === 'xlsx') {
        setStep('A preparar a folha de cálculo…');
        await saveFile(`mealheiro-${day}.xlsx`, await buildWorkbook(backup), XLSX_MIME, 'org.openxmlformats.spreadsheetml.sheet');
      } else {
        await saveFile(`mealheiro-copia-${day}.json`, JSON.stringify(backup), 'application/json', 'public.json');
      }
      const n = backup.tables.transactions.length;
      const l = backup.tables.line_items.length;
      setDone(`Exportado: ${n} movimentos e ${l} linhas de talão.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      setStep(null);
    }
  };

  return (
    <>
      <Card>
        <Text style={styles.h3}>Folha de cálculo (.xlsx)</Text>
        <Muted>Para consultar no Excel: movimentos (com a sua parte nas contas partilhadas), produtos dos talões, categorias e regras.</Muted>
        <Button label="Exportar folha de cálculo" busy={busy === 'xlsx'} disabled={!!busy} onPress={() => run('xlsx')} />
      </Card>
      <Card>
        <Text style={styles.h3}>Cópia de segurança completa (.json)</Text>
        <Muted>Todos os dados tal como estão guardados, para nunca dependerem só do servidor. Guarde-a num sítio seguro.</Muted>
        <Button label="Exportar cópia de segurança" variant="secondary" busy={busy === 'json'} disabled={!!busy} onPress={() => run('json')} />
      </Card>
      {step && <Muted>{step}</Muted>}
      {done && <Text style={styles.ok}>{done}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

const styles = StyleSheet.create({
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  ok: { fontSize: 14, color: colors.ink, paddingHorizontal: space.xs },
  error: { color: colors.danger, fontSize: 14 },
});
