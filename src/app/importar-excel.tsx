import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, FieldLabel, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import {
  externalKeys,
  mappingKey,
  parseSheet,
  pickAccounts,
  suggestCategory,
  summariseCategories,
  type ExcelRow,
  type ParseResult,
} from '@/lib/excel-import';
import { formatDate, formatEUR } from '@/lib/format';
import { fetchAll, pickFile } from '@/lib/import-io';
import { useAccounts, useCategories } from '@/lib/queries';
import { supabase } from '@/lib/supabase';

type Loaded = ParseResult & { fileName: string; keys: string[]; existing: Set<string> };
type Done = { inserted: number; already: number };

const BATCH = 500;

/** external_keys of rows already imported from Excel. */
async function fetchExistingKeys(): Promise<Set<string>> {
  const rows = await fetchAll<{ external_key: string | null }>((from, to) =>
    supabase.from('transactions').select('external_key').eq('source', 'excel').order('id').range(from, to),
  );
  return new Set(rows.map((r) => r.external_key).filter((k): k is string => !!k));
}

export default function ImportarExcel() {
  const qc = useQueryClient();
  const { index, isLoading: catsLoading } = useCategories();
  const accountsQ = useAccounts();
  const { bank, cash } = pickAccounts(accountsQ.data ?? []);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string | null>>({});
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const mapping = useMemo(() => (loaded ? summariseCategories(loaded.rows) : []), [loaded]);
  const categoryFor = (key: string, kind: ExcelRow['kind'], excelCategory: string) =>
    key in overrides ? overrides[key] : suggestCategory(index, kind, excelCategory);

  const stats = useMemo(() => {
    if (!loaded) return null;
    const isNew = loaded.rows.map((_, i) => !loaded.existing.has(loaded.keys[i]));
    const fresh = loaded.rows.filter((_, i) => isNew[i]);
    const dates = loaded.rows.map((r) => r.date).sort();
    const sum = (k: ExcelRow['kind']) => loaded.rows.filter((r) => r.kind === k).reduce((s, r) => s + r.amount_cents, 0);
    return {
      fresh: fresh.length,
      already: loaded.rows.length - fresh.length,
      from: dates[0],
      to: dates[dates.length - 1],
      expense: sum('expense'),
      income: sum('income'),
      bankRows: loaded.rows.filter((r) => r.fromBank).length,
      cashRows: loaded.rows.filter((r) => !r.fromBank).length,
    };
  }, [loaded]);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.center}>
        <Muted>A importação do Excel só está disponível na versão web (computador).</Muted>
      </View>
    );
  }

  const choose = async () => {
    setError(null);
    setDone(null);
    const file = await pickFile('.xlsx,.xls');
    if (!file) return;
    setBusy('reading');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const table = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      const parsed = parseSheet(table);
      const [keys, existing] = await Promise.all([externalKeys(parsed.rows), fetchExistingKeys()]);
      setOverrides({});
      setLoaded({ ...parsed, fileName: file.name, keys, existing });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!loaded || !stats || !bank || !cash) return;
    setError(null);
    setBusy('importing');
    try {
      const payload = loaded.rows
        .map((r, i) => ({ r, key: loaded.keys[i] }))
        .filter(({ key }) => !loaded.existing.has(key))
        .map(({ r, key }) => ({
          kind: r.kind,
          date: r.date,
          amount_cents: r.amount_cents,
          account_id: r.fromBank ? bank.id : cash.id,
          category_id: categoryFor(mappingKey(r.kind, r.excelCategory), r.kind, r.excelCategory),
          description: r.description,
          source: 'excel' as const,
          external_key: key,
        }));

      let inserted = 0;
      for (let i = 0; i < payload.length; i += BATCH) {
        // ignoreDuplicates: rows already in the database (same external_key) are skipped, so a retry is harmless
        const { data, error: e } = await supabase
          .from('transactions')
          .upsert(payload.slice(i, i + BATCH), { onConflict: 'user_id,external_key', ignoreDuplicates: true })
          .select('id');
        if (e) throw new Error(e.message);
        inserted += data?.length ?? 0;
      }
      const already = loaded.rows.length - inserted;

      const { error: e2 } = await supabase.from('imports').insert({
        source: 'excel',
        file_name: loaded.fileName,
        period_start: stats.from,
        period_end: stats.to,
        stats: { rows: loaded.rows.length, inserted, already, balance_fixes_skipped: loaded.balanceFixes, errors: loaded.errors.length },
      });
      if (e2) throw new Error(e2.message);

      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['spend'] });
      setDone({ inserted, already });
      setLoaded(null);
    } catch (e) {
      setError(`${e instanceof Error ? e.message : String(e)} — pode tentar de novo: os já importados são ignorados.`);
    } finally {
      setBusy(null);
    }
  };

  const ready = !catsLoading && !accountsQ.isLoading;
  const missingAccount = ready && (!bank || !cash);

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll}>
      <View style={styles.inner}>
        <Card>
          <Text style={styles.h2}>Histórico do Excel</Text>
          <Muted>
            Importação única da folha antiga (uma linha por movimento). O ficheiro é lido no browser e não é enviado. Movimentos
            de &quot;Banco&quot; vão para {bank?.name ?? 'a conta bancária'}; os restantes para {cash?.name ?? 'Carteira'}. As
            linhas &quot;Modificar Saldo&quot; são ignoradas.
          </Muted>
          <Button label={loaded ? 'Escolher outro ficheiro' : 'Escolher ficheiro .xlsx'} variant={loaded ? 'secondary' : 'primary'} onPress={choose} busy={busy === 'reading'} disabled={!ready || busy !== null} />
        </Card>

        {missingAccount && <Text style={styles.error}>Faltam as contas &quot;CGD à ordem&quot; (banco) e/ou &quot;Carteira&quot; (dinheiro).</Text>}
        {error && <Text style={styles.error}>{error}</Text>}

        {done && (
          <Card style={styles.ok}>
            <Text style={styles.okText} accessibilityLiveRegion="polite">
              {done.inserted} movimentos importados{done.already ? ` · ${done.already} já existiam` : ''}.
            </Text>
            <Button label="Ver movimentos" variant="secondary" onPress={() => router.navigate('/movimentos')} />
          </Card>
        )}

        {loaded && stats && (
          <>
            <Card>
              <Text style={styles.h2}>{loaded.fileName}</Text>
              <Stat label="Movimentos" value={String(loaded.rows.length)} />
              {stats.from && <Stat label="Período" value={`${formatDate(stats.from)} – ${formatDate(stats.to)}`} />}
              <Stat label="Despesas" value={formatEUR(stats.expense)} />
              <Stat label="Receitas" value={formatEUR(stats.income)} />
              <Stat label={`Banco → ${bank?.name ?? '?'}`} value={String(stats.bankRows)} />
              <Stat label={`Outros → ${cash?.name ?? '?'}`} value={String(stats.cashRows)} />
              <Stat label="Correções de saldo ignoradas" value={String(loaded.balanceFixes)} />
              {stats.already > 0 && <Stat label="Já importados (ignorados)" value={String(stats.already)} />}
            </Card>

            {loaded.errors.length > 0 && (
              <Card>
                <Text style={styles.h3}>{loaded.errors.length} linhas com erro (não importadas)</Text>
                {loaded.errors.slice(0, 20).map((e) => <Muted key={e}>{e}</Muted>)}
                {loaded.errors.length > 20 && <Muted>…</Muted>}
              </Card>
            )}

            <Card>
              <Text style={styles.h3}>Categorias</Text>
              <Muted>Confirme para onde vai cada categoria do Excel. Pode escolher uma subcategoria.</Muted>
              {mapping.map((m) => {
                const id = categoryFor(m.key, m.kind, m.excelCategory);
                return (
                  <View key={m.key} style={styles.mapRow}>
                    <View style={styles.mapFrom}>
                      <Text style={styles.mapName}>{m.excelCategory || '(sem categoria)'}</Text>
                      <Muted>
                        {m.kind === 'income' ? 'Receita' : 'Despesa'} · {m.count} · {formatEUR(m.cents)}
                      </Muted>
                    </View>
                    <View style={styles.mapTo}>
                      <FieldLabel>Categoria na app{!id ? ' — sem correspondência' : ''}</FieldLabel>
                      <CategoryPicker index={index} kind={m.kind} value={id} onChange={(v) => setOverrides((o) => ({ ...o, [m.key]: v }))} />
                    </View>
                  </View>
                );
              })}
            </Card>

            <Button
              label={stats.fresh ? `Importar ${stats.fresh} movimentos` : 'Nada de novo para importar'}
              onPress={runImport}
              busy={busy === 'importing'}
              disabled={!stats.fresh || missingAccount || busy !== null}
            />
          </>
        )}

        {busy === 'reading' && <ActivityIndicator />}
      </View>
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, backgroundColor: colors.ground },
  h2: { fontSize: 17, fontWeight: '700', color: colors.ink },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
  ok: { backgroundColor: '#DDF2E9' },
  okText: { color: '#11573F', fontSize: 15, fontWeight: '600' },
  stat: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md },
  statLabel: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  statValue: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  mapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  mapFrom: { flexGrow: 1, flexBasis: 180, gap: 2 },
  mapTo: { flexGrow: 2, flexBasis: 240, gap: 4 },
  mapName: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
