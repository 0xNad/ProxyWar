import { html, TemplateResult } from "lit";

export type ButtonVariant =
  | "normal"
  | "red"
  | "green"
  | "indigo"
  | "yellow"
  | "sky";
export interface ActionButtonProps {
  onClick: (e: MouseEvent) => void;
  type?: ButtonVariant;
  icon: string;
  iconAlt: string;
  title: string;
  label: string;
  disabled?: boolean;
}

const ICON_SIZE =
  "h-5 w-5 shrink-0 transition-transform group-hover:scale-110 text-zinc-400";
const TEXT_SIZE =
  "text-base sm:text-[14px] leading-5 font-semibold tracking-tight";

const getButtonStyles = () => {
  const btnBase =
    "group w-full min-w-[50px] select-none flex flex-col items-center justify-center " +
    "gap-1 rounded-lg py-1.5 border border-white/10 bg-white/4 shadow-xs " +
    "transition-all duration-150 " +
    "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-white/20 " +
    "active:translate-y-[1px]";

  // Variants route through the canonical --pw-* tokens (see styles/tokens.css)
  // instead of hardcoded hex. red/green map 1:1 onto --pw-danger/--pw-positive;
  // yellow/sky unify onto --pw-caution/--pw-info.
  return {
    normal: `${btnBase} text-white/90 hover:bg-white/10 hover:text-white`,
    red: `${btnBase} text-danger hover:bg-danger/10 hover:text-danger focus-visible:ring-danger/30`,
    green: `${btnBase} text-positive hover:bg-positive/10 hover:text-positive focus-visible:ring-positive/30`,
    yellow: `${btnBase} text-caution hover:bg-caution/10 hover:text-caution focus-visible:ring-caution/30`,
    indigo: `${btnBase} text-indigo-400 hover:bg-indigo-500/10 hover:text-indigo-300 focus-visible:ring-indigo-400/30`,
    sky: `${btnBase} text-info hover:bg-info/10 hover:text-info-strong focus-visible:ring-info/30`,
  };
};

export const actionButton = (props: ActionButtonProps): TemplateResult => {
  const {
    onClick,
    type = "normal",
    icon,
    iconAlt,
    title,
    label,
    disabled = false,
  } = props;
  const buttonStyles = getButtonStyles();
  const buttonClass = buttonStyles[type];

  return html`
    <button
      @click=${onClick}
      class="${buttonClass}"
      title="${title}"
      type="button"
      aria-label="${title}"
      ?disabled=${disabled}
    >
      <img src=${icon} alt=${iconAlt} aria-hidden="true" class="${ICON_SIZE}" />
      <span class="${TEXT_SIZE}">${label}</span>
    </button>
  `;
};
