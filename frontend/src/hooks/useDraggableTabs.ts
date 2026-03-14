import { useRef, useCallback } from 'react';

/**
 * Lightweight HTML5 drag-and-drop hook for tab reordering.
 * Returns props to spread onto each draggable tab element.
 */
export function useDraggableTabs(onReorder: (fromIdx: number, toIdx: number) => void) {
  const dragIdx = useRef<number | null>(null);
  const overIdx = useRef<number | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, idx: number) => {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = 'move';
    // Minimal data so Firefox allows drag
    e.dataTransfer.setData('text/plain', String(idx));
    // Add dragging class after a frame so the drag image captures the original look
    requestAnimationFrame(() => {
      (e.target as HTMLElement).classList.add('tab-dragging');
    });
  }, []);

  const onDragOver = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragIdx.current === null || dragIdx.current === idx) {
      // Remove indicators when hovering over self
      (e.currentTarget as HTMLElement).classList.remove('tab-drop-before', 'tab-drop-after');
      overIdx.current = null;
      return;
    }
    overIdx.current = idx;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midX = rect.left + rect.width / 2;
    const el = e.currentTarget as HTMLElement;
    if (e.clientX < midX) {
      el.classList.add('tab-drop-before');
      el.classList.remove('tab-drop-after');
    } else {
      el.classList.add('tab-drop-after');
      el.classList.remove('tab-drop-before');
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('tab-drop-before', 'tab-drop-after');
  }, []);

  const onDrop = useCallback((e: React.DragEvent, idx: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).classList.remove('tab-drop-before', 'tab-drop-after');
    if (dragIdx.current !== null && dragIdx.current !== idx) {
      // Determine if dropping before or after based on mouse position
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      let toIdx = idx;
      if (e.clientX >= midX && idx < dragIdx.current) toIdx = idx + 1;
      else if (e.clientX < midX && idx > dragIdx.current) toIdx = idx - 1;
      onReorder(dragIdx.current, toIdx);
    }
    dragIdx.current = null;
    overIdx.current = null;
  }, [onReorder]);

  const onDragEnd = useCallback((e: React.DragEvent) => {
    (e.target as HTMLElement).classList.remove('tab-dragging');
    // Clean up any lingering drop indicators
    document.querySelectorAll('.tab-drop-before, .tab-drop-after').forEach(el => {
      el.classList.remove('tab-drop-before', 'tab-drop-after');
    });
    dragIdx.current = null;
    overIdx.current = null;
  }, []);

  /** Returns drag props to spread on each tab element */
  const getTabDragProps = useCallback((idx: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => onDragStart(e, idx),
    onDragOver: (e: React.DragEvent) => onDragOver(e, idx),
    onDragLeave,
    onDrop: (e: React.DragEvent) => onDrop(e, idx),
    onDragEnd,
  }), [onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd]);

  return { getTabDragProps };
}
