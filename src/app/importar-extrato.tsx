import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Chip, FieldLabel, Muted } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';
import {
  categoryForKey,
  classify,
  decodeStatement,
  defaultLinks,
  descKey,
  fingerprint,
  parseStatement,
  type BankLine,
  type BankRule,
  type ExistingTx,
  type ParsedStatement,
  type Plan,
} from '@/lib/cgd-import';
import { pickAccounts } from '@/lib/excel-import';
import { formatDate, formatEUR } from '@/lib/format';
import { chunks, errorText, fetchAll, pickFile } from '@/lib/import-io';
import { useAccounts, useCategories } from '@/lib/queries';
import { supabase } from '@/lib/supabase';
import type { CategoryKind } from '@/lib/types';

type Loaded = ParsedStatement & {
  fileName: string;
  fps: string[];
  plans: Plan[];
  rules: BankRule[];
};

type Final =
  | { status: 'already' }
  | { status: 'cash_withdrawal' }
  | { status: 'refund' }
  | { status: 'linked'; txId: string }
  | { status: 'ignored' }
  | { status: 'payback' } // acerto de contas: a friend's part of a split bill (neither income nor spending)
  | { status: 'created'; kind: CategoryKind; key: string };

type Done = Record<string, number>;

const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);
const amountOf = (l: BankLine) => (l.debit ? -l.debit : l.credit!);
const groupKey = (kind: CategoryKind, key: string) => `${kind}|${key}`;
/** Money received: the user's choice, else "acerto de contas" when a bill was split in the 14 days before. */
const paybackChoice = (p: { splitBill: string | null }, chosen: 'income' | 'payback' | undefined) => chosen ?? (p.splitBill ? 'payback' : 'income');

async function loadContext(lines: BankLine[], bankId: string) {
  const dates = lines.map((l) => l.value).sort();
  const from = addDays(dates[0], -60); // refunds look back 60 days
  const to = addDays(dates[dates.length - 1], 3);
  const [existing, linked, rules] = await Promise.all([
    fetchAll<ExistingTx>((a, b) =>
      supabase
        .from('transactions')
        .select('id, kind, date, amount_cents, account_id, description, source, recurring, split_people')
        .in('kind', ['expense', 'income'])
        .gte('date', from)
        .lte('date', to)
        .order('id')
        .range(a, b),
    ),
    fetchAll<{ transaction_id: string }>((a, b) =>
      supabase.from('bank_lines').select('transaction_id').not('transaction_id', 'is', null).order('id').range(a, b),
    ),
    fetchAll<BankRule>((a, b) =>
      supabase.from('rules').select('pattern, match, category_id, priority').eq('scope', 'bank_desc').order('id').range(a, b),
    ),
  ]);
  const fps = await Promise.all(lines.map((l) => fingerprint(bankId, l)));
  const known = new Set<string>();
  for (const part of chunks(fps, 100)) {
    const { data, error } = await supabase.from('bank_lines').select('fingerprint').in('fingerprint', part);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) known.add(r.fingerprint);
  }
  return { existing, linkedIds: new Set(linked.map((r) => r.transaction_id)), rules, fps, known };
}

