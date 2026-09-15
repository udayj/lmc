import { cp, mkdir, rm } from 'node:fs/promises';
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const path of ['index.html', 'pricelists.html', 'blog.html', 'css', 'fancybox', 'fonts', 'img', 'js']) {
  await cp(path, `dist/${path}`, { recursive: true });
}
console.log('Website assets built.');
