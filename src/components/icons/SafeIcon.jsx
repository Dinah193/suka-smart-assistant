// C:\Users\larho\suka-smart-assistant\src\components\icons\SafeIcon.jsx
import React from "react";

/** SafeIcon + I (back-compat) — no installs needed. */
const SIZE_CLASS = { xs: "w-3 h-3", sm: "w-4 h-4", md: "w-5 h-5", lg: "w-6 h-6" };
const cx = (...xs) => xs.filter(Boolean).join(" ");
const sizeToProps = (size) =>
  typeof size === "number" ? { style: { width: size, height: size } } : { className: SIZE_CLASS[size] || SIZE_CLASS.sm };

const isElementType = (x) =>
  typeof x === "function" || (x && typeof x === "object" && "$$typeof" in x); // supports memo/forwardRef wrappers

export default function SafeIcon({
  icon,
  className = "",
  size = "sm",
  decorative = true,
  spin = false,
  title,
  ariaLabel,
  ...rest // children ignored intentionally
}) {
  const sizeProps = sizeToProps(size);
  const base = cx("inline-block align-middle shrink-0", sizeProps.className, spin && "animate-spin-slow");

  const a11y = decorative
    ? { "aria-hidden": true, role: "img" }
    : { role: "img", "aria-label": ariaLabel || title || "icon" };

  // 1) React element → clone with merged props
  if (React.isValidElement(icon)) {
    return React.cloneElement(icon, {
      ...a11y,
      ...rest,
      ...(sizeProps.style ? { style: { ...(icon.props?.style || {}), ...sizeProps.style } } : {}),
      className: cx(icon.props?.className, base, className),
      title: title ?? icon.props?.title,
    });
  }
  // 2) Component type / memo / forwardRef → instantiate
  if (isElementType(icon)) {
    return React.createElement(icon, {
      ...a11y,
      ...rest,
      ...(sizeProps.style ? { style: sizeProps.style } : {}),
      className: cx(base, className),
      title,
    });
  }
  // 3) Text fallback
  if (icon != null && (typeof icon === "string" || typeof icon === "number")) {
    return (
      <span
        {...a11y}
        {...rest}
        {...(sizeProps.style ? { style: sizeProps.style } : {})}
        className={cx(base, className)}
        title={title}
      >
        {icon}
      </span>
    );
  }
  if (icon != null && import.meta?.env?.DEV) console.warn("[SafeIcon] Unrenderable payload:", icon);
  return null;
}

/** Back-compat wrapper: <I>{IconType}</I>, <I><Icon/></I>, <I icon={IconType}/> */
export function I(props) {
  const { icon, children, ...rest } = props;

  // Extract exactly ONE icon-like thing and discard everything else
  // so React never sees a raw object as a child.
  const fromChildren = React.Children.toArray(children).find((node) => {
    if (React.isValidElement(node)) return true;            // <Cog/>
    if (isElementType(node)) return true;                   // memo(Cog) / forwardRef(Cog)
    if (typeof node === "string" || typeof node === "number") return true; // emoji/text
    return false;
  });

  const resolved = icon !== undefined ? icon : fromChildren;

  // Never forward children—this avoids React reconciling a raw object.
  return <SafeIcon icon={resolved} {...rest} children={null} />;
}

/* Minimal spin animation */
const style = `
@keyframes safeicon-spin { to { transform: rotate(360deg); } }
.animate-spin-slow { animation: safeicon-spin 1.2s linear infinite; }
`;
if (typeof document !== "undefined" && !document.getElementById("safeicon-style")) {
  const tag = document.createElement("style");
  tag.id = "safeicon-style";
  tag.textContent = style;
  document.head.appendChild(tag);
}
