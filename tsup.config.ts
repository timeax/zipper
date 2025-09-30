import { defineConfig } from 'tsup';

export default defineConfig({
   entry: ['src/cli.ts'],
   format: ['cjs'],          // <- CLI as CommonJS
   platform: 'node',
   target: 'node18',
   sourcemap: true,
   dts: false,
   splitting: false,
   clean: true,
   banner: { js: '#!/usr/bin/env node' },
   noExternal: [/^node:/],   // builtins stay external automatically
   external: [
      'picomatch', 'yargs', 'archiver', 'cli-progress', 'js-yaml', "unzipper",
      "basic-ftp",
      "tar",
      // add other deps you don’t want inlined
   ],
});