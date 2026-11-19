import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type PropsWithChildren } from 'react';

import { supabase } from '@/lib/supabase';

type SessionState = { session: Session | null; loading: boolean };

const SessionContext = createContext<SessionState>({ session: null, loading: true });

export function SessionProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<SessionState>({ session: null, loading: true });

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      if (!data.session && __DEV__) {
        // Development convenience only: auto sign-in with credentials from .env.
        // The whole block is stripped from production bundles (__DEV__ === false).
        const email = process.env.EXPO_PUBLIC_DEV_EMAIL;
        const password = process.env.EXPO_PUBLIC_DEV_PASSWORD;
        if (email && password) {
          const { error } = await supabase.auth.signInWithPassword({ email, password });
          if (!error) return; // onAuthStateChange will set the session
          console.warn('Dev auto sign-in failed:', error.message);
        }
      }
      setState({ session: data.session, loading: false });
    });

    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      setState({ session, loading: false });
      if (event === 'SIGNED_IN') {
        // Idempotent: creates default categories and accounts on first login only.
        supabase.rpc('seed_defaults').then(({ error }) => {
          if (error) console.warn('seed_defaults failed', error.message);
        });
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
