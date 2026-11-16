/** Note naming is separate from ordinary workspace file naming. */
export const noteTitle = path => String(path || '').replace(/\.(?:md|markdown)$/i, '');
export const notePath = title => noteTitle(String(title || '').trim().replace(/(?:\.md)+$/i, '')) + '.md';
export const isNotePath = path => /\.(md|markdown)$/i.test(path || '');
