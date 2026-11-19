import type { ColorValue } from 'react-native';
import { SymbolView, type AndroidSymbol, type SFSymbol } from 'expo-symbols';

// SF Symbols on iOS, Material Symbols on Android/web.
const icons = {
  home: { ios: 'house', web: 'home' },
  list: { ios: 'list.bullet', web: 'list' },
  add: { ios: 'plus.circle.fill', web: 'add_circle' },
  search: { ios: 'magnifyingglass', web: 'search' },
  chart: { ios: 'chart.pie', web: 'pie_chart' },
} as const satisfies Record<string, { ios: SFSymbol; web: AndroidSymbol }>;

export type IconName = keyof typeof icons;

export function Icon({ name, size = 24, color }: { name: IconName; size?: number; color: ColorValue }) {
  const n = icons[name];
  return <SymbolView name={{ ios: n.ios, android: n.web, web: n.web }} size={size} tintColor={color} />;
}
