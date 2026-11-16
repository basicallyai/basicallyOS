/** Minimal keyed/block reconciliation: unchanged messages/Markdown retain DOM, selection and controls. */
export function reconcileChildren(parent, desired) {
  let cursor = parent.firstChild;
  for (const child of desired) { if (child === cursor) cursor = cursor.nextSibling; else parent.insertBefore(child, cursor); }
  while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
}
export function updateMarkdown(host, value, render, context = undefined) {
  const identity = JSON.stringify([context?.workspaceId || null, context?.path || null]);
  if (host.markdownValue === value && host.markdownIdentity === identity) return;
  const content = value ? render(value, context) : null, previous = host.firstElementChild;
  if (!content || !previous || host.markdownIdentity !== identity) { host.replaceChildren(...(content ? [content] : [])); if (content) for (const node of content.childNodes) node.markdownSignature = node.nodeType === 1 ? node.outerHTML : node.textContent; }
  else {
    const old = [...previous.childNodes], fresh = [...content.childNodes], nodes = fresh.map((node, index) => {
      const signature = node.nodeType === 1 ? node.outerHTML : node.textContent;
      if (old[index]?.markdownSignature === signature) return old[index];
      if (node.classList?.contains('code-display') && old[index]?.updateCode && old[index].codeLanguage === node.codeLanguage) { old[index].updateCode(node); old[index].markdownSignature = signature; return old[index]; }
      node.markdownSignature = signature; return node;
    });
    reconcileChildren(previous, nodes);
  }
  host.markdownValue = value; host.markdownIdentity = identity;
}
