import { Bot, Brain, CalendarDays, FolderKanban, History, KanbanSquare, Plug, ScrollText, Settings, Sparkles, Webhook, Workflow } from "lucide-react";
import type { PanelDef } from "./types";
import { ProjectsPanel } from "./projects/ProjectsPanel";
import { BoardPanel } from "./board/BoardPanel";
import { CalendarPanel } from "./calendar/CalendarPanel";
import { SessionsPanel } from "./sessions/SessionsPanel";
import { MemoryPanel } from "./memory/MemoryPanel";
import { RulesPanel } from "./rules/RulesPanel";
import { McpPanel } from "./mcps/McpPanel";
import { AgentsPanel } from "./agents/AgentsPanel";
import { SkillsPanel } from "./skills/SkillsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import { HooksPanel } from "./hooks/HooksPanel";
import { SettingsPanel } from "./settings/SettingsPanel";

export const PANELS: PanelDef[] = [
  { id: "projects", label: "Projects", icon: FolderKanban, Component: ProjectsPanel },
  { id: "board", label: "Board", icon: KanbanSquare, Component: BoardPanel },
  { id: "calendar", label: "Calendar", icon: CalendarDays, Component: CalendarPanel },
  { id: "sessions", label: "Sessions", icon: History, Component: SessionsPanel },
  { id: "memory", label: "Memory", icon: Brain, Component: MemoryPanel },
  { id: "rules", label: "Rules", icon: ScrollText, Component: RulesPanel },
  { id: "mcps", label: "MCPs", icon: Plug, Component: McpPanel },
  { id: "agents", label: "Agents", icon: Bot, Component: AgentsPanel },
  { id: "skills", label: "Skills", icon: Sparkles, Component: SkillsPanel },
  { id: "workflows", label: "Workflows", icon: Workflow, Component: WorkflowsPanel },
  { id: "hooks", label: "Hooks", icon: Webhook, Component: HooksPanel },
  { id: "settings", label: "Settings", icon: Settings, Component: SettingsPanel },
];

export { useOpenEditor, type OpenEditorOptions } from "./shared/EditorSheet";
