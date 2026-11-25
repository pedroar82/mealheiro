import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { ExportSection } from '@/components/export-section';
import { GroupsSection } from '@/components/groups-section';
import { AccountsSection, CategoriesSection, ImportsSection, RulesSection } from '@/components/settings';
import { Segmented } from '@/components/ui';
import { colors, maxContentWidth, space } from '@/constants/theme';

type Tab = 'categories' | 'rules' | 'accounts' | 'imports' | 'export';

export default function Definicoes() {
  const [tab, setTab] = useState<Tab>('categories');
  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" contentInsetAdjustmentBehavior="automatic" automaticallyAdjustKeyboardInsets>
      <View style={styles.inner}>
        <Segmented
          options={[
            { value: 'categories', label: 'Categorias' },
            { value: 'rules', label: 'Regras' },
            { value: 'accounts', label: 'Contas' },
            { value: 'imports', label: 'Importações' },
            { value: 'export', label: 'Exportar' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'categories' && (
          <>
            <CategoriesSection />
            <GroupsSection />
          </>
        )}
        {tab === 'rules' && <RulesSection />}
        {tab === 'accounts' && <AccountsSection />}
        {tab === 'imports' && <ImportsSection />}
        {tab === 'export' && <ExportSection />}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.ground },
  scroll: { padding: space.md, paddingBottom: space.xl },
  inner: { width: '100%', maxWidth: maxContentWidth, alignSelf: 'center', gap: space.md },
});
