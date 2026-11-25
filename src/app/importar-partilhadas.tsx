// Web: import the flat's shared-bills spreadsheet and apply it (preview first).

import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button, Card, Chip, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import { addDays, formatDate, formatEUR, MONTHS, todayISO } from '@/lib/format';
import { categoryPath } from '@/lib/categories';
import { chunks, errorText, fetchAll, pickFile } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import { parseFlatSheets, planShared, sharedKey, strayShared, type MonthPlan, type PlannedBill, type SheetMonth, type Tx } from '@/lib/shared-import';
import { supabase } from '@/lib/supabase';

type Loaded = { months: SheetMonth[]; people: string[]; expenses: Tx[]; credits: Tx[]; halves: Map<string, string>; fileName: string };

const COLS = 'id, kind, date, amount_cents, description, category_id, share_pct';

type Choice = 'full' | 'half' | 'not';
const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;

export default function ImportarPartilhadas() {
  const qc = useQueryClient();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  // per bill (month|label) with a recognised movement: 'full' = it is the whole bill (count half),
  // 'half' = it already is the user's half, 'not' = unrelated (the flatmate paid; add the half)
  const [choice, setChoice] = useState<Map<string, Choice>>(new Map());
  const [dropExtra, setDropExtra] = useState<Set<string>>(new Set()); // repeated movements to delete
  const [keepShared, setKeepShared] = useState<Set<string>>(new Set()); // stray shared expenses the user keeps at 50%
  const { index } = useCategories();
  const [busy, setBusy] = useState<'reading' | 'saving' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const today = todayISO();

  const choose = async () => {
    const file = await pickFile('.xlsx,.xls');
    if (!file) return;
    setError(null);
    setDone(null);
    setBusy('reading');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const tables = wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, raw: true, defval: null })] as [string, unknown[][]]);
      const { months, people } = parseFlatSheets(tables);
      if (!months.length) throw new Error('Não encontrei meses (linha 1 com "JANUARY 26"…) nem contas nesta folha.');
      const from = addDays(`${months[0].month}-01`, -10);
      const [expenses, credits, keyed] = await Promise.all([
        fetchAll<Tx>((a, b) => supabase.from('transactions').select(COLS).eq('kind', 'expense').gte('date', from).order('id').range(a, b)),
        fetchAll<Tx>((a, b) => supabase.from('transactions').select(COLS).in('kind', ['income', 'settlement']).gte('date', from).order('id').range(a, b)),
        fetchAll<{ id: string; external_key: string }>((a, b) => supabase.from('transactions').select('id, external_key').like('external_key', 'shared:%').order('id').range(a, b)),
      ]);
      setLoaded({ months, people, expenses, credits, halves: new Map(keyed.map((k) => [k.external_key, k.id])), fileName: file.name });
      setMe((cur) => (cur && people.includes(cur) ? cur : (people[0] ?? null)));
      setSkip(new Set());
      setChoice(new Map());
      setDropExtra(new Set());
      setKeepShared(new Set());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const plan: MonthPlan[] = useMemo(
    () => {
      if (!loaded || !me) return [];
      const withText = loaded.expenses.map((t) => ({ ...t, text: `${t.description ?? ''} ${t.category_id ? categoryPath(index, t.category_id) : ''}` }));
      return planShared(loaded.months, me, withText, loaded.credits, loaded.halves, today);
    },
    [loaded, me, today, index],
  );
  const other = loaded?.people.find((p) => p !== me) ?? 'colega';

  // category for "your half" entries: what the matched bills of that kind use
  const categoryFor = useMemo(() => {
    const votes = new Map<string, Map<string, number>>();
    for (const m of plan)
      for (const b of m.bills)
        if (b.plan.status === 'mine' && b.plan.tx.category_id) {
          const v = votes.get(b.key) ?? new Map<string, number>();
          v.set(b.plan.tx.category_id, (v.get(b.plan.tx.category_id) ?? 0) + 1);
          votes.set(b.key, v);
        }
    return (key: string) => [...(votes.get(key) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [plan]);

  const active = plan.filter((m) => !skip.has(m.month));
  // expenses split by mistake (an earlier version took e.g. sushi for the internet bill)
  const stray = useMemo(() => (loaded ? strayShared(plan, loaded.expenses, loaded.halves) : []), [plan, loaded]);
  const decide = (m: MonthPlan, b: PlannedBill): Choice | null => {
    if (b.plan.status !== 'theirs' || !b.plan.suspect) return null;
    const chosen = choice.get(`${m.month}|${b.label}`);
    if (chosen) return chosen;
    if (b.plan.suspectKind === 'full') return 'full';
    if (b.plan.suspectKind === 'half') return 'half';
    return b.plan.suspect.amount_cents > b.cents * 0.75 ? 'full' : 'half';
  };
  const todo = {
    share: active.flatMap((m) =>
      m.bills.flatMap((b) => {
        if (b.plan.status === 'mine') return b.plan.already ? [] : [b.plan.tx.id];
        return decide(m, b) === 'full' && b.plan.suspect!.share_pct !== 50 ? [b.plan.suspect!.id] : [];
      }),
    ),
    unshare: [
      ...active.flatMap((m) =>
        m.bills.flatMap((b) => (b.plan.status === 'theirs' && decide(m, b) === 'half' && b.plan.suspect!.share_pct != null ? [b.plan.suspect!.id] : [])),
      ),
      ...stray.filter((t) => !keepShared.has(t.id)).map((t) => t.id),
    ],
    remove: active.flatMap((m) =>
      m.bills.flatMap((b) => {
        if (b.plan.status === 'mine') return b.plan.removeHalfId ? [b.plan.removeHalfId] : [];
        const d = decide(m, b);
        return d && d !== 'not' && b.plan.halfId ? [b.plan.halfId] : [];
      }),
    ),
    extras: [...new Set(active.flatMap((m) => m.bills.flatMap((b) => b.extras.filter((t) => dropExtra.has(t.id)).map((t) => t.id))))],
    halves: active.flatMap((m) =>
      m.bills.flatMap((b) => {
        if (b.plan.status !== 'theirs' || b.plan.already) return [];
        const d = decide(m, b);
        if (d && d !== 'not') return [];
        return [{
          kind: 'expense',
          date: [`${m.month}-28`, today].sort()[0],
          amount_cents: b.plan.halfCents,
          description: `${b.label.trim()} — a sua parte (pago por ${other})`,
          category_id: categoryFor(b.key),
          source: 'excel',
          external_key: sharedKey(m.month, b),
        }];
      }),
    ),
    settle: active.flatMap((m) => (m.settlement?.tx && !m.settlement.already ? [m.settlement.tx.id] : [])),
  };
  const removed = todo.remove.length + todo.extras.length;
  const nothing = !todo.share.length && !todo.halves.length && !todo.settle.length && !removed && !todo.unshare.length;

  const apply = async () => {
    setBusy('saving');
    setError(null);
    try {
      // halves created by mistake (the user did pay that bill) go first
      for (const part of chunks(todo.remove, 100)) {
        const { error: e } = await supabase.from('transactions').delete().in('id', part).like('external_key', 'shared:%');
        if (e) throw new Error(e.message);
      }
      // a "your half" row must never be split again (it may have been switched to 50% by hand)
      {
        const { error: e } = await supabase.from('transactions').update({ share_pct: null }).like('external_key', 'shared:%').not('share_pct', 'is', null);
        if (e) throw new Error(e.message);
      }
      for (const part of chunks(todo.extras, 100)) {
        const { error: e } = await supabase.from('transactions').delete().in('id', part);
        if (e) throw new Error(e.message);
      }
      for (const part of chunks(todo.unshare, 100)) {
        const { error: e } = await supabase.from('transactions').update({ share_pct: null }).in('id', part);
        if (e) throw new Error(e.message);
      }
      for (const part of chunks(todo.share, 100)) {
        const { error: e } = await supabase.from('transactions').update({ share_pct: 50 }).in('id', part);
        if (e) throw new Error(e.message);
      }
      if (todo.halves.length) {
        const { error: e } = await supabase.from('transactions').upsert(todo.halves, { onConflict: 'user_id,external_key', ignoreDuplicates: true });
        if (e) throw new Error(e.message);
      }
      for (const part of chunks(todo.settle, 100)) {
        const { error: e } = await supabase.from('transactions').update({ kind: 'settlement', category_id: null, recurring: false }).in('id', part);
        if (e) throw new Error(e.message);
      }
      ['transactions', 'spend', 'explore', 'incomes', 'recurring'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
      setDone(
        `${todo.share.length} contas marcadas como partilhadas · ${todo.halves.length} partes suas de contas pagas por ${other} · ${todo.settle.length} acertos` +
          (removed ? ` · ${removed} repetições removidas.` : '.'),
      );
      setLoaded(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.center}>
        <Muted>Esta importação faz-se no computador.</Muted>
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets keyboardShouldPersistTaps="handled">
      <View style={styles.inner}>
        <Card>
          <Muted>
            Folha das contas da casa (uma folha por ano, meses na primeira linha). As contas que pagou passam a contar só metade;
            as que a outra pessoa pagou acrescentam a sua metade; a transferência mensal de acerto deixa de contar como receita.
            Pode voltar a importar a folha todos os meses — o que já foi feito não se repete.
          </Muted>
          <Button label={loaded ? 'Escolher outro ficheiro' : 'Escolher ficheiro .xlsx'} variant={loaded ? 'secondary' : 'primary'} busy={busy === 'reading'} onPress={choose} />
        </Card>

        {error && <Text style={styles.error}>{error}</Text>}
        {done && (
          <Card style={styles.ok}>
            <Text style={styles.okText}>{done}</Text>
            <Button label="Ver movimentos" variant="secondary" onPress={() => router.navigate('/movimentos')} />
          </Card>
        )}

        {loaded && (
          <>
            <Card>
              <Text style={styles.h3}>Quem é você na folha?</Text>
              <View style={styles.chips}>
                {loaded.people.map((p) => (
                  <Chip key={p} label={p} selected={me === p} onPress={() => setMe(p)} />
                ))}
              </View>
            </Card>

            {plan.map((m) => {
              const off = skip.has(m.month);
              return (
                <Card key={m.month} style={[m.warning && !off ? styles.warn : null, off && { opacity: 0.55 }]}>
                  <View style={styles.headRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.h3}>{monthName(m.month)}</Text>
                      <Muted>
                        Total {formatEUR(m.totalCents)} · a sua parte {formatEUR(m.myCostCents)} · pagou {formatEUR(m.youPaidCents)}
                      </Muted>
                    </View>
                    <Chip label={off ? 'Ignorado' : 'Incluído'} selected={!off} onPress={() => setSkip((s) => {
                      const n = new Set(s);
                      if (n.has(m.month)) n.delete(m.month); else n.add(m.month);
                      return n;
                    })} />
                  </View>
                  {m.bills.map((b) => {
                    const key = `${m.month}|${b.label}`;
                    const suspect = b.plan.status === 'theirs' ? b.plan.suspect : null;
                    const d = decide(m, b);
                    const set = (c: Choice) => setChoice((x) => new Map(x).set(key, c));
                    return (
                      <View key={b.label} style={{ gap: 4 }}>
                        <View style={styles.line}>
                          <Text style={styles.lineName}>{b.label.trim()}</Text>
                          <Text style={styles.lineInfo} numberOfLines={3}>
                            {b.plan.status === 'mine'
                              ? `pago por si · ${b.plan.tx.description ?? 'movimento'} ${formatDate(b.plan.tx.date)}${
                                  b.plan.removeHalfId ? ' → conta metade e apaga a metade repetida' : b.plan.already ? ' · já partilhada' : ' → conta metade'
                                }`
                              : suspect && d !== 'not'
                                ? `já registado como ${suspect.description ?? 'movimento'} ${formatDate(suspect.date)} (${formatEUR(suspect.amount_cents)})${
                                    d === 'full' ? ' → conta metade' : ' → já é a sua metade'
                                  }${b.plan.halfId ? ' · apaga a metade repetida' : ''}`
                                : `pago por ${other}${b.plan.already ? ' · já registado' : ` → + ${formatEUR(b.plan.halfCents)} (a sua metade)`}`}
                          </Text>
                          <Text style={styles.lineAmount}>{formatEUR(b.cents)}</Text>
                        </View>
                        {suspect && (
                          <View style={styles.chips}>
                            <Chip label={`É a conta toda (${formatEUR(suspect.amount_cents)} → metade)`} selected={d === 'full'} onPress={() => set('full')} />
                            <Chip label="Já é a minha metade" selected={d === 'half'} onPress={() => set('half')} />
                            <Chip label={`Não é esta conta (pagou ${other})`} selected={d === 'not'} onPress={() => set('not')} />
                          </View>
                        )}
                        {b.extras.map((t) => (
                          <View key={t.id} style={styles.extra}>
                            <Text style={styles.extraText} numberOfLines={2}>
                              Também neste mês: {t.description ?? 'movimento'} {formatDate(t.date)} · {formatEUR(t.amount_cents)}
                            </Text>
                            <Chip
                              label={dropExtra.has(t.id) ? 'Repetido — apagar ✓' : 'Repetido — apagar'}
                              selected={dropExtra.has(t.id)}
                              onPress={() =>
                                setDropExtra((x) => {
                                  const n = new Set(x);
                                  if (n.has(t.id)) n.delete(t.id);
                                  else n.add(t.id);
                                  return n;
                                })
                              }
                            />
                          </View>
                        ))}
                      </View>
                    );
                  })}
                  {m.settlement && (
                    <Text style={styles.settle}>
                      Acerto {m.settlement.incoming ? `de ${other}` : `para ${other}`}: {formatEUR(m.settlement.cents)}
                      {m.settlement.tx
                        ? ` · ${formatDate(m.settlement.tx.date)}${m.settlement.already ? ' · já marcado' : ' → deixa de contar como receita'}`
                        : ' · transferência não encontrada'}
                    </Text>
                  )}
                  {m.warning && !off && <Text style={styles.warnText}>{m.warning}</Text>}
                </Card>
              );
            })}

            {stray.length > 0 && (
              <Card style={styles.warn}>
                <Text style={styles.h3}>Partilhadas que não são contas da casa</Text>
                <Muted>Estas despesas estão a contar metade, mas não correspondem a nenhuma conta da folha. Voltam a contar o valor todo, exceto as que mantiver.</Muted>
                {stray.map((t) => {
                  const keep = keepShared.has(t.id);
                  return (
                    <View key={t.id} style={styles.line}>
                      <Text style={styles.lineInfo} numberOfLines={2}>
                        {t.description ?? 'movimento'} · {formatDate(t.date)} · {formatEUR(t.amount_cents)}
                      </Text>
                      <Chip
                        label={keep ? 'Manter partilhada' : 'Deixar de partilhar'}
                        selected={!keep}
                        onPress={() =>
                          setKeepShared((x) => {
                            const n = new Set(x);
                            if (n.has(t.id)) n.delete(t.id);
                            else n.add(t.id);
                            return n;
                          })
                        }
                      />
                    </View>
                  );
                })}
              </Card>
            )}

            <Card>
              <Text style={styles.h3}>Resumo</Text>
              <Muted>
                {todo.share.length} contas pagas por si passam a contar metade · {todo.halves.length} partes suas de contas pagas por {other} ·{' '}
                {todo.settle.length} acertos deixam de ser receita{removed ? ` · ${removed} repetições a remover` : ''}
                {todo.unshare.length ? ` · ${todo.unshare.length} deixam de ser partilhadas` : ''}.
              </Muted>
              <Button label={nothing ? 'Nada de novo para aplicar' : 'Aplicar'} disabled={nothing} busy={busy === 'saving'} onPress={apply} />
            </Card>
          </>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg, backgroundColor: colors.ground },
  error: { color: colors.danger, fontSize: 14 },
  ok: { borderWidth: 1, borderColor: colors.income },
  okText: { fontSize: 15, color: colors.ink },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingVertical: 4 },
  lineName: { width: 110, fontSize: 14, fontWeight: '600', color: colors.ink },
  lineInfo: { flex: 1, fontSize: 12, color: colors.muted },
  lineAmount: { fontSize: 14, color: colors.ink, fontVariant: ['tabular-nums'], minWidth: 72, textAlign: 'right' },
  settle: { fontSize: 13, color: colors.ink, paddingTop: 4 },
  warn: { borderWidth: 1, borderColor: colors.warning },
  warnText: { fontSize: 13, color: colors.warning },
  extra: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingLeft: 110 + space.sm },
  extraText: { flex: 1, fontSize: 12, color: colors.warning },
});
