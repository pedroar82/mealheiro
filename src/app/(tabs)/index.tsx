import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Placeholder, Screen } from '@/components/screen';
import { colors, space } from '@/constants/theme';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';

export default function Inicio() {
  const { session } = useSession();
  const [categories, setCategories] = useState<number | null>(null);

  // Phase 0 connectivity check: proves auth + RLS + seed work end to end.
  useEffect(() => {
    supabase
      .from('categories')
      .select('id', { count: 'exact', head: true })
      .then(({ count }) => setCategories(count ?? 0));
  }, []);

  return (
    <Screen title="Início">
      <Placeholder phase={1} text="Saldo do mês, despesas por dia/semana/mês, para onde foi o dinheiro e movimentos recentes." />
      <View style={styles.status}>
        <Text style={styles.statusText}>Sessão: {session?.user.email}</Text>
        <Text style={styles.statusText}>Categorias na base de dados: {categories ?? '…'}</Text>
        <Pressable accessibilityRole="button" onPress={() => supabase.auth.signOut()} style={styles.signOut}>
          <Text style={styles.signOutText}>Terminar sessão</Text>
        </Pressable>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  status: { gap: space.xs },
  statusText: { fontSize: 13, color: colors.muted },
  signOut: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  signOutText: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
