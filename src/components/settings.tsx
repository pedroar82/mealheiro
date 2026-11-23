// Definições sections (SPEC §8): categorias, regras, contas, importações.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Chip, Muted, Segmented } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { pickAccounts } from '@/lib/excel-import';
import { formatDate } from '@/lib/format';
import { fetchAll } from '@/lib/import-io';
import { useAccounts, useCategories, useCreateCategory } from '@/lib/queries';
import { supabase } from '@/lib/supabase';
import type { Category, CategoryKind } from '@/lib/types';

const ALL_DATA = ['categories', 'transactions', 'spend', 'explore', 'line_items', 'rules', 'accounts', 'recurring'];

function useInvalidate() {
  const qc = useQueryClient();
  return () => ALL_DATA.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

async function check<T extends { error: { message: string; code?: string } | null }>(p: PromiseLike<T>): Promise<T> {
  const r = await p;
  if (r.error) throw new Error(r.error.code === '23505' ? 'Já existe um com esse nome.' : r.error.message);
  return r;
}

const Field = (props: React.ComponentProps<typeof TextInput>) => <TextInput {...props} style={[styles.input, props.style]} />;

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------
export function CategoriesSection() {
  const { index } = useCategories();
  const create = useCreateCategory();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const [newRoot, setNewRoot] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);
  const toggleOpen = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const roots = (index.children.get(null) ?? []).filter((c) => c.kind === kind);
  const active = roots.filter((c) => !c.archived);
  const archived = [...index.byId.values()].filter((c) => c.kind === kind && c.archived);

  return (
    <>
      <Segmented
        options={[
          { value: 'expense', label: 'Despesas' },
          { value: 'income', label: 'Receitas' },
        ]}
        value={kind}
        onChange={(k) => (setKind(k), setEditing(null))}
      />
      <Muted>Toque no nome para ver ou esconder as subcategorias; ✎ para mudar o nome, arquivar ou acrescentar subcategorias.</Muted>

      {active.map((root) => (
        <Card key={root.id} style={styles.catCard}>
          <Tree
            c={root}
            depth={0}
            editing={editing}
            setEditing={setEditing}
            expanded={expanded}
            toggleOpen={toggleOpen}
          />
        </Card>
      ))}

      <Card>
        <Text style={styles.h3}>Nova categoria principal</Text>
        <View style={styles.inline}>
          <Field value={newRoot} onChangeText={setNewRoot} placeholder={kind === 'expense' ? 'ex.: Animais' : 'ex.: Rendas'} style={{ flex: 1 }} />
          <Button
            label="Criar"
            busy={create.isPending}
            onPress={() => create.mutate({ name: newRoot, parent_id: null, kind }, { onSuccess: () => setNewRoot('') })}
          />
        </View>
        {create.error && <Text style={styles.error}>{create.error.message}</Text>}
      </Card>

      {archived.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setShowArchived((v) => !v)}>
          <Text style={styles.link}>{showArchived ? 'Esconder arquivadas' : `Ver arquivadas (${archived.length})`}</Text>
        </Pressable>
      )}
      {showArchived &&
        archived.map((c) => (
          <Card key={c.id} style={styles.catCard}>
            <ArchivedRow c={c} path={categoryPath(index, c.id)} />
          </Card>
        ))}
    </>
  );
}

/** A category and (when open) its subcategories, recursively. */
function Tree({
  c,
  depth,
  editing,
  setEditing,
  expanded,
  toggleOpen,
}: {
  c: Category;
  depth: number;
  editing: string | null;
  setEditing: (id: string | null) => void;
  expanded: Set<string>;
  toggleOpen: (id: string) => void;
}) {
  const { index } = useCategories();
  const subs = (index.children.get(c.id) ?? []).filter((x) => !x.archived);
  const isOpen = depth === 0 ? !expanded.has(c.id) : expanded.has(c.id); // main categories start open
  return (
    <>
      <CategoryRow
        c={c}
        depth={depth}
        editing={editing === c.id}
        onToggle={() => setEditing(editing === c.id ? null : c.id)}
        subs={subs.length}
        open={isOpen}
        onOpen={() => toggleOpen(c.id)}
      />
      {editing === c.id && <AddSub parent={c} />}
      {isOpen &&
        subs.map((s) => (
          <Tree key={s.id} c={s} depth={depth + 1} editing={editing} setEditing={setEditing} expanded={expanded} toggleOpen={toggleOpen} />
        ))}
    </>
  );
}

function CategoryRow({
  c,
  depth,
  editing,
  onToggle,
  subs,
  open,
  onOpen,
}: {
  c: Category;
  depth: number;
  editing: boolean;
  onToggle: () => void;
  subs: number;
  open: boolean;
  onOpen: () => void;
}) {
  const bold = depth === 0;
  const invalidate = useInvalidate();
  const [name, setName] = useState(c.name);
  const save = useMutation({
    mutationFn: async (patch: Partial<Category>) => {
      await check(supabase.from('categories').update(patch).eq('id', c.id));
    },
    onSuccess: () => (invalidate(), onToggle()),
  });
  return (
    <View style={!bold && styles.subRowWrap}>
      <View style={[styles.catRow, { paddingLeft: depth * 16 }]}>
        {subs > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${open ? 'Esconder' : 'Mostrar'} as ${subs} subcategorias de ${c.name}`}
            onPress={onOpen}
            style={styles.twisty}>
            <Text style={styles.twistyText}>{open ? '▾' : '▸'}</Text>
          </Pressable>
        ) : (
          <View style={styles.twisty} />
        )}
        {/* the name opens/closes a category with subcategories; ✎ edits */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={subs > 0 ? `${open ? 'Esconder' : 'Mostrar'} subcategorias de ${c.name}` : `Editar ${c.name}`}
          onPress={subs > 0 ? onOpen : onToggle}
          style={styles.catName}>
          <Text style={[bold ? styles.rootName : styles.subName]}>
            {c.name}
            {subs > 0 && !open ? <Text style={styles.count}> · {subs}</Text> : null}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Editar ${c.name}`} onPress={onToggle} style={styles.edit}>
          <Text style={[styles.editText, editing && { color: colors.accent }]}>{editing ? '−' : '✎'}</Text>
        </Pressable>
      </View>
      {editing && (
        <View style={styles.editBox}>
          <View style={styles.inline}>
            <Field value={name} onChangeText={setName} style={{ flex: 1 }} accessibilityLabel="Nome" />
            <Button label="Guardar" busy={save.isPending} disabled={!name.trim() || name.trim() === c.name} onPress={() => save.mutate({ name: name.trim() })} />
          </View>
          <Button
            label={bold ? 'Arquivar (e as subcategorias deixam de aparecer)' : 'Arquivar'}
            variant="secondary"
            onPress={() => save.mutate({ archived: true })}
          />
          <Muted>Arquivar não apaga nada: os movimentos antigos mantêm a categoria; só deixa de aparecer na escolha.</Muted>
          {save.error && <Text style={styles.error}>{save.error.message}</Text>}
        </View>
      )}
    </View>
  );
}

function AddSub({ parent }: { parent: Category }) {
  const create = useCreateCategory();
  const [name, setName] = useState('');
  return (
    <View style={styles.editBox}>
      <View style={styles.inline}>
        <Field value={name} onChangeText={setName} placeholder={`Nova subcategoria de ${parent.name}`} style={{ flex: 1 }} />
        <Button
          label="Criar"
          busy={create.isPending}
          onPress={() => create.mutate({ name, parent_id: parent.id, kind: parent.kind }, { onSuccess: () => setName('') })}
        />
      </View>
      {create.error && <Text style={styles.error}>{create.error.message}</Text>}
    </View>
  );
}

function ArchivedRow({ c, path }: { c: Category; path: string }) {
  const invalidate = useInvalidate();
  const restore = useMutation({
    mutationFn: async () => {
      await check(supabase.from('categories').update({ archived: false }).eq('id', c.id));
    },
    onSuccess: invalidate,
  });
  return (
    <View style={styles.inline}>
      <Text style={[styles.subName, { flex: 1 }]}>{path}</Text>
      <Button label="Restaurar" variant="secondary" busy={restore.isPending} onPress={() => restore.mutate()} />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Regras
// ---------------------------------------------------------------------------
type Rule = { id: string; scope: 'line_item' | 'bank_desc' | 'note'; pattern: string; match: string; category_id: string | null; origin: string };

const SCOPE: Record<Rule['scope'], string> = { line_item: 'Produtos dos talões', bank_desc: 'Extrato bancário', note: 'Notas do Excel' };
const MATCH: Record<string, string> = { exact: 'igual a', prefix: 'começa por', contains: 'contém' };

export function RulesSection() {
  const { index } = useCategories();
  const [scope, setScope] = useState<Rule['scope']>('line_item');
  const [q, setQ] = useState('');
  const rules = useQuery({
    queryKey: ['rules'],
    queryFn: () =>
      fetchAll<Rule>((a, b) => supabase.from('rules').select('id, scope, pattern, match, category_id, origin').order('pattern').order('id').range(a, b)),
  });
  const list = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return (rules.data ?? []).filter(
      (r) => r.scope === scope && (!needle || r.pattern.includes(needle) || categoryPath(index, r.category_id).toUpperCase().includes(needle)),
    );
  }, [rules.data, scope, q, index]);
  const counts = (s: Rule['scope']) => (rules.data ?? []).filter((r) => r.scope === s).length;

  return (
    <>
      <Muted>
        Regras aprendidas quando corrige uma categoria: o texto impresso (ou a descrição do banco) passa a ir sempre para essa
        categoria. Pode mudar a categoria ou apagar a regra.
      </Muted>
      <View style={styles.chips}>
        {(Object.keys(SCOPE) as Rule['scope'][]).map((s) => (
          <Chip key={s} label={`${SCOPE[s]} (${counts(s)})`} selected={scope === s} onPress={() => setScope(s)} />
        ))}
      </View>
      <Field value={q} onChangeText={setQ} placeholder="Procurar texto ou categoria" autoCapitalize="none" autoCorrect={false} />
      {rules.error && <Text style={styles.error}>{rules.error.message}</Text>}
      {rules.data && list.length === 0 && <Muted>Sem regras.</Muted>}
      {list.slice(0, 100).map((r) => (
        <RuleRow key={r.id} r={r} />
      ))}
      {list.length > 100 && <Muted>+ {list.length - 100} — use a pesquisa para encontrar as restantes.</Muted>}
    </>
  );
}

