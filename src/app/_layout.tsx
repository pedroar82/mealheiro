import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';

import { SessionProvider, useSession } from '@/lib/session';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { session, loading } = useSession();

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
  }, [loading]);

  if (loading) return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={!!session}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="movimento/[id]"
          options={{ presentation: 'modal', headerShown: true, title: 'Movimento', headerBackTitle: 'Voltar' }}
        />
        <Stack.Screen name="importar-excel" options={{ headerShown: true, title: 'Importar Excel', headerBackTitle: 'Voltar' }} />
        <Stack.Screen name="importar-documento" options={{ headerShown: true, title: 'Talão ou fatura', headerBackTitle: 'Voltar' }} />
        <Stack.Screen name="importar-extrato" options={{ headerShown: true, title: 'Importar extrato', headerBackTitle: 'Voltar' }} />
      </Stack.Protected>
      <Stack.Protected guard={!session}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1 } } }));
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <RootNavigator />
      </SessionProvider>
    </QueryClientProvider>
  );
}
