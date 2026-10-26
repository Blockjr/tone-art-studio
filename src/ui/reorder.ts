/**
 * Drag-to-reorder for id-tagged items in a list, driven by pointer events so it
 * works with a mouse, pen or touch. The helper is purely visual: it reports the
 * final index and leaves the data change to the caller.
 *
 * Both the mixer strips and the arrangement headers use it, which is what keeps
 * the two views in step - they reorder the same `project.tracks` array.
 */

/** Movement in pixels before a press turns into a drag, so clicks still click. */
const DRAG_THRESHOLD = 5;

export interface ReorderOptions {
  /** Scrolling list that holds the items (and receives the delegated listener). */
  container: HTMLElement;
  /** 'x' for a horizontal console, 'y' for the stacked arrangement headers. */
  axis: 'x' | 'y';
  /** Return the element that starts a drag for this press, or null to ignore it. */
  handle: (target: HTMLElement) => HTMLElement | null;
  /** Called once per drop with the item id and its final index. */
  onDrop: (id: string, index: number) => void;
}

export function enableReorder({ container, axis, handle, onDrop }: ReorderOptions): () => void {
  let abort: (() => void) | null = null;

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || abort) return;

    const target = event.target as HTMLElement | null;
    if (!target) return;
    const grip = handle(target);
    if (!grip) return;

    const item = grip.closest<HTMLElement>('[data-drag-id]');
    const id = item?.dataset.dragId;
    if (!item || !id || !container.contains(item)) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    let index = 0;

    const items = (): HTMLElement[] =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-drag-id]'));

    const clearMarks = (): void => {
      for (const node of items()) node.classList.remove('is-drop-before', 'is-drop-after');
    };

    const midpoint = (node: HTMLElement): number => {
      const rect = node.getBoundingClientRect();
      return axis === 'x' ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    };

    const onMove = (event: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(event.clientX - startX, event.clientY - startY) < DRAG_THRESHOLD) return;
        dragging = true;
        item.classList.add('is-dragging');
        document.body.classList.add('is-reordering');
      }

      const others = items().filter((node) => node !== item);
      const pointer = axis === 'x' ? event.clientX : event.clientY;

      // Insertion index among the remaining items: 0..others.length.
      index = others.length;
      for (let i = 0; i < others.length; i++) {
        if (pointer < midpoint(others[i])) {
          index = i;
          break;
        }
      }

      clearMarks();
      if (index < others.length) others[index].classList.add('is-drop-before');
      else if (others.length) others[others.length - 1].classList.add('is-drop-after');
    };

    const finish = (commit: boolean): void => {
      const dropped = commit && dragging;
      const wasDragging = dragging;

      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);

      item.classList.remove('is-dragging');
      clearMarks();
      document.body.classList.remove('is-reordering');
      abort = null;
      dragging = false;

      // A drop must not also read as a click (selection, mute, rename...).
      if (wasDragging) {
        const swallow = (event: MouseEvent): void => {
          event.stopPropagation();
          event.preventDefault();
          container.removeEventListener('click', swallow, true);
        };
        container.addEventListener('click', swallow, true);
        window.setTimeout(() => container.removeEventListener('click', swallow, true), 200);
      }

      if (dropped) onDrop(id, index);
    };

    const onUp = (): void => finish(true);
    const onCancel = (): void => finish(false);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') finish(false);
    };

    abort = () => finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };

  container.addEventListener('pointerdown', onPointerDown);
  return () => {
    abort?.();
    container.removeEventListener('pointerdown', onPointerDown);
  };
}
