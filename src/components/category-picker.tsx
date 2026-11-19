import { useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, space } from '@/constants/theme';
import { categoryPath, type CategoryIndex } from '@/lib/categories';
import type { CategoryKind } from '@/lib/types';

/** Field that opens a sheet with the category tree; any level can be chosen. */
export function CategoryPicker({
  index,
  kind,
  value,
  onChange,
}: {
  index: CategoryIndex;
  kind: CategoryKind;
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const roots = (index.children.get(null) ?? []).filter((c) => c.kind === kind);

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Categoria: ${categoryPath(index, value)}`}
        onPress={() => setOpen(true)}
        style={styles.field}>
        <Text style={[styles.fieldText, !value && { color: colors.muted }]}>
          {value ? categoryPath(index, value) : 'Escolher categoria'}
        </Text>
        <Text style={styles.chev}>›</Text>
      </Pressable>

      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <SafeAreaView style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Escolher categoria</Text>
            <Pressable accessibilityRole="button" onPress={() => setOpen(false)} style={styles.close}>
              <Text style={styles.closeText}>Fechar</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={{ padding: space.md, gap: space.sm }}>
            {roots.map((root) => {
              const subs = index.children.get(root.id) ?? [];
              const isOpen = expanded === root.id;
              return (
                <View key={root.id} style={styles.group}>
                  <View style={styles.row}>
                    <Pressable accessibilityRole="button" onPress={() => pick(root.id)} style={styles.rowMain}>
                      <Text style={[styles.rowText, value === root.id && styles.selected]}>{root.name}</Text>
                    </Pressable>
                    {subs.length > 0 && (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${isOpen ? 'Fechar' : 'Ver'} subcategorias de ${root.name}`}
                        onPress={() => setExpanded(isOpen ? null : root.id)}
                        style={styles.expand}>
                        <Text style={styles.expandText}>{isOpen ? '−' : `${subs.length} +`}</Text>
                      </Pressable>
                    )}
                  </View>
                  {isOpen &&
                    subs.flatMap((s) => [s, ...(index.children.get(s.id) ?? [])]).map((s) => (
                      <Pressable key={s.id} accessibilityRole="button" onPress={() => pick(s.id)} style={styles.subRow}>
                        <Text style={[styles.subText, value === s.id && styles.selected]}>{categoryPath(index, s.id).split(' › ').slice(1).join(' › ')}</Text>
                      </Pressable>
                    ))}
                </View>
              );
            })}
            <Pressable accessibilityRole="button" onPress={() => pick(null)} style={styles.none}>
              <Text style={styles.noneText}>Por categorizar</Text>
            </Pressable>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  field: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  fieldText: { flex: 1, fontSize: 16, color: colors.ink },
  chev: { fontSize: 22, color: colors.muted },
  sheet: { flex: 1, backgroundColor: colors.ground },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.md, paddingTop: space.md },
  sheetTitle: { fontSize: 20, fontWeight: '700', color: colors.ink },
  close: { minHeight: 44, justifyContent: 'center', paddingHorizontal: space.sm },
  closeText: { fontSize: 16, color: colors.accent, fontWeight: '600' },
  group: { backgroundColor: colors.card, borderRadius: radius.md, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowMain: { flex: 1, minHeight: 50, justifyContent: 'center', paddingHorizontal: space.md },
  rowText: { fontSize: 16, fontWeight: '600', color: colors.ink },
  expand: { minWidth: 64, minHeight: 50, alignItems: 'center', justifyContent: 'center' },
  expandText: { fontSize: 14, color: colors.accent, fontWeight: '600' },
  subRow: { minHeight: 46, justifyContent: 'center', paddingHorizontal: space.lg, borderTopWidth: 1, borderTopColor: '#EEF0F3' },
  subText: { fontSize: 15, color: colors.ink },
  selected: { color: colors.accent },
  none: { minHeight: 48, justifyContent: 'center', paddingHorizontal: space.md },
  noneText: { fontSize: 15, color: colors.warning, fontWeight: '600' },
});
