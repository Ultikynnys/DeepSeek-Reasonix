import { DeepSeekClient } from "../client.js";
import {
  DEFAULT_MODEL,
  type EditMode,
  loadEditMode,
  loadEndpointForModel,
  loadFilesystemOutlineThresholdBytes,
  loadJavaSourceEnabled,
  loadProjectShellAllowed,
  loadResolvedSkillPaths,
  loadSubagentModels,
  loadToolRateLimit,
  providerForModel,
  readConfig,
  searchEnabled,
} from "../config.js";
import { bootstrapSemanticSearchInCodeMode } from "../index/semantic/tool.js";
import { resolveOpenAIToken } from "../oauth.js";
import { ToolRegistry } from "../tools.js";
import { registerChoiceTool } from "../tools/choice.js";
import { registerCodeQueryTools } from "../tools/code-query.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerJavaSourceTool } from "../tools/java-source.js";
import { JobRegistry } from "../tools/jobs.js";
import { registerMemoryTools } from "../tools/memory.js";
import { registerPlanTool } from "../tools/plan.js";
import { registerScaffoldTools } from "../tools/scaffold.js";
import { registerShellTools } from "../tools/shell.js";
import { type SkillInstalledHook, registerSkillTools } from "../tools/skills.js";
import {
  SHARED_SUBAGENT_SINK,
  type SubagentSink,
  formatSubagentResult,
  spawnSubagent,
} from "../tools/subagent.js";
import { registerTodoTool } from "../tools/todo.js";
import { registerWebTools } from "../tools/web.js";

export interface CodeToolsetOpts {
  rootDir: string;
  /** Override the default `~/.reasonix/config.json` lookup — primarily for tests that pin a tmp config. */
  configPath?: string;
  /** Fired after `install_skill` writes a new skill — desktop wires this to push a fresh `$skills` event so the sidebar updates without a tab reload. */
  onSkillInstalled?: SkillInstalledHook;
  /** Fired after `run_background` / `stop_job` mutate the JobRegistry — desktop pushes a fresh `$jobs` event so the popover updates without waiting for poll. */
  onJobsChanged?: () => void;
  /** Shared `{current: callback}` sink the TUI populates after mount. Setup forwards it into every `spawnSubagent` so live progress events reach the rich subagent row even though setup runs before the UI does. */
  subagentSink?: SubagentSink;
}

export interface CodeToolset {
  tools: ToolRegistry;
  jobs: JobRegistry;
  registerRooted: (root: string) => void;
  reBootstrapSemantic: (root: string) => Promise<{ enabled: boolean }>;
  semantic: { enabled: boolean };
}

/** Mirror `editMode === "plan"` into the registry's dispatch gate — keeps a single source of truth (the persisted EditMode) for the read-only mode. */
export function applyPlanMode(tools: ToolRegistry, editMode: EditMode): void {
  tools.setPlanMode(editMode === "plan");
}

export async function buildCodeToolset(opts: CodeToolsetOpts): Promise<CodeToolset> {
  const tools = new ToolRegistry({ rateLimit: loadToolRateLimit() });
  applyPlanMode(tools, loadEditMode(opts.configPath));
  const jobs = new JobRegistry();

  const outlineThresholdBytes = loadFilesystemOutlineThresholdBytes();
  const registerRooted = (root: string): void => {
    registerFilesystemTools(tools, { rootDir: root, outlineThresholdBytes });
    const cfg = readConfig();
    registerShellTools(tools, {
      rootDir: root,
      extraAllowed: () => loadProjectShellAllowed(root),
      allowAll: () => loadEditMode() === "yolo",
      jobs,
      onJobsChanged: opts.onJobsChanged,
      sensitivePaths: cfg.sensitivePaths,
    });
    registerMemoryTools(tools, { projectRoot: root });
    registerCodeQueryTools(tools, { rootDir: root });
  };

  const reBootstrapSemantic = async (root: string): Promise<{ enabled: boolean }> => {
    const result = await bootstrapSemanticSearchInCodeMode(tools, root);
    if (!result.enabled) tools.unregister("semantic_search");
    return result;
  };

  registerRooted(opts.rootDir);
  registerPlanTool(tools);
  registerChoiceTool(tools);
  registerTodoTool(tools);
  registerScaffoldTools(tools, { projectRoot: opts.rootDir });
  if (searchEnabled()) {
    registerWebTools(tools);
  }
  if (loadJavaSourceEnabled()) {
    registerJavaSourceTool(tools, { projectRoot: opts.rootDir });
  }
  // Lazy per-model: constructing DeepSeekClient throws when the provider's API
  // key is unset, which would kill `reasonix code` before the setup wizard can
  // prompt for one. Defer to first subagent dispatch — by then the user has
  // either keyed in or we error per-call instead of at boot. Keyed by resolved
  // model id so `model: gpt-5.6-sol` skills route to the OpenAI endpoint and
  // DeepSeek skills to theirs.
  const subagentClients = new Map<string, DeepSeekClient>();
  registerSkillTools(tools, {
    projectRoot: opts.rootDir,
    customSkillPaths: loadResolvedSkillPaths(opts.rootDir),
    subagentModels: loadSubagentModels(),
    onSkillInstalled: opts.onSkillInstalled,
    subagentRunner: async (skill, task, signal) => {
      const model = skill.model ?? DEFAULT_MODEL;
      let subagentClient = subagentClients.get(model);
      if (!subagentClient) {
        const ep = loadEndpointForModel(model);
        subagentClient = new DeepSeekClient({
          apiKey: ep.apiKey,
          baseUrl: ep.baseUrl,
          // OAuth tokens refresh per request — only when no static key exists
          // (env/config keys win; OAuth tokens are audience-locked to api.openai.com).
          apiKeyResolver:
            providerForModel(model) === "openai" &&
            !ep.apiKey &&
            ep.baseUrl === "https://api.openai.com/v1"
              ? () => resolveOpenAIToken()
              : undefined,
        });
        subagentClients.set(model, subagentClient);
      }
      const result = await spawnSubagent({
        client: subagentClient,
        parentRegistry: tools,
        parentSignal: signal,
        system: skill.body,
        task,
        model: skill.model,
        allowedTools: skill.allowedTools,
        skillName: skill.name,
        // Late-bound: the TUI's `useSubagent` writes the live callback into
        // SHARED_SUBAGENT_SINK after mount. Until then `.current` is null
        // and the events are silently dropped — that's fine for non-TUI
        // callers (`reasonix chat --transcript`, library use).
        sink: opts.subagentSink ?? SHARED_SUBAGENT_SINK,
      });
      return formatSubagentResult(result);
    },
  });

  const semantic = await reBootstrapSemantic(opts.rootDir);

  return { tools, jobs, registerRooted, reBootstrapSemantic, semantic };
}
