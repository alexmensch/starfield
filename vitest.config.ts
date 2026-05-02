import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/client/**/*.ts', 'scripts/**/*.ts'],
      exclude: [
        'src/client/main.ts',
        'src/client/stellata.ts',
        'src/client/shaders/**',
        'src/worker.ts',
        '**/*.test.ts',
        '**/*.d.ts',
        'scripts/sync-dust.ts',
        'scripts/verify-catalog.ts',
      ],
    },
  },
});
