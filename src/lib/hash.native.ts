// iOS / Android: Hermes has no crypto.subtle, so use expo-crypto. Same SHA-256 lowercase hex as hash.ts (web), so
// import dedupe keys match across platforms.
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';

export async function sha256Hex(text: string): Promise<string> {
  return (await digestStringAsync(CryptoDigestAlgorithm.SHA256, text)).toLowerCase();
}
