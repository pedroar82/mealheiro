import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AccountsSection, CategoriesSection, ImportsSection, RulesSection } from '@/components/settings';
import { Segmented } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';

type Tab = 'categories' | 'rules' | 'accounts' | 'imports';

export default function Definicoes() {
  const [tab, setTab] = useState<Tab>('categories');
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic">
      <View style={styles.inner}>
        <Segmented
          options={[
            { value: 'categories', label: 'Categorias' },
            { value: 'rules', label: 'Regras' },
            { value: 'accounts', label: 'Contas' },
            { value: 'imports', label: 'Importações' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'categories' && <CategoriesSection />}
        {tab === 'rules' && <RulesSection />}
        {tab === 'accounts' && <AccountsSection />}
        {tab === 'imports' && <ImportsSection />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
});
