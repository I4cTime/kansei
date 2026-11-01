import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";

export type PanelDef = {
  id: "projects" | "board" | "calendar" | "sessions" | "memory" | "rules" | "mcps" | "agents" | "skills" | "workflows" | "hooks" | "settings";
  label: string;
  icon: LucideIcon;
  /** Rendered inside the sidebar body (narrow column). Must scroll itself. */
  Component: ComponentType;
};
