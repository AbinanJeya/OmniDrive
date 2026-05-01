const DRAG_PREVIEW_GRAB_OFFSET_X = 18;
const DRAG_PREVIEW_GRAB_OFFSET_Y = 18;

export function dragPreviewTransform(x: number, y: number): string {
  return `translate3d(${Math.round(x - DRAG_PREVIEW_GRAB_OFFSET_X)}px, ${Math.round(y - DRAG_PREVIEW_GRAB_OFFSET_Y)}px, 0)`;
}
