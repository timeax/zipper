import type { PreprocessHandler } from '@timeax/zipper';

export const handlers: PreprocessHandler[] = [
   ({ stats, content, ctx }) => {
      console.log(`[preprocess] file: ${stats.rel} ${stats.ext} (${stats.size} bytes, text=${stats.isText})`);
      if (stats.ext !== '.html') return;
      return '<!DOCTYPE html>\n' + '<html>\n<head>\n<meta charset="UTF-8">\n<title>Processed</title>\n</head>\n<body>\n' +
         content.toString().replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gm, '') +
         '\n</body>\n</html>\n';
   },
   ({ stats }) => (stats.name.endsWith('.log') && stats.size > 128 * 1024 ? null : undefined),
];

export default handlers; // default or named export both supported