// Definições › Categorias › Grupos: named sets of categories across the tree, for analysis in Explorar
// (e.g. "Bebidas" = Alimentação › Bebidas + Supermercado › Águas / Refrigerantes / Alcoólicas + Restaurantes › Bebidas).

import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CategoryPicker } from '@/components/category-picker';
import { Button, Card, Muted } from '@/components/ui';
import { colors, radius, space } from '@/constants/theme';
import { categoryPath } from '@/lib/categories';
import { useCategories, useGroupChange, useGroups } from '@/lib/queries';
import type { CategoryGroup } from '@/lib/types';

export function GroupsSection() {
  const groups = useGroups();
  const change = useGroupChange();
  const [name, setName] = useState('');

  return (
    <View style={{ gap: space.md }}>
      <Text style={styles.h2}>Grupos</Text>
      <Muted>
        Um grupo junta categorias de sítios diferentes para as analisar em conjunto no Explorar — por exemplo, Bebidas: as do
        supermercado, dos restaurantes e dos cafés. Cada categoria conta com as suas subcategorias.
      </Muted>
      {groups.error && <Text style={styles.error}>{groups.error.message}</Text>}
      <Card>
        <Text style={styles.h3}>Produtos</Text>
        <Muted>
          O mesmo produto com nomes diferentes nos talões (“LEITE MIMOSA M/G 1L”, “Leite meio-gordo 1L”) fica junto, com a
          marca e o tamanho. Agrupe os talões antigos e corrija aqui.
        </Muted>
        <Button label="Ver produtos" variant="secondary" onPress={() => router.push('/produtos')} />
      </Card>
      <Card>
        <Text style={styles.h3}>Detalhar produtos</Text>
        <Muted>
          Produtos de talões que ficaram numa categoria geral (ex.: só “Supermercado” ou “Talho”): o Claude sugere a categoria
          mais detalhada de cada um e revê antes de guardar.
        </Muted>
        <Button label="Reorganizar produtos" variant="secondary" onPress={() => router.push('/reorganizar-supermercado')} />
      </Card>
      {(groups.data ?? []).map((g) => <GroupCard key={g.id} g={g} />)}
      <Card>
        <Text style={styles.h3}>Novo grupo</Text>
        <View style={styles.inline}>
          <TextInput style={[styles.input, { flex: 1 }]} value={name} onChangeText={setName} placeholder="ex.: Pequeno-almoço" />
          <Button label="Criar" busy={change.isPending} onPress={() => change.mutate({ op: 'create', name }, { onSuccess: () => setName('') })} />
        </View>
        {change.error && <Text style={styles.error}>{change.error.message}</Text>}
      </Card>
    </View>
  );
}

function GroupCard({ g }: { g: CategoryGroup }) {
  const { index } = useCategories();
  const change = useGroupChange();
  const [name, setName] = useState(g.name);
  const [confirm, setConfirm] = useState(false);
  const members = [...g.members].sort((a, b) => categoryPath(index, a).localeCompare(categoryPath(index, b), 'pt'));

  return (
    <Card>
      <View style={styles.inline}>
        <TextInput style={[styles.input, styles.name, { flex: 1 }]} value={name} onChangeText={setName} accessibilityLabel="Nome do grupo" />
        {name.trim() !== g.name && (
          <Button label="Guardar" busy={change.isPending} onPress={() => change.mutate({ op: 'rename', id: g.id, name })} />
        )}
      </View>
      {members.length === 0 && <Muted>Ainda sem categorias.</Muted>}
      {members.map((id) => (
        <View key={id} style={styles.member}>
          <Text style={styles.memberText}>{categoryPath(index, id)}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Tirar ${categoryPath(index, id)} do grupo`}
            onPress={() => change.mutate({ op: 'remove', id: g.id, categoryId: id })}
            style={styles.remove}>
            <Text style={styles.removeText}>✕</Text>
          </Pressable>
        </View>
      ))}
      <Muted>Juntar categoria:</Muted>
      <CategoryPicker index={index} kind="expense" value={null} onChange={(id) => id && change.mutate({ op: 'add', id: g.id, categoryId: id })} />
      {confirm ? (
        <View style={styles.inline}>
          <Button label="Sim, apagar o grupo" variant="danger" busy={change.isPending} onPress={() => change.mutate({ op: 'delete', id: g.id })} />
          <Button label="Cancelar" variant="secondary" onPress={() => setConfirm(false)} />
        </View>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => setConfirm(true)} style={styles.smallBtn}>
          <Text style={styles.danger}>Apagar grupo (as categorias ficam)</Text>
        </Pressable>
      )}
      {change.error && <Text style={styles.error}>{change.error.message}</Text>}
    </Card>
  );
}

const styles = StyleSheet.create({
  h2: { fontSize: 18, fontWeight: '700', color: colors.ink, marginTop: space.md },
  h3: { fontSize: 15, fontWeight: '700', color: colors.ink },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 12, fontSize: 15, color: colors.ink, backgroundColor: colors.card },
  name: { fontWeight: '600' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  member: { flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#EEF0F3', minHeight: 44 },
  memberText: { flex: 1, fontSize: 14, color: colors.ink },
  remove: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  removeText: { fontSize: 15, color: colors.muted },
  smallBtn: { minHeight: 44, justifyContent: 'center' },
  danger: { color: colors.danger, fontSize: 14, fontWeight: '600' },
  error: { color: colors.danger, fontSize: 14 },
});
