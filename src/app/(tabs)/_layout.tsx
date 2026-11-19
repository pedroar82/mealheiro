import { Tabs } from 'expo-router';

import { Icon, type IconName } from '@/components/icon';
import { colors } from '@/constants/theme';

const tabs: { name: string; title: string; icon: IconName }[] = [
  { name: 'index', title: 'Início', icon: 'home' },
  { name: 'movimentos', title: 'Movimentos', icon: 'list' },
  { name: 'adicionar', title: 'Adicionar', icon: 'add' },
  { name: 'explorar', title: 'Explorar', icon: 'search' },
  { name: 'analise', title: 'Análise', icon: 'chart' },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
      }}>
      {tabs.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{ title: t.title, tabBarIcon: ({ color, size }) => <Icon name={t.icon} color={color} size={size} /> }}
        />
      ))}
    </Tabs>
  );
}
