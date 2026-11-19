/**
 * Small, reusable chrome controls. No behaviour lives here beyond keyboard and
 * popover plumbing; every callback is supplied by the shared skin action layer.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Icon, type IconName } from "./icons";
import {
  FONT_FAMILIES,
  FONT_SIZES,
  ZOOM_LEVELS,
  formatZoom,
} from "./formatting";

export interface ToolButtonProps {
  label: string;
  onClick?: () => void;
  pressed?: boolean;
  disabled?: boolean;
  /** Explanation shown even when the button is enabled. */
  title?: string;
  shortcut?: string;
  className?: string;
  children: ReactNode;
  expanded?: boolean;
  hasPopup?: boolean | "menu" | "dialog";
}

export function ToolButton({
  label,
  onClick,
  pressed,
  disabled,
  title,
  shortcut,
  className,
  children,
  expanded,
  hasPopup,
}: ToolButtonProps): React.JSX.Element {
  const tooltip = title ?? (shortcut ? `${label} (${shortcut})` : label);
  return (
    <button
      type="button"
      className={
        pressed
          ? `s-tool is-pressed${className ? ` ${className}` : ""}`
          : `s-tool${className ? ` ${className}` : ""}`
      }
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-expanded={expanded}
      aria-haspopup={hasPopup}
      title={tooltip}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
    >
      {children}
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export function SelectControl({
  id,
  label,
  value,
  options,
  onChange,
  title,
  className,
  disabled,
}: {
  id?: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  title?: string;
  className?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <>
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={className ? `s-select ${className}` : "s-select"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        title={title ?? label}
        aria-label={label}
        disabled={disabled}
      >
        {options.map((option) => (
          <option
            key={option.value}
            value={option.value}
            style={option.style}
            disabled={option.disabled}
          >
            {option.label}
          </option>
        ))}
      </select>
    </>
  );
}

export function FontSelect({
  value,
  onChange,
  id = "skin-font",
}: {
  value: string;
  onChange: (family: string) => void;
  id?: string;
}): React.JSX.Element {
  const families =
    value && !FONT_FAMILIES.includes(value)
      ? [value, ...FONT_FAMILIES]
      : FONT_FAMILIES;
  return (
    <SelectControl
      id={id}
      label="Font family"
      value={value}
      options={families.map((family) => ({
        value: family,
        label: family,
        style: { fontFamily: family },
      }))}
      onChange={onChange}
      className="s-font-select"
      title="Font family"
    />
  );
}

export function StyleSelect({
  value,
  options,
  onChange,
  id = "skin-style",
}: {
  value: string;
  options: readonly { id: string; name: string }[];
  onChange: (styleId: string) => void;
  id?: string;
}): React.JSX.Element {
  return (
    <SelectControl
      id={id}
      label="Paragraph style"
      value={value}
      options={options.map((style) => ({
        value: style.id,
        label: style.name,
      }))}
      onChange={onChange}
      className="s-style-select"
      title="Paragraph style"
    />
  );
}

export function FontSizeSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (size: number) => void;
}): React.JSX.Element {
  const sizes =
    value && !FONT_SIZES.includes(value)
      ? [value, ...FONT_SIZES].sort((a, b) => a - b)
      : FONT_SIZES;
  return (
    <SelectControl
      id="skin-font-size"
      label="Font size"
      value={String(value)}
      options={sizes.map((size) => ({
        value: String(size),
        label: String(size),
      }))}
      onChange={(next) => onChange(Number(next))}
      className="s-size-select"
      title="Font size (points)"
    />
  );
}

export function SizeStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (size: number) => void;
}): React.JSX.Element {
  const step = (direction: 1 | -1): void => {
    const sorted = [...FONT_SIZES].sort((a, b) => a - b);
    let index = sorted.findIndex((size) => size > value);
    if (direction === 1) {
      const next = index < 0 ? sorted[sorted.length - 1] : sorted[index];
      if (next !== undefined) onChange(next);
      return;
    }
    index = sorted.findIndex((size) => size >= value);
    if (index < 0) index = sorted.length;
    const previous = sorted[index - 1] ?? sorted[0];
    if (previous !== undefined) onChange(previous);
  };
  return (
    <span className="s-size-stepper">
      <button
        type="button"
        className="s-size-button"
        aria-label="Decrease font size"
        title="Decrease font size"
        onClick={() => step(-1)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Icon name="minus" size={14} />
      </button>
      <span className="s-size-value" aria-live="polite" title="Font size (pt)">
        {value}
      </span>
      <button
        type="button"
        className="s-size-button"
        aria-label="Increase font size"
        title="Increase font size"
        onClick={() => step(1)}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

export function ColorControl({
  label,
  value,
  onChange,
  glyph,
  className,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
  glyph?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <label
      className={className ? `s-color ${className}` : "s-color"}
      title={label}
    >
      <span className="s-color-glyph" aria-hidden="true">
        {glyph}
      </span>
      <input
        type="color"
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function ZoomSelect({
  value,
  onChange,
}: {
  value: number;
  onChange: (zoom: number) => void;
}): React.JSX.Element {
  return (
    <SelectControl
      id="skin-zoom"
      label="Zoom"
      value={String(value)}
      options={ZOOM_LEVELS.map((zoom) => ({
        value: String(zoom),
        label: formatZoom(zoom),
      }))}
      onChange={(next) => onChange(Number(next))}
      className="s-zoom-select"
      title="Zoom"
    />
  );
}

export interface PopoverProps {
  label: string;
  title?: string;
  icon?: IconName;
  triggerClassName?: string;
  panelClassName?: string;
  align?: "start" | "end";
  children: ReactNode;
}

/** Popover button: Escape closes, outside pointerdown closes, no layout shift. */
export function Popover({
  label,
  title,
  icon,
  triggerClassName,
  panelClassName,
  align = "start",
  children,
}: PopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback((returnFocus = false): void => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, open]);

  return (
    <span className="s-popover" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={
          triggerClassName
            ? `s-tool ${triggerClassName}`
            : icon
              ? "s-tool s-icon-tool"
              : "s-tool"
        }
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={title ?? label}
        onClick={() => setOpen((value) => !value)}
        onMouseDown={(event) => event.preventDefault()}
      >
        {icon ? <Icon name={icon} size={16} /> : null}
        {!icon ? <span>{label}</span> : null}
      </button>
      {open ? (
        <div
          className={[
            "s-popover-panel",
            align === "end" ? "s-popover-panel-end" : "",
            panelClassName ?? "",
          ]
            .filter(Boolean)
            .join(" ")}
          role="dialog"
          aria-label={label}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  suffix,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}): React.JSX.Element {
  return (
    <label className="s-field" htmlFor={id}>
      <span className="s-field-label">{label}</span>
      <input
        id={id}
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 10) / 10 : 0}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {suffix ? <span className="s-field-suffix">{suffix}</span> : null}
    </label>
  );
}
