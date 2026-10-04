import type { ChangeEventHandler } from "react";

/**
 * The app's sliding on/off switch — the visual replacement for a bare native
 * checkbox for boolean settings/options. Renders the `.eld-switch` pill (see
 * themes.css): a real, focusable checkbox layered transparently over the track,
 * whose `::after` pseudo is the moving knob. Pass `size="sm"` in compact inline
 * toolbars / filter rows so the switch doesn't dominate the row.
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  size,
  title,
  id,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy,
}: {
  checked: boolean;
  onChange: ChangeEventHandler<HTMLInputElement>;
  disabled?: boolean;
  size?: "sm";
  title?: string;
  /** For a `<label htmlFor>` that does not wrap the switch. */
  id?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <span className={`eld-switch${size === "sm" ? " eld-switch-sm" : ""}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        title={title}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
      />
      <span className="eld-switch-track" aria-hidden="true" />
    </span>
  );
}
