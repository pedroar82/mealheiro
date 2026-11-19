// Visual tokens from the mockup (docs/SPEC.md → design canvas).
export const colors = {
  ground: '#F3F4F6',
  card: '#FFFFFF',
  ink: '#14171F',
  muted: '#5B6170',
  border: '#E4E6EB',
  accent: '#2F5BEA',
  accentSoft: '#E6ECFD',
  income: '#17785A',
  expense: '#F2A65A',
  warning: '#C2560C',
  warningSoft: '#FDF3EA',
  danger: '#B42318',
} as const;

// Chart series colours — validated (dataviz validate_palette.js, light surface): fixed order, never cycled.
// Some are < 3:1 vs the surface, so charts always carry visible value labels / a legend with amounts.
export const seriesPalette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4'] as const;
export const otherSeries = '#A3A9B6'; // "Outras" bucket (neutral, folded tail)
export const chartColors = {
  bar: '#2a78d6',
  barMuted: '#9ec5f4',
  income: '#1baf7a',
  expense: '#eb6834',
  grid: '#E1E0D9',
} as const;

export const space = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
export const radius = { sm: 8, md: 14, lg: 20 } as const;
export const maxContentWidth = 1100;
