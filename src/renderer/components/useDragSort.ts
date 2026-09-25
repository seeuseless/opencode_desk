import { useRef, useState, type DragEvent } from 'react'

/** 把数组里 from 位置的元素挪到 to 位置（其余顺次让位）。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

type OverPos = 'top' | 'bottom'

/**
 * 极简 HTML5 竖向列表拖拽排序。只有手柄发起拖拽，行内按钮和文本选择不受影响。
 * drop 时按鼠标落在目标行上半部还是下半部计算真实插入下标，保证提示线与结果一致。
 */
export function useDragSort(onReorder: (from: number, to: number) => void) {
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [overIdx, setOverIdx] = useState<number | null>(null)
  const [overPos, setOverPos] = useState<OverPos>('top')
  const dragIdxRef = useRef<number | null>(null)
  const overPosRef = useRef<OverPos>('top')

  const clear = (): void => {
    dragIdxRef.current = null
    setDragIdx(null)
    setOverIdx(null)
    document.body.classList.remove('dragging-row')
  }

  const rowProps = (i: number) => ({
    onDragOver: (e: DragEvent) => {
      if (dragIdxRef.current === null) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const pos: OverPos = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
      overPosRef.current = pos
      setOverPos(pos)
      setOverIdx(i)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      const from = dragIdxRef.current
      if (from === null) return clear()
      const pos = overPosRef.current
      let to = pos === 'bottom' ? i + 1 : i
      if (from < to) to--
      clear()
      if (from !== to) onReorder(from, to)
    },
    onDragEnd: clear
  })

  const handleProps = (i: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => {
      // Chromium 不设置 data 时可能不启动原生拖拽，内容本身不参与业务逻辑。
      e.dataTransfer.setData('text/plain', String(i))
      e.dataTransfer.effectAllowed = 'move'
      dragIdxRef.current = i
      setDragIdx(i)
      document.body.classList.add('dragging-row')
    },
    onDragEnd: clear
  })

  return { dragIdx, overIdx, overPos, rowProps, handleProps }
}
