// "Criar regras": the user writes a rule — for a movement's description (any source: bank, Excel, manual, receipts
// and invoices) or for a product of the receipts — sees what it catches grouped by the category it has now, chooses
// which groups move, and saves. Below: what has no category and no rule yet, to start a rule from.
// The user's rules win over the history and the model (SPEC §11, 26/11/2026).

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useRef, useState, type ComponentRef } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Chip, FieldLabel, Muted, Segmented } from '@/components/ui';
import { colors, maxContentWidth, radius, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { formatDate, formatEUR } from '@/lib/format';
import { errorText } from '@/lib/import-io';
import { useCategories } from '@/lib/queries';
import {
  applyCategory,
  caught,
  loadRuleData,
  rulePattern,
  saveRule,
  suggestions,
  undoApply,
  type Applied,
  type Item,
  type RuleMatch,
  type RuleScope,
} from '@/lib/rule-builder';
import { isAncestor } from '@/lib/rule-match';
import type { CategoryKind } from '@/lib/types';

const NONE = 'none';
const SHOWN = 30;
const MATCH_LABEL: Record<RuleMatch, string> = { exact: 'Igual a', prefix: 'Começa por', contains: 'Contém' };

export default function CriarRegras() {
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ text?: string; kind?: string; scope?: string }>();
  const { index } = useCategories();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);

  const [scope, setScope] = useState<RuleScope>(params.scope === 'line' ? 'line' : 'desc');
  const [kind, setKind] = useState<CategoryKind>(params.kind === 'income' ? 'income' : 'expense');
  const [text, setText] = useState(params.text ?? '');
  const [match, setMatch] = useState<RuleMatch>(params.scope === 'line' ? 'contains' : 'prefix');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Map<string, boolean>>(new Map()); // the user's ticks over the defaults
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ pattern: string; applied: Applied } | null>(null);
  const [allSugg, setAllSugg] = useState(false);

  const data = useQuery({ queryKey: ['rule-data'], queryFn: loadRuleData });
  const ruleKind: CategoryKind = scope === 'line' ? 'expense' : kind;
  const pattern = rulePattern(scope, text, match);

  // what the rule catches, by the category it has now
  const groups = useMemo(() => {
    if (!data.data) return [];
    const by = new Map<string, Item[]>();
    for (const i of caught(data.data, scope, pattern, match, ruleKind)) {
      const k = i.category_id ?? NONE;
      by.set(k, [...(by.get(k) ?? []), i]);
    }
    return [...by.entries()].sort((a, b) => (a[0] === NONE ? -1 : b[0] === NONE ? 1 : b[1].length - a[1].length));
  }, [data.data, scope, pattern, match, ruleKind]);

  const isPicked = (k: string) => {
    if (categoryId && k === categoryId) return false; // already there
    if (picked.has(k)) return picked.get(k)!;
    return k === NONE || (!!categoryId && isAncestor(index, k, categoryId)); // default: no category + the levels above
  };
  const toMove = groups.filter(([k]) => isPicked(k)).flatMap(([, list]) => list);

  const sugg = useMemo(() => (data.data ? suggestions(data.data, index, scope) : []), [data.data, index, scope]);

  const refresh = () =>
    ['transactions', 'transaction', 'spend', 'explore', 'line_items', 'rules', 'rule-data'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const reset = () => {
    setText('');
    setCategoryId(null);
    setPicked(new Map());
  };

  const save = async () => {
    if (!pattern || !categoryId || !data.data) return;
    setBusy(true);
    setError(null);
    try {
      await saveRule(scope, pattern, match, categoryId);
      const applied = await applyCategory(data.data, index, toMove, categoryId);
      setDone({ pattern, applied });
      reset();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const undo = async () => {
    if (!done) return;
    setBusy(true);
    setError(null);
    try {
      await undoApply(done.applied);
      setDone(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const changeScope = (s: RuleScope) => {
    setScope(s);
    setMatch(s === 'line' ? 'contains' : 'prefix');
    reset();
    setDone(null);
    setAllSugg(false);
  };

  const startFrom = (t: string, k: CategoryKind) => {
    setKind(k);
    setText(t);
    setMatch(scope === 'line' ? 'exact' : 'prefix');
    setCategoryId(null);
    setPicked(new Map());
    setDone(null);
    scroll.current?.scrollTo({ y: 0, animated: true });
  };

  const matches: RuleMatch[] = scope === 'line' ? ['exact', 'prefix', 'contains'] : ['prefix', 'contains'];

  return (
    <ScrollView
      ref={scroll}
      style={styles.page}
      contentContainerStyle={styles.scroll}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets>
      <View style={styles.inner}>
        <Segmented
          options={[
            { value: 'desc', label: 'Descrição do movimento' },
            { value: 'line', label: 'Produto' },
          ]}
          value={scope}
          onChange={changeScope}
        />

        {done && (
          <Card>
            <Text style={styles.summary} accessibilityLiveRegion="polite">
              Regra guardada: «{done.pattern}» → {categoryPath(index, done.applied.categoryId)}.
              {done.applied.count > 0 ? ` ${done.applied.count} mudaram de categoria.` : ''}
            </Text>
            <Muted>A regra fica em Definições › Regras e vale para o que entrar a seguir.</Muted>
            {done.applied.count > 0 && <Button label="Anular a mudança" variant="secondary" busy={busy} onPress={undo} />}
          </Card>
        )}

        <Card>
          <Text style={styles.h3}>Nova regra</Text>
          <Muted>
            {scope === 'desc'
              ? 'Para a descrição de qualquer movimento: banco, Excel, manual, faturas e talões (o nome da loja ou do fornecedor). Numa fatura com produtos, a regra muda os produtos sem categoria ou num nível acima.'
              : 'Para o texto impresso ou o nome de um produto dos talões e faturas.'}{' '}
            As suas regras passam à frente do histórico e das sugestões do modelo.
          </Muted>
          {scope === 'desc' && (
            <Segmented
              options={[
                { value: 'expense', label: 'Despesa' },
                { value: 'income', label: 'Receita' },
              ]}
              value={kind}
              onChange={(k) => {
                setKind(k);
                setCategoryId(null);
              }}
            />
          )}
          <FieldLabel nativeID="rule-text">{scope === 'desc' ? 'Descrição' : 'Produto'}</FieldLabel>
          <TextInput
            accessibilityLabelledBy="rule-text"
            accessibilityLabel={scope === 'desc' ? 'Descrição' : 'Produto'}
            value={text}
            onChangeText={(v) => {
              setText(v);
              setDone(null);
            }}
            placeholder={scope === 'desc' ? 'ex.: EDP COMERCIAL' : 'ex.: LEITE'}
            autoCapitalize="characters"
            autoCorrect={false}
            style={styles.input}
            placeholderTextColor={colors.muted}
          />
          <View style={styles.chips}>
            {matches.map((m) => (
              <Chip key={m} label={MATCH_LABEL[m]} selected={match === m} onPress={() => setMatch(m)} />
            ))}
          </View>
          <FieldLabel>Categoria</FieldLabel>
          <CategoryPicker index={index} kind={ruleKind} value={categoryId} onChange={setCategoryId} />

          {data.isLoading && <ActivityIndicator />}
          {data.error && <Text style={styles.error}>{data.error.message}</Text>}
          {pattern !== '' && data.data && groups.length === 0 && <Muted>Nada tem este texto.</Muted>}
          {groups.length > 0 && (
            <>
              <Text style={styles.h4}>O que a regra apanha</Text>
              <Muted>Escolha o que muda para a categoria da regra. O que já está noutra subcategoria fica como está, a não ser que o marque.</Muted>
              {groups.map(([k, list]) => {
                const here = !!categoryId && k === categoryId;
                const label = k === NONE ? 'Sem categoria' : categoryPath(index, k);
                return (
                  <View key={k} style={styles.group}>
                    {here ? (
                      <Muted>
                        {label} · {list.length} (já estão nesta categoria)
                      </Muted>
                    ) : (
                      <Chip
                        label={`${isPicked(k) ? '✓ ' : ''}${label} · ${list.length}`}
                        selected={isPicked(k)}
                        onPress={() => setPicked(new Map(picked).set(k, !isPicked(k)))}
                      />
                    )}
                    {list.slice(0, 3).map((i) => (
                      <View key={i.id} style={styles.txRow}>
                        <Text style={styles.date}>{formatDate(i.date)}</Text>
                        <Text style={styles.desc} numberOfLines={1}>
                          {i.label}
                          {i.type === 'line' && i.shop ? <Text style={styles.example}> · {i.shop}</Text> : null}
                        </Text>
                        <Text style={styles.amount}>{formatEUR(i.cents)}</Text>
                      </View>
                    ))}
                    {list.length > 3 && <Muted>+ {list.length - 3}</Muted>}
                  </View>
                );
              })}
            </>
          )}

          {error && <Text style={styles.error}>{error}</Text>}
          <Button
            label={toMove.length ? `Guardar regra e mudar ${toMove.length}` : 'Guardar regra'}
            busy={busy}
            disabled={!pattern || !categoryId || busy || !data.data}
            onPress={save}
          />
        </Card>

        <Card>
          <Text style={styles.h3}>{scope === 'desc' ? 'Sem categoria, por descrição' : 'Produtos sem categoria'}</Text>
          <Muted>
            {scope === 'desc' ? 'As descrições mais frequentes sem regra.' : 'Os produtos sem categoria mais frequentes.'} Toque num para começar a
            regra.
          </Muted>
          {data.isLoading && <ActivityIndicator />}
          {data.data && sugg.length === 0 && <Muted>Nada por resolver.</Muted>}
          {(allSugg ? sugg : sugg.slice(0, SHOWN)).map((s) => (
            <Pressable
              key={`${s.kind}|${s.text}`}
              accessibilityRole="button"
              accessibilityHint="Preenche a nova regra com este texto"
              onPress={() => startFrom(s.text, s.kind)}
              style={styles.suggRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.desc} numberOfLines={1}>
                  {s.text}
                </Text>
                <Text style={styles.example} numberOfLines={1}>
                  {s.kind === 'income' ? 'Receita · ' : ''}ex.: {s.example}
                </Text>
              </View>
              <Text style={styles.count}>{s.count}×</Text>
              <Text style={styles.amount}>{formatEUR(s.cents)}</Text>
            </Pressable>
          ))}
          {!allSugg && sugg.length > SHOWN && (
            <Pressable accessibilityRole="button" onPress={() => setAllSugg(true)} style={styles.more}>
              <Text style={styles.link}>Ver todos ({sugg.length})</Text>
            </Pressable>
          )}
        </Card>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  h4: { fontSize: 14, fontWeight: '700', color: colors.ink, marginTop: space.sm },
  summary: { fontSize: 14, color: colors.ink, fontWeight: '600' },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  group: { gap: 4, paddingTop: space.sm, borderTopWidth: 1, borderTopColor: colors.border, alignItems: 'flex-start' },
  txRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm, alignSelf: 'stretch' },
  date: { fontSize: 12, color: colors.muted, fontVariant: ['tabular-nums'] },
  desc: { flex: 1, fontSize: 14, color: colors.ink },
  example: { fontSize: 12, color: colors.muted },
  amount: { fontSize: 14, fontWeight: '600', color: colors.ink, fontVariant: ['tabular-nums'] },
  count: { fontSize: 13, color: colors.muted, fontVariant: ['tabular-nums'] },
  suggRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 44, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.border },
  more: { minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  link: { fontSize: 15, color: colors.accent, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
});