function RuleRow({ r }: { r: Rule }) {
  const { index } = useCategories();
  const invalidate = useInvalidate();
  const update = useMutation({
    mutationFn: async (category_id: string | null) => {
      await check(supabase.from('rules').update({ category_id, origin: 'user' }).eq('id', r.id));
    },
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async () => {
      await check(supabase.from('rules').delete().eq('id', r.id));
    },
    onSuccess: invalidate,
  });
  const kind: CategoryKind = r.category_id ? (index.byId.get(r.category_id)?.kind ?? 'expense') : 'expense';
  return (
    <Card style={styles.ruleCard}>
      <Text style={styles.pattern}>
        <Text style={styles.matchWord}>{MATCH[r.match] ?? r.match} </Text>
        {r.pattern}
      </Text>
      <CategoryPicker index={index} kind={kind} value={r.category_id} onChange={(id) => update.mutate(id)} />
      <View style={styles.inline}>
        <Muted>{r.origin === 'user' ? 'Criada por si' : r.origin === 'ai' ? 'Sugerida pelo modelo' : 'Predefinida'}</Muted>
        <View style={{ flex: 1 }} />
        <Pressable accessibilityRole="button" onPress={() => remove.mutate()} disabled={remove.isPending} style={styles.smallBtn}>
          <Text style={styles.danger}>{remove.isPending ? 'A apagar…' : 'Apagar'}</Text>
        </Pressable>
      </View>
      {(update.error ?? remove.error) && <Text style={styles.error}>{(update.error ?? remove.error)!.message}</Text>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------
type Account = { id: string; name: string; type: 'bank' | 'cash' | 'other'; bank_ref?: string | null };
const TYPE: Record<Account['type'], string> = { bank: 'Banco', cash: 'Dinheiro', other: 'Outra' };

export function AccountsSection() {
  const accounts = useAccounts();
  const roles = pickAccounts(accounts.data ?? []);
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [type, setType] = useState<Account['type']>('bank');
  const add = useMutation({
    mutationFn: async () => {
      if (!name.trim()) throw new Error('Escreva um nome.');
      await check(supabase.from('accounts').insert({ name: name.trim(), type }));
    },
    onSuccess: () => (setName(''), invalidate()),
  });
  return (
    <>
      <Muted>Pode mudar os nomes à vontade: a conta do extrato CGD e a dos levantamentos continuam a ser reconhecidas.</Muted>
      {(accounts.data ?? []).map((a) => (
        <AccountRow key={a.id} a={a as Account} role={a.id === roles.bank?.id ? 'bank' : a.id === roles.cash?.id ? 'cash' : null} />
      ))}
      <Card>
        <Text style={styles.h3}>Nova conta</Text>
        <Field value={name} onChangeText={setName} placeholder="ex.: Cartão refeição" />
        <View style={styles.chips}>
          {(Object.keys(TYPE) as Account['type'][]).map((t) => (
            <Chip key={t} label={TYPE[t]} selected={type === t} onPress={() => setType(t)} />
          ))}
        </View>
        <Button label="Criar conta" busy={add.isPending} onPress={() => add.mutate()} />
        {add.error && <Text style={styles.error}>{add.error.message}</Text>}
      </Card>
    </>
  );
}

function AccountRow({ a, role }: { a: Account; role: 'bank' | 'cash' | null }) {
  const invalidate = useInvalidate();
  const [name, setName] = useState(a.name);
  const save = useMutation({
    mutationFn: async () => {
      // the CGD import account is pinned by bank_ref before its name changes
      const pin = role === 'bank' && !a.bank_ref ? { bank_ref: 'CGD' } : {};
      await check(supabase.from('accounts').update({ name: name.trim(), ...pin }).eq('id', a.id));
    },
    onSuccess: invalidate,
  });
  return (
    <Card>
      <Muted>
        {TYPE[a.type] ?? a.type}
        {role === 'bank' ? ' · recebe o extrato CGD' : role === 'cash' ? ' · recebe os levantamentos' : ''}
        {a.bank_ref ? ` · ${a.bank_ref}` : ''}
      </Muted>
      <View style={styles.inline}>
        <Field value={name} onChangeText={setName} style={{ flex: 1 }} accessibilityLabel={`Nome da conta ${a.name}`} />
        <Button label="Guardar" busy={save.isPending} disabled={!name.trim() || name.trim() === a.name} onPress={() => save.mutate()} />
      </View>
      {save.error && <Text style={styles.error}>{save.error.message}</Text>}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Importações
// ---------------------------------------------------------------------------
type ImportRow = { id: string; source: 'excel' | 'bank_csv'; file_name: string | null; period_start: string | null; period_end: string | null; stats: Record<string, number>; created_at: string };

const STAT: Record<string, string> = {
  inserted: 'novos',
  already: 'já existiam',
  created: 'novos',
  linked: 'ligados',
  cash_withdrawal: 'levantamentos',
  refund: 'reembolsos',
  already_imported: 'já importadas',
  ignored: 'ignoradas',
};

export function ImportsSection() {
  const imports = useQuery({
    queryKey: ['imports'],
    queryFn: async () => {
      const { data, error } = await supabase.from('imports').select('id, source, file_name, period_start, period_end, stats, created_at').order('created_at', { ascending: false }).limit(100);
      if (error) throw new Error(error.message);
      return data as ImportRow[];
    },
  });
  return (
    <>
      <View style={styles.inline}>
        <View style={{ flex: 1 }}>
          <Button label="Importar extrato CGD" variant="secondary" onPress={() => router.push('/importar-extrato')} />
        </View>
        <View style={{ flex: 1 }}>
          <Button label="Importar Excel" variant="secondary" onPress={() => router.push('/importar-excel')} />
        </View>
      </View>
      {imports.error && <Text style={styles.error}>{imports.error.message}</Text>}
      {imports.data?.length === 0 && <Muted>Ainda não fez nenhuma importação.</Muted>}
      {imports.data?.map((i) => (
        <Card key={i.id} style={styles.ruleCard}>
          <Text style={styles.h3}>{i.source === 'excel' ? 'Histórico do Excel' : 'Extrato CGD'}</Text>
          <Muted>
            {formatDate(i.created_at.slice(0, 10))}
            {i.file_name ? ` · ${i.file_name}` : ''}
          </Muted>
          {i.period_start && i.period_end && (
            <Muted>
              Movimentos de {formatDate(i.period_start)} a {formatDate(i.period_end)}
            </Muted>
          )}
          {Object.keys(i.stats ?? {}).length > 0 && (
            <Text style={styles.stats}>
              {Object.entries(i.stats)
                .filter(([k, v]) => STAT[k] && v)
                .map(([k, v]) => `${v} ${STAT[k]}`)
                .join(' · ')}
            </Text>
          )}
        </Card>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  error: { color: colors.danger, fontSize: 14 },
  link: { color: colors.accent, fontSize: 14, fontWeight: '600', paddingVertical: space.xs },
  catCard: { gap: 0, paddingVertical: space.xs },
  catRow: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  catName: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  twisty: { width: 36, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  twistyText: { fontSize: 14, color: colors.accent },
  edit: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  editText: { fontSize: 16, color: colors.muted },
  count: { fontSize: 13, color: colors.muted, fontWeight: '400' },
  subRowWrap: { borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  rootName: { flex: 1, fontSize: 16, fontWeight: '600', color: colors.ink },
  subName: { flex: 1, fontSize: 15, color: colors.ink },
  chev: { fontSize: 18, color: colors.muted, paddingHorizontal: space.sm },
  editBox: { gap: space.sm, paddingBottom: space.sm },
  ruleCard: { gap: space.sm },
  pattern: { fontSize: 14, fontWeight: '600', color: colors.ink, fontFamily: undefined },
  matchWord: { fontWeight: '400', color: colors.muted },
  smallBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  danger: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  stats: { fontSize: 13, color: colors.ink },
});
