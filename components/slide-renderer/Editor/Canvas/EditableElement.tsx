import { useMemo } from 'react';
import { ElementTypes, type PPTElement } from '@openmaic/dsl';
import { ImageElement } from '../../components/element/ImageElement';
import { TextElement } from '../../components/element/TextElement';
import { LineElement } from '../../components/element/LineElement';
import { ShapeElement } from '../../components/element/ShapeElement';
import { ChartElement } from '../../components/element/ChartElement';
import { LatexElement } from '../../components/element/LatexElement';
import { TableElement } from '../../components/element/TableElement';
import { VideoElement } from '../../components/element/VideoElement';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ElementOrderCommands, ElementAlignCommands } from '@/lib/types/edit';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useI18n } from '@/lib/hooks/use-i18n';
import { editableElementDomId, maicElementIdAttributes } from '../../element-dom';

export interface ContextmenuItem {
  text?: string;
  subText?: string;
  divider?: boolean;
  disable?: boolean;
  hide?: boolean;
  children?: ContextmenuItem[];
  handler?: () => void;
}

interface EditableElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
  readonly isMultiSelect: boolean;
  readonly selectElement: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTElement,
    canMove?: boolean,
  ) => void;
  readonly openLinkDialog: () => void;
}

export function EditableElement({
  elementInfo,
  elementIndex,
  isMultiSelect,
  selectElement,
  openLinkDialog,
}: EditableElementProps) {
  const { t } = useI18n();
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: ImageElement,
      [ElementTypes.TEXT]: TextElement,
      [ElementTypes.SHAPE]: ShapeElement,
      [ElementTypes.LINE]: LineElement,
      [ElementTypes.CHART]: ChartElement,
      [ElementTypes.LATEX]: LatexElement,
      [ElementTypes.TABLE]: TableElement,
      [ElementTypes.VIDEO]: VideoElement,
      // TODO: Add other element types
      // [ElementTypes.AUDIO]: AudioElement,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  const {
    copyElement,
    pasteElement,
    cutElement,
    deleteElement,
    lockElement,
    unlockElement,
    selectAllElements,
    alignElementToCanvas,
    orderElement,
    combineElements,
    uncombineElements,
  } = useCanvasOperations();

  // ED-10 (critical items, 27 Nov 2026): the menu was Chinese for every teacher; its
  // words come from the locale now. The shortcut hints are key names and stay as they are.
  const contextmenus = (): ContextmenuItem[] => {
    if (elementInfo.lock) {
      return [
        {
          text: t('edit.canvasMenu.unlock'),
          handler: () => unlockElement(elementInfo),
        },
      ];
    }

    return [
      {
        text: t('edit.canvasMenu.cut'),
        subText: 'Ctrl + X',
        handler: cutElement,
      },
      {
        text: t('edit.canvasMenu.copy'),
        subText: 'Ctrl + C',
        handler: copyElement,
      },
      {
        text: t('edit.canvasMenu.paste'),
        subText: 'Ctrl + V',
        handler: pasteElement,
      },
      { divider: true },
      {
        text: t('edit.canvasMenu.centerHorizontally'),
        handler: () => alignElementToCanvas(ElementAlignCommands.HORIZONTAL),
        children: [
          {
            text: t('edit.canvasMenu.centerBoth'),
            handler: () => alignElementToCanvas(ElementAlignCommands.CENTER),
          },
          {
            text: t('edit.canvasMenu.centerHorizontally'),
            handler: () => alignElementToCanvas(ElementAlignCommands.HORIZONTAL),
          },
          {
            text: t('edit.canvasMenu.alignLeft'),
            handler: () => alignElementToCanvas(ElementAlignCommands.LEFT),
          },
          {
            text: t('edit.canvasMenu.alignRight'),
            handler: () => alignElementToCanvas(ElementAlignCommands.RIGHT),
          },
        ],
      },
      {
        text: t('edit.canvasMenu.centerVertically'),
        handler: () => alignElementToCanvas(ElementAlignCommands.VERTICAL),
        children: [
          {
            text: t('edit.canvasMenu.centerBoth'),
            handler: () => alignElementToCanvas(ElementAlignCommands.CENTER),
          },
          {
            text: t('edit.canvasMenu.centerVertically'),
            handler: () => alignElementToCanvas(ElementAlignCommands.VERTICAL),
          },
          {
            text: t('edit.canvasMenu.alignTop'),
            handler: () => alignElementToCanvas(ElementAlignCommands.TOP),
          },
          {
            text: t('edit.canvasMenu.alignBottom'),
            handler: () => alignElementToCanvas(ElementAlignCommands.BOTTOM),
          },
        ],
      },
      { divider: true },
      {
        text: t('edit.canvasMenu.bringToFront'),
        disable: isMultiSelect && !elementInfo.groupId,
        handler: () => orderElement(elementInfo, ElementOrderCommands.TOP),
        children: [
          {
            text: t('edit.canvasMenu.bringToFront'),
            handler: () => orderElement(elementInfo, ElementOrderCommands.TOP),
          },
          {
            text: t('edit.canvasMenu.bringForward'),
            handler: () => orderElement(elementInfo, ElementOrderCommands.UP),
          },
        ],
      },
      {
        text: t('edit.canvasMenu.sendToBack'),
        disable: isMultiSelect && !elementInfo.groupId,
        handler: () => orderElement(elementInfo, ElementOrderCommands.BOTTOM),
        children: [
          {
            text: t('edit.canvasMenu.sendToBack'),
            handler: () => orderElement(elementInfo, ElementOrderCommands.BOTTOM),
          },
          {
            text: t('edit.canvasMenu.sendBackward'),
            handler: () => orderElement(elementInfo, ElementOrderCommands.DOWN),
          },
        ],
      },
      { divider: true },
      {
        text: t('edit.canvasMenu.setLink'),
        handler: openLinkDialog,
        disable: true,
      },
      {
        text: elementInfo.groupId ? t('edit.canvasMenu.ungroup') : t('edit.canvasMenu.group'),
        subText: 'Ctrl + G',
        handler: elementInfo.groupId ? uncombineElements : combineElements,
        hide: !isMultiSelect,
      },
      {
        text: t('edit.canvasMenu.selectAll'),
        subText: 'Ctrl + A',
        handler: selectAllElements,
      },
      {
        text: t('edit.canvasMenu.lock'),
        subText: 'Ctrl + L',
        handler: lockElement,
      },
      {
        text: t('edit.canvasMenu.delete'),
        subText: 'Delete',
        handler: deleteElement,
      },
    ];
  };

  if (!CurrentElementComponent) {
    return (
      <div
        id={editableElementDomId(elementInfo.id)}
        {...maicElementIdAttributes(elementInfo.id)}
        className="editable-element absolute"
        style={{
          zIndex: elementIndex,
          left: elementInfo.left + 'px',
          top: elementInfo.top + 'px',
          width: elementInfo.width + 'px',
        }}
      >
        <div className="p-2 bg-gray-100 border border-gray-300 text-xs text-gray-500">
          {elementInfo.type} element (not implemented)
        </div>
      </div>
    );
  }

  return (
    <div
      id={editableElementDomId(elementInfo.id)}
      {...maicElementIdAttributes(elementInfo.id)}
      className="editable-element absolute"
      style={{
        zIndex: elementIndex,
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger>
          <CurrentElementComponent elementInfo={elementInfo} selectElement={selectElement} />
        </ContextMenuTrigger>
        <ContextMenuContent>
          {contextmenus().map((item, index) => {
            if (item.divider) {
              return <ContextMenuSeparator key={index} />;
            }

            // If has children, use submenu component
            if (item.children && item.children.length > 0) {
              return (
                <ContextMenuSub key={index}>
                  <ContextMenuSubTrigger disabled={item.disable} hidden={item.hide}>
                    {item.text}
                    {item.subText && <ContextMenuShortcut>{item.subText}</ContextMenuShortcut>}
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    {item.children.map((child, childIndex) =>
                      child.divider ? (
                        <ContextMenuSeparator key={childIndex} />
                      ) : (
                        <ContextMenuItem
                          key={childIndex}
                          onClick={(e) => {
                            e.stopPropagation();
                            child.handler?.();
                          }}
                          disabled={child.disable}
                          hidden={child.hide}
                        >
                          {child.text}
                          {child.subText && (
                            <ContextMenuShortcut>{child.subText}</ContextMenuShortcut>
                          )}
                        </ContextMenuItem>
                      ),
                    )}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              );
            }

            // Regular menu item
            return (
              <ContextMenuItem
                key={index}
                onClick={(e) => {
                  e.stopPropagation();
                  item.handler?.();
                }}
                disabled={item.disable}
                hidden={item.hide}
              >
                {item.text}
                {item.subText && <ContextMenuShortcut>{item.subText}</ContextMenuShortcut>}
              </ContextMenuItem>
            );
          })}
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
}
