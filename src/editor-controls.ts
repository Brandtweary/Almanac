/** Persistent controls attach to each newly rendered composer through its slot. */
export const EDITOR_READY_EVENT = 'almanac-editor-ready';

export function mountEditorControl(host: HTMLElement, order: number): () => void {
 host.dataset.editorControlOrder = String(order);
 const mount = () => {
  const slot = document.querySelector<HTMLElement>('message-editor [data-editor-controls]');
  if (!slot) return;
  const next = [...slot.children].find(child => child !== host && Number((child as HTMLElement).dataset.editorControlOrder) > order);
  if (host.parentElement !== slot || host.nextElementSibling !== (next ?? null)) slot.insertBefore(host, next ?? null);
 };
 document.addEventListener(EDITOR_READY_EVENT, mount);
 mount();
 return () => { document.removeEventListener(EDITOR_READY_EVENT, mount); host.remove(); };
}
