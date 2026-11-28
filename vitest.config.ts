import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**/*.test.ts'],
    globals: true,
    environment: 'node',
    // Unit tests must never read or write the real text cache in the home folder.
    env: { D2L_CACHE: 'off', D2L_OCR: 'off' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/auth.ts', 'src/auth-cli.ts'],
    },
  },
});
