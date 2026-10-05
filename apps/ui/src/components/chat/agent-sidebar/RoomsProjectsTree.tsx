import { useState, type ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  DragOverlay,
} from '@dnd-kit/core'
import {
  SortableContext,
  verticalListSortingStrategy,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import type { BuilderSidebarOrderRef } from '@forge/protocol'
import type { ProfileTreeRow } from '@/lib/agent-hierarchy'
import { builderSidebarOrderKey, resolveBuilderSidebarDragMove } from '@/lib/builder-sidebar-order'
import { SortableProfileGroup } from './SortableProfileGroup'

export interface RoomsProjectTreeRow {
  ref: BuilderSidebarOrderRef
  treeRow: ProfileTreeRow
}

export function RoomsProjectsTree({
  rows,
  trailingRows,
  roomsV2 = true,
  activeView,
  isSearchActive,
  dndEnabled: allowDnd = true,
  onMoveBuilderProject,
  renderRow,
  emptyState,
}: {
  rows: readonly RoomsProjectTreeRow[]
  /** Projects with no checkout on this machine: same list, after the reorderable rows, not draggable. */
  trailingRows?: ReactNode[]
  roomsV2?: boolean
  activeView: boolean
  isSearchActive: boolean
  /** When false, the tree stays a static list. Inbox and Projects share the same reorder path. */
  dndEnabled?: boolean
  onMoveBuilderProject?: (active: BuilderSidebarOrderRef, over: BuilderSidebarOrderRef) => void
  renderRow: (
    row: RoomsProjectTreeRow,
    dragHandleRef?: (element: HTMLElement | null) => void,
    dragHandleListeners?: DraggableSyntheticListeners,
    dragHandleAttributes?: DraggableAttributes,
  ) => ReactNode
  emptyState?: ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const dndEnabled = allowDnd && !activeView && !isSearchActive && Boolean(onMoveBuilderProject) && rows.length > 1
  const sortableIds = rows.map((row) => builderSidebarOrderKey(row.ref))
  const activeDragRow = activeDragId
    ? rows.find((row) => builderSidebarOrderKey(row.ref) === activeDragId)
    : null

  const listClassName = roomsV2 ? 'mt-2 space-y-2' : 'mt-2 space-y-1'
  const projectList = rows.length === 0 && !trailingRows?.length
    ? emptyState ?? null
    : dndEnabled ? (
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={(event) => setActiveDragId(String(event.active.id))}
        onDragCancel={() => setActiveDragId(null)}
        onDragEnd={(event) => {
          setActiveDragId(null)
          const { active, over } = event
          if (!over || active.id === over.id || !onMoveBuilderProject) return
          const move = resolveBuilderSidebarDragMove(
            String(active.id),
            String(over.id),
            rows.map((row) => row.ref),
          )
          if (move) onMoveBuilderProject(move.active, move.over)
        }}
      >
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <ul className={listClassName} data-testid="unified-project-list">
            {rows.map((row) => {
              const sortableId = builderSidebarOrderKey(row.ref)
              return (
                <SortableProfileGroup
                  key={sortableId}
                  sortableId={sortableId}
                  roomsV2={roomsV2}
                >
                  {(dragHandleRef, dragHandleListeners, dragHandleAttributes) => (
                    renderRow(row, dragHandleRef, dragHandleListeners, dragHandleAttributes)
                  )}
                </SortableProfileGroup>
              )
            })}
            {trailingRows}
          </ul>
        </SortableContext>
        <DragOverlay>
          {activeDragRow ? (
            <div className="rounded-md border border-sidebar-border bg-sidebar shadow-lg">
              <div className="flex items-center gap-1.5 px-3 py-2">
                <span className="text-sm font-semibold">{activeDragRow.treeRow.profile.displayName}</span>
              </div>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    ) : (
      <ul className={listClassName} data-testid="unified-project-list">
        {rows.map((row) => (
          <li key={builderSidebarOrderKey(row.ref)}>{renderRow(row)}</li>
        ))}
        {trailingRows}
      </ul>
    )

  return projectList
}
