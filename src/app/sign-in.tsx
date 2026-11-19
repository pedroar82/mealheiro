import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radius, space } from '@/constants/theme';
import { supabase } from '@/lib/supabase';

// Single-user app: the account is created once in the Supabase dashboard (sign-ups disabled).
export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn() {
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(error.message === 'Invalid login credentials' ? 'Email ou palavra-passe incorretos.' : error.message);
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.center}>
        <View style={styles.card}>
          <Text style={styles.brand}>Mealheiro</Text>
          <Text style={styles.subtitle}>Entrar</Text>

          <Text style={styles.label} nativeID="email-label">Email</Text>
          <TextInput
            accessibilityLabelledBy="email-label"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
          />

          <Text style={styles.label} nativeID="password-label">Palavra-passe</Text>
          <TextInput
            accessibilityLabelledBy="password-label"
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="current-password"
            textContentType="password"
            onSubmitEditing={signIn}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            accessibilityRole="button"
            onPress={signIn}
            disabled={busy || !email || !password}
            style={({ pressed }) => [styles.button, (busy || !email || !password) && styles.disabled, pressed && styles.pressed]}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Entrar</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ground },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: space.md },
  card: { width: '100%', maxWidth: 400, backgroundColor: colors.card, borderRadius: radius.lg, padding: space.lg, gap: space.sm },
  brand: { fontSize: 28, fontWeight: '700', color: colors.ink },
  subtitle: { fontSize: 15, color: colors.muted, marginBottom: space.sm },
  label: { fontSize: 13, fontWeight: '600', color: colors.muted, marginTop: space.sm },
  input: { height: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, fontSize: 16, color: colors.ink },
  error: { color: colors.danger, fontSize: 14, marginTop: space.sm },
  button: { height: 50, borderRadius: radius.md, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', marginTop: space.md },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.8 },
});
