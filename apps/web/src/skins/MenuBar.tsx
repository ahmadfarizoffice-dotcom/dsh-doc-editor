/**
 * Accessible application menu bar used by every skin.
 *
 * Behaviour kept deliberately small and predictable:
 *  - click or Enter/Space opens a menu;
 *  - ArrowDown/ArrowUp/Home/End move between enabled items;
 *  - Escape closes and returns focus to the trigger;
 *  - ArrowLeft/ArrowRight move between top-level menus;
 *  - a pointerdown outside the bar closes the open menu;
 *  - the panel is absolutely positioned, so opening it never shifts layout.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { MenuDefinition, MenuItem } from "./menus";
import { Icon } from "./icons";

type MenuButton = HTMLButtonElement;

function enabledItems(panel: HTMLElement | null): MenuButton[] {
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll<MenuButton>(
      'button[role="menuitem"]:not(:disabled), button[role="menuitemradio"]:not(:disabled)',
    ),
  );
}

function MenuRow({
  item,
  onDone,
}: {
  item: MenuItem;
  onDone: () => void;
}): React.JSX.Element {
  if (item.kind === "separator")
    return <div className="s-menu-separator" role="separator" />;
  if (item.kind === "heading")
    return (
      <div className="s-menu-heading" role="presentation">
        {item.label}
      </div>
    );
  const checked = item.checked;
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      className={
        checked === undefined
          ? "s-menu-item"
          : checked
            ? "s-menu-item is-checked"
            : "s-menu-item"
      }
      disabled={item.disabled}
      title={item.disabled ? item.disabledReason : undefined}
      onClick={() => {
        if (item.disabled) return;
        item.onSelect();
        onDone();
      }}
    >
      <span className="s-menu-check" aria-hidden="true">
        {checked ? <Icon name="check" size={14} /> : null}
      </span>
      <span className="s-menu-label">{item.label}</span>
      {item.shortcut ? (
        <span className="s-menu-shortcut" aria-hidden="true">
          {item.shortcut}
        </span>
      ) : null}
    </button>
  );
}

export function MenuBar({
  menus,
  className,
  ariaLabel = "Application menu",
  align = "start",
}: {
  menus: MenuDefinition[];
  className?: string;
  ariaLabel?: string;
  align?: "start" | "end";
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggers = useRef(new Map<string, MenuButton>());

  const close = useCallback((returnFocusTo?: string): void => {
    setOpenId(null);
    if (returnFocusTo) {
      const trigger = triggers.current.get(returnFocusTo);
      trigger?.focus();
    }
  }, []);

  useEffect(() => {
    if (!openId) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(openId);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, openId]);

  useLayoutEffect(() => {
    if (!openId) return;
    const items = enabledItems(panelRef.current);
    items[0]?.focus();
  }, [openId]);

  const moveTop = (currentId: string, delta: number): void => {
    const index = menus.findIndex((menu) => menu.id === currentId);
    if (index < 0) return;
    const next = menus[(index + delta + menus.length) % menus.length];
    if (!next) return;
    triggers.current.get(next.id)?.focus();
  };

  const onTriggerKeyDown = (
    event: React.KeyboardEvent<MenuButton>,
    menu: MenuDefinition,
  ): void => {
    switch (event.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault();
        setOpenId(menu.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        moveTop(menu.id, 1);
        break;
      case "ArrowLeft":
        event.preventDefault();
        moveTop(menu.id, -1);
        break;
      case "Escape":
        event.preventDefault();
        close(menu.id);
        break;
      default:
        break;
    }
  };

  const onPanelKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    menu: MenuDefinition,
  ): void => {
    const items = enabledItems(panelRef.current);
    const current = items.indexOf(document.activeElement as MenuButton);
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        close(menu.id);
        break;
      case "ArrowDown":
        event.preventDefault();
        items[(current + 1 + items.length) % items.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        items[(current - 1 + items.length) % items.length]?.focus();
        break;
      case "Home":
        event.preventDefault();
        items[0]?.focus();
        break;
      case "End":
        event.preventDefault();
        items[items.length - 1]?.focus();
        break;
      case "ArrowRight": {
        event.preventDefault();
        close();
        moveTop(menu.id, 1);
        break;
      }
      case "ArrowLeft": {
        event.preventDefault();
        close();
        moveTop(menu.id, -1);
        break;
      }
      case "Tab":
        close();
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={className ? `s-menu-bar ${className}` : "s-menu-bar"}
      role="menubar"
      aria-label={ariaLabel}
    >
      {menus.map((menu) => {
        const open = openId === menu.id;
        return (
          <div className="s-menu-root" key={menu.id}>
            <button
              ref={(node) => {
                if (node) triggers.current.set(menu.id, node);
                else triggers.current.delete(menu.id);
              }}
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={menu.ariaLabel ?? menu.label}
              className={open ? "s-menu-trigger is-open" : "s-menu-trigger"}
              onClick={() => setOpenId(open ? null : menu.id)}
              onKeyDown={(event) => onTriggerKeyDown(event, menu)}
            >
              {menu.icon ? <Icon name={menu.icon} size={16} /> : null}
              <span>{menu.label}</span>
            </button>
            {open ? (
              <div
                ref={panelRef}
                className={
                  align === "end"
                    ? "s-menu-panel s-menu-panel-end"
                    : "s-menu-panel"
                }
                role="menu"
                aria-label={menu.label}
                onKeyDown={(event) => onPanelKeyDown(event, menu)}
              >
                {menu.items.map((item, index) => (
                  <MenuRow
                    key={`${item.id}-${index}`}
                    item={item}
                    onDone={() => close(menu.id)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
