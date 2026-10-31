import { Bot, Brain, History, Plug, Settings, Sparkles, Webhook, Workflow } from "lucide-react";
import type { PanelDef } from "./types";
import { SessionsPanel } from "./sessions/SessionsPanel";
import { MemoryPanel } from "./memory/MemoryPanel";
import { McpPanel } from "./mcps/McpPanel";
import { AgentsPanel } from "./agents/AgentsPanel";
import { SkillsPanel } from "./skills/SkillsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import { HooksPanel } from "./hooks/HooksPanel";
import { SettingsPanel } from "./settings/SettingsPanel";

export const PANELS: PanelDef[] = [
  { id: "sessions", label: "Sessions", icon: History, Component: SessionsPanel },
  { id: "memory", label: "Memory", icon: Brain, Component: MemoryPanel },
  { id: "mcps", label: "MCPs", icon: Plug, Component: McpPanel },
  { id: "agents", label: "Agents", icon: Bot, Component: AgentsPanel },
  { id: "skills", label: "Skills", icon: Sparkles, Component: SkillsPanel },
  { id: "workflows", label: "Workflows", icon: Workflow, Component: WorkflowsPanel },
  { id: "hooks", label: "Hooks", icon: Webhook, Component: HooksPanel },
  { id: "settings", label: "Settings", icon: Settings, Component: SettingsPanel },
];

export { useOpenEditor, type OpenEditorOptions } from "./shared/EditorSheet";