export default function ImportarExtrato() {
  const qc = useQueryClient();
  const { index, isLoading: catsLoading } = useCategories();
  const accountsQ = useAccounts();
  const { bank, cash } = pickAccounts(accountsQ.data ?? []);

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [links, setLinks] = useState<Record<number, string>>({});
  const [mbway, setMbway] = useState<Record<number, 'expense' | 'ignore'>>({});
  const [payback, setPayback] = useState<Record<number, 'income' | 'payback'>>({});
  const [notRefund, setNotRefund] = useState<Record<number, boolean>>({});
  const [cats, setCats] = useState<Record<string, string | null>>({});
  const [showLinks, setShowLinks] = useState(false);
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  /** What will happen to each line, given the user's choices. */
  const finals = useMemo<Final[]>(() => {
    if (!loaded) return [];
    return loaded.plans.map((p, i): Final => {
      const l = loaded.lines[i];
      const kind: CategoryKind = l.debit ? 'expense' : 'income';
      const created: Final = { status: 'created', kind, key: descKey(l.description) };
      switch (p.type) {
        case 'already': return { status: 'already' };
        case 'cash': return { status: 'cash_withdrawal' };
        case 'refund': return notRefund[i] ? created : { status: 'refund' };
        case 'link': return links[i] && links[i] !== 'new' ? { status: 'linked', txId: links[i] } : created;
        case 'mbway': return mbway[i] === 'ignore' ? { status: 'ignored' } : created;
        case 'payback_maybe': return paybackChoice(p, payback[i]) === 'payback' ? { status: 'payback' } : created;
        case 'create': return created;
      }
    });
  }, [loaded, links, mbway, payback, notRefund]);

  const categoryOf = (kind: CategoryKind, key: string) => {
    const g = groupKey(kind, key);
    return g in cats ? cats[g] : categoryForKey(index, loaded?.rules ?? [], kind, key);
  };

  const groups = useMemo(() => {
    if (!loaded) return [];
    const m = new Map<string, { g: string; kind: CategoryKind; key: string; count: number; cents: number; samples: Set<string> }>();
    finals.forEach((f, i) => {
      if (f.status !== 'created') return;
      const l = loaded.lines[i];
      const g = groupKey(f.kind, f.key);
      const e = m.get(g) ?? { g, kind: f.kind, key: f.key, count: 0, cents: 0, samples: new Set<string>() };
      e.count++;
      e.cents += (l.debit ?? l.credit)!;
      e.samples.add(l.description);
      m.set(g, e);
    });
    return [...m.values()].sort((a, b) => (a.kind === b.kind ? b.cents - a.cents : a.kind === 'expense' ? -1 : 1));
  }, [loaded, finals]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of finals) c[f.status] = (c[f.status] ?? 0) + 1;
    return c;
  }, [finals]);

  const duplicateLink = useMemo(() => {
    const seen = new Set<string>();
    for (const f of finals) {
      if (f.status !== 'linked') continue;
      if (seen.has(f.txId)) return true;
      seen.add(f.txId);
    }
    return false;
  }, [finals]);

  if (Platform.OS !== 'web') {
    return (
      <View style={styles.center}>
        <Muted>A importação do extrato só está disponível na versão web (computador).</Muted>
      </View>
    );
  }

  const choose = async () => {
    if (!bank) return;
    setError(null);
    setDone(null);
    const file = await pickFile('.csv,text/csv');
    if (!file) return;
    setBusy('reading');
    try {
      const st = parseStatement(decodeStatement(await file.arrayBuffer()));
      if (!st.lines.length) throw new Error(st.errors[0] ?? 'O ficheiro não tem movimentos.');
      const ctx = await loadContext(st.lines, bank.id);
      const plans = classify(st.lines, ctx.fps.map((f) => ctx.known.has(f)), ctx.existing, ctx.linkedIds, bank.id);
      setLinks(defaultLinks(plans));
      setMbway({});
      setPayback({});
      setNotRefund({});
      setCats({});
      setShowLinks(false);
      setLoaded({ ...st, fileName: file.name, fps: ctx.fps, plans, rules: ctx.rules });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    if (!loaded || !bank || !cash) return;
    setError(null);
    setBusy('importing');
    try {
      const { lines, fps, plans } = loaded;
      const dates = lines.map((l) => l.value).sort();

      const { data: imp, error: e1 } = await supabase
        .from('imports')
        .insert({ source: 'bank_csv', file_name: loaded.fileName, period_start: loaded.periodStart ?? dates[0], period_end: loaded.periodEnd ?? dates[dates.length - 1] })
        .select('id')
        .single();
      if (e1) throw new Error(e1.message);

      // 1. transactions for created lines + ATM transfers. external_key = bank:<fingerprint>, so a retry never duplicates.
      const txFor = new Map<number, string>(); // line index → transaction id
      const upsertTx = async (rows: { i: number; row: Record<string, unknown> }[]) => {
        for (const part of chunks(rows, 500)) {
          const { error } = await supabase
            .from('transactions')
            .upsert(part.map((r) => r.row), { onConflict: 'user_id,external_key', ignoreDuplicates: true });
          if (error) throw new Error(error.message);
        }
        for (const part of chunks(rows, 100)) {
          const keys = part.map((r) => r.row.external_key as string);
          const { data, error } = await supabase.from('transactions').select('id, external_key').in('external_key', keys);
          if (error) throw new Error(error.message);
          const byKey = new Map((data ?? []).map((d) => [d.external_key, d.id]));
          for (const r of part) txFor.set(r.i, byKey.get(r.row.external_key as string)!);
        }
      };
      const base = (i: number) => ({
        date: lines[i].value,
        amount_cents: (lines[i].debit ?? lines[i].credit)!,
        account_id: bank.id,
        description: lines[i].description,
        source: 'bank_csv',
        external_key: `bank:${fps[i]}`,
      });

      const first: { i: number; row: Record<string, unknown> }[] = [];
      finals.forEach((f, i) => {
        if (f.status === 'created') first.push({ i, row: { ...base(i), kind: f.kind, category_id: categoryOf(f.kind, f.key) } });
        if (f.status === 'payback') first.push({ i, row: { ...base(i), kind: 'payback', category_id: null } });
        if (f.status === 'cash_withdrawal') first.push({ i, row: { ...base(i), kind: 'transfer', to_account_id: cash.id, category_id: null } });
        if (f.status === 'linked') txFor.set(i, f.txId);
      });
      await upsertTx(first);

      // 2. refunds (their original may be a line created or linked just above)
      const second: { i: number; row: Record<string, unknown> }[] = [];
      finals.forEach((f, i) => {
        const p = plans[i];
        if (f.status !== 'refund' || p.type !== 'refund') return;
        const of = 'tx' in p.target ? p.target.tx.id : txFor.get(p.target.lineIndex);
        if (!of) throw new Error(`Linha ${lines[i].line}: não encontrei a compra original do reembolso.`);
        second.push({ i, row: { ...base(i), kind: 'refund', refund_of_id: of, category_id: null } });
      });
      await upsertTx(second);

      // 3a. recurring movements linked with a different amount take the bank's amount and date
      for (const [i, f] of finals.entries()) {
        const p = plans[i];
        if (f.status !== 'linked' || p.type !== 'link') continue;
        const c = p.candidates.find((x) => x.tx.id === f.txId);
        if (!c?.amountDiffers) continue;
        const { error } = await supabase
          .from('transactions')
          .update({ amount_cents: (lines[i].debit ?? lines[i].credit)!, date: lines[i].value })
          .eq('id', f.txId);
        if (error) throw new Error(error.message);
      }

      // 3. linked transactions without an account now belong to the bank account
      const linkedIds = finals.flatMap((f) => (f.status === 'linked' ? [f.txId] : []));
      for (const part of chunks(linkedIds, 100)) {
        const { error } = await supabase.from('transactions').update({ account_id: bank.id }).in('id', part).is('account_id', null);
        if (error) throw new Error(error.message);
      }

      // 4. the raw statement lines (Rule 1: same fingerprint → skipped)
      const bankLines = finals.flatMap((f, i) =>
        f.status === 'already'
          ? []
          : [{
              account_id: bank.id,
              fingerprint: fps[i],
              posted_date: lines[i].posted,
              value_date: lines[i].value,
              description: lines[i].description,
              debit_cents: lines[i].debit,
              credit_cents: lines[i].credit,
              balance_cents: lines[i].balance,
              bank_category: lines[i].bankCategory,
              import_id: imp.id,
              transaction_id: txFor.get(i) ?? null,
              status: f.status === 'payback' ? 'created' : f.status,
            }],
      );
      for (const part of chunks(bankLines, 500)) {
        const { error } = await supabase.from('bank_lines').upsert(part, { onConflict: 'user_id,fingerprint', ignoreDuplicates: true });
        if (error) throw new Error(error.message);
      }

      // 5. remember categories the user chose, for the next statement
      const learned = groups
        .filter((g) => g.g in cats && cats[g.g])
        .map((g) => ({ scope: 'bank_desc', pattern: g.key, match: 'prefix', category_id: cats[g.g], origin: 'user' }));
      if (learned.length) {
        const { error } = await supabase.from('rules').upsert(learned, { onConflict: 'user_id,scope,match,pattern' });
        if (error) throw new Error(error.message);
      }

      await supabase.from('imports').update({ stats: counts }).eq('id', imp.id);
      if (!bank.bank_ref) {
        // remember which account receives CGD statements (masked number only)
        await supabase.from('accounts').update({ bank_ref: loaded.accountLabel?.split(' · ')[0] ?? 'CGD' }).eq('id', bank.id);
        qc.invalidateQueries({ queryKey: ['accounts'] });
      }

      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['transaction'] });
      qc.invalidateQueries({ queryKey: ['spend'] });
      setDone(counts);
      setLoaded(null);
    } catch (e) {
      setError(`${errorText(e)} — pode tentar de novo: as linhas já importadas são ignoradas.`);
    } finally {
      setBusy(null);
    }
  };

  const ready = !catsLoading && !accountsQ.isLoading;
  const missingAccount = ready && (!bank || !cash);
  const toImport = loaded ? loaded.lines.length - (counts.already ?? 0) : 0;

  const linkRows = loaded ? loaded.plans.map((p, i) => ({ p, i })).filter((x) => x.p.type === 'link') : [];
  const needsLook = linkRows.filter(
    ({ p, i }) => p.type === 'link' && (p.candidates.length > 1 || links[i] === 'new' || p.candidates.some((c) => c.amountDiffers)),
  );
  const visibleLinks = showLinks ? linkRows : needsLook;

  return (
    <ScrollView style={{ backgroundColor: colors.ground }} contentContainerStyle={styles.scroll} contentInsetAdjustmentBehavior="automatic">
      <View style={styles.inner}>
        <Card>
          <Text style={styles.h2}>Extrato CGD (CSV)</Text>
          <Muted>
            Exporte em caixadirecta › Consultar saldos e movimentos › exportar CSV. O ficheiro é lido no browser. Linhas já
            importadas são ignoradas; movimentos que já existem (do Excel ou introduzidos à mão) são ligados em vez de
            duplicados.
          </Muted>
          <Button label={loaded ? 'Escolher outro ficheiro' : 'Escolher ficheiro .csv'} variant={loaded ? 'secondary' : 'primary'} onPress={choose} busy={busy === 'reading'} disabled={!ready || !bank || busy !== null} />
        </Card>

        {missingAccount && <Text style={styles.error}>Faltam as contas &quot;CGD à ordem&quot; (banco) e/ou &quot;Carteira&quot; (dinheiro).</Text>}
        {error && <Text style={styles.error}>{error}</Text>}

        {done && (
          <Card style={styles.ok}>
            <Text style={styles.okText} accessibilityLiveRegion="polite">
              Importado: {done.created ?? 0} novos · {done.linked ?? 0} ligados · {done.cash_withdrawal ?? 0} levantamentos ·{' '}
              {done.refund ?? 0} reembolsos{done.payback ? ` · ${done.payback} acertos de contas` : ''}{done.ignored ? ` · ${done.ignored} ignorados` : ''}{done.already ? ` · ${done.already} já importados` : ''}.
            </Text>
            <Button label="Ver movimentos" variant="secondary" onPress={() => router.navigate('/movimentos')} />
            {(done.created ?? 0) > 0 && (
              <Button label="Compras sem talão (opcional)" variant="secondary" onPress={() => router.push('/sem-talao')} />
            )}
          </Card>
        )}

        {loaded && (
          <>
            <Card>
              <Text style={styles.h2}>{loaded.fileName}</Text>
              {loaded.accountLabel && <Stat label="Conta" value={loaded.accountLabel} />}
              {loaded.periodStart && loaded.periodEnd && <Stat label="Período" value={`${formatDate(loaded.periodStart)} – ${formatDate(loaded.periodEnd)}`} />}
              <Stat label="Linhas" value={String(loaded.lines.length)} />
              <Stat label="Já importadas (ignoradas)" value={String(counts.already ?? 0)} />
              <Stat label="Ligadas a movimentos existentes" value={String(counts.linked ?? 0)} />
              <Stat label={`Levantamentos → ${cash?.name ?? 'Carteira'} (não é despesa)`} value={String(counts.cash_withdrawal ?? 0)} />
              <Stat label="Reembolsos" value={String(counts.refund ?? 0)} />
              <Stat label="Novos movimentos" value={String(counts.created ?? 0)} />
              {(counts.payback ?? 0) > 0 && <Stat label="Acertos de contas (não são receita)" value={String(counts.payback)} />}
              {(counts.ignored ?? 0) > 0 && <Stat label="Ignorados" value={String(counts.ignored)} />}
              {loaded.chainBreaks.length === 0 ? (
                <Muted>✓ Saldos consistentes linha a linha.</Muted>
              ) : (
                <Text style={styles.error}>
                  Atenção: o saldo não bate certo nas linhas {loaded.chainBreaks.slice(0, 10).join(', ')}. O ficheiro pode estar incompleto.
                </Text>
              )}
              {loaded.errors.map((e) => <Text key={e} style={styles.error}>{e}</Text>)}
            </Card>

            {linkRows.length > 0 && (
              <Card>
                <Text style={styles.h3}>Já registados ({linkRows.length})</Text>
                <Muted>
                  Linhas do banco com o mesmo valor e data próxima (±3 dias) de um movimento que já existe — ou, nos movimentos
                  mensais (salário, contas), valor até 25% diferente; nesse caso fica o valor do banco. São ligadas, não
                  duplicadas. {needsLook.length ? `${needsLook.length} para confirmar.` : ''}
                </Muted>
                {visibleLinks.map(({ p, i }) => p.type === 'link' && (
                  <View key={i} style={styles.item}>
                    <LineHead l={loaded.lines[i]} />
                    <View style={styles.chips}>
                      {p.candidates.map((c) => (
                        <Chip
                          key={c.tx.id}
                          label={`${c.tx.description ?? 'Sem descrição'} · ${formatDate(c.tx.date)}${
                            c.amountDiffers ? ` · ${formatEUR(c.tx.amount_cents)} → ${formatEUR((loaded.lines[i].debit ?? loaded.lines[i].credit)!)}` : ''
                          }`}
                          selected={links[i] === c.tx.id}
                          onPress={() => setLinks((s) => ({ ...s, [i]: c.tx.id }))}
                        />
                      ))}
                      <Chip label="Não é este — criar novo" selected={links[i] === 'new'} onPress={() => setLinks((s) => ({ ...s, [i]: 'new' }))} />
                    </View>
                  </View>
                ))}
                {linkRows.length > needsLook.length && (
                  <Pressable accessibilityRole="button" onPress={() => setShowLinks((v) => !v)}>
                    <Text style={styles.link}>{showLinks ? 'Mostrar só as que precisam de confirmação' : `Ver todas (${linkRows.length})`}</Text>
                  </Pressable>
                )}
                {duplicateLink && <Text style={styles.error}>O mesmo movimento foi escolhido para duas linhas do banco.</Text>}
              </Card>
            )}

            {loaded.plans.some((p) => p.type === 'mbway' || p.type === 'payback_maybe' || p.type === 'refund') && (
              <Card>
                <Text style={styles.h3}>Para decidir</Text>
                {loaded.plans.map((p, i) => {
                  if (p.type === 'mbway') {
                    return (
                      <View key={i} style={styles.item}>
                        <LineHead l={loaded.lines[i]} />
                        <Muted>MB Way para uma pessoa: foi um pagamento (despesa) ou uma transferência que não conta como gasto?</Muted>
                        <View style={styles.chips}>
                          <Chip label="Despesa" selected={mbway[i] !== 'ignore'} onPress={() => setMbway((s) => ({ ...s, [i]: 'expense' }))} />
                          <Chip label="Não é gasto (ignorar)" selected={mbway[i] === 'ignore'} onPress={() => setMbway((s) => ({ ...s, [i]: 'ignore' }))} />
                        </View>
                      </View>
                    );
                  }
                  if (p.type === 'payback_maybe') {
                    const choice = paybackChoice(p, payback[i]);
                    const what = p.mbway ? 'MB Way recebido' : 'Dinheiro recebido';
                    return (
                      <View key={i} style={styles.item}>
                        <LineHead l={loaded.lines[i]} />
                        <Muted>
                          {p.splitBill
                            ? `${what}. Pode ser a parte de alguém da conta dividida ${p.splitBill}: nesse caso é um acerto de contas, não receita.`
                            : `${what}: é uma receita, ou alguém a pagar a parte de uma conta dividida (acerto de contas, não conta como receita)?`}
                        </Muted>
                        <View style={styles.chips}>
                          <Chip label="Receita" selected={choice === 'income'} onPress={() => setPayback((s) => ({ ...s, [i]: 'income' }))} />
                          <Chip label="Acerto de contas" selected={choice === 'payback'} onPress={() => setPayback((s) => ({ ...s, [i]: 'payback' }))} />
                        </View>
                      </View>
                    );
                  }
                  if (p.type === 'refund') {
                    return (
                      <View key={i} style={styles.item}>
                        <LineHead l={loaded.lines[i]} />
                        <Muted>Reembolso de: {p.targetLabel}</Muted>
                        <View style={styles.chips}>
                          <Chip label="Reembolso" selected={!notRefund[i]} onPress={() => setNotRefund((s) => ({ ...s, [i]: false }))} />
                          <Chip label="Não — é receita" selected={!!notRefund[i]} onPress={() => setNotRefund((s) => ({ ...s, [i]: true }))} />
                        </View>
                      </View>
                    );
                  }
                  return null;
                })}
              </Card>
            )}

            {groups.length > 0 && (
              <Card>
                <Text style={styles.h3}>Categorias dos novos movimentos</Text>
                <Muted>Agrupados pela descrição do banco. O que escolher fica memorizado para os próximos extratos.</Muted>
                {groups.map((g) => {
                  const id = categoryOf(g.kind, g.key);
                  return (
                    <View key={g.g} style={styles.mapRow}>
                      <View style={styles.mapFrom}>
                        <Text style={styles.mapName}>{[...g.samples].slice(0, 2).join(' · ')}</Text>
                        <Muted>
                          {g.kind === 'income' ? 'Receita' : 'Despesa'} · {g.count} · {formatEUR(g.cents)}
                        </Muted>
                      </View>
                      <View style={styles.mapTo}>
                        <FieldLabel>Categoria</FieldLabel>
                        <CategoryPicker index={index} kind={g.kind} value={id} onChange={(v) => setCats((s) => ({ ...s, [g.g]: v }))} />
                      </View>
                    </View>
                  );
                })}
              </Card>
            )}

            <Button
              label={toImport ? `Importar ${toImport} linhas` : 'Nada de novo para importar'}
              onPress={runImport}
              busy={busy === 'importing'}
              disabled={!toImport || missingAccount || duplicateLink || busy !== null}
            />
          </>
        )}

        {busy === 'reading' && <ActivityIndicator />}
      </View>
    </ScrollView>
  );
}

function LineHead({ l }: { l: BankLine }) {
  const a = amountOf(l);
  return (
    <View style={styles.stat}>
      <Text style={styles.lineDesc} numberOfLines={1}>
        {formatDate(l.value)} · {l.description}
      </Text>
      <Text style={[styles.statValue, a > 0 && { color: colors.income }]}>{formatEUR(a, { sign: a > 0 })}</Text>
    </View>
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
  item: { gap: space.xs, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  lineDesc: { fontSize: 14, color: colors.ink, flexShrink: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', paddingVertical: space.xs },
  mapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border },
  mapFrom: { flexGrow: 1, flexBasis: 180, gap: 2 },
  mapTo: { flexGrow: 2, flexBasis: 240, gap: 4 },
  mapName: { fontSize: 15, fontWeight: '600', color: colors.ink },
});
