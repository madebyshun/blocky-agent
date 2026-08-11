import { NextRequest, NextResponse } from "next/server";
import {
  runAeonSkill,
  runMiroSharkSkill,
  runBlueSkill,
  callLLM,
} from "@/app/api/_lib/llm";
import { AGENT_TOOLS, type AgentTool } from "@/lib/agent-tools";

// ─── Runners ──────────────────────────────────────────────────────────────────


export const runtime = "nodejs";
// Vercel kills serverless functions at 60s by default — explicit budget
// so it fails loudly instead of silently 504-ing.
export const maxDuration = 120;

async function runSingleTool(tool: AgentTool, userInput: string): Promise<string> {
  if (tool.agentType === "aeon" && tool.skillId) {
    return (await runAeonSkill(tool.skillId, userInput)) ?? "No result from Aeon";
  }
  if (tool.agentType === "miroshark") {
    return (await runMiroSharkSkill({
      scenario: `${tool.name}: ${userInput}`,
      context: { input: userInput, tool: tool.name },
      persona: "analyst",
      maxTokens: 800,
    })) ?? "No result from MiroShark";
  }
  if (tool.agentType === "blue" && tool.skillFiles) {
    return (await runBlueSkill({
      task: `Run the ${tool.name} tool. Input: ${userInput}`,
      skillFiles: tool.skillFiles,
      input: userInput,
      maxTokens: 900,
    })) ?? "No result from Blue Agent";
  }
  // Bankr was banned 2026-07-18 — route through the shared Virtuals →
  // Venice → Bankr chain instead of calling Bankr directly. Return the
  // text field to preserve this function's `Promise<string>` contract.
  const r = await callLLM({
    system: `You are an AI agent assistant. Run the "${tool.name}" skill. ${tool.description}`,
    messages: [{ role: "user", content: userInput }],
    maxTokens: 800,
  });
  return r.text;
}

async function runCompositeTool(tool: AgentTool, userInput: string): Promise<string> {
  if (!tool.compositeSkills?.length) throw new Error("No composite skills defined");

  const results = await Promise.all(
    tool.compositeSkills.map(async (cs) => {
      if (cs.agentType === "aeon" && cs.skillId) {
        const r = await runAeonSkill(cs.skillId, userInput);
        return { label: cs.label, result: r ?? "" };
      }
      if (cs.agentType === "miroshark") {
        const r = await runMiroSharkSkill({
          scenario: `${cs.label}: ${userInput}`,
          context: { input: userInput },
          persona: "analyst",
          maxTokens: 600,
        });
        return { label: cs.label, result: r ?? "" };
      }
      return { label: cs.label, result: "" };
    })
  );

  const combinedContext = results
    .filter(r => r.result)
    .map(r => `=== ${r.label} ===\n${r.result}`)
    .join("\n\n");

  const synthesis = await runBlueSkill({
    task: `Synthesize these ${tool.compositeSkills.length} intelligence reports into one unified "${tool.name}" brief.
Focus on: actionable insights, key patterns, what this means for the user.
Structure the output clearly with sections. Be specific and concrete.`,
    skillFiles: ["base-ecosystem.md"],
    input: `User focus: ${userInput || "general"}\n\n${combinedContext.slice(0, 3000)}`,
    maxTokens: 1200,
  });

  return synthesis ?? combinedContext;
}

// ─── POST /api/tool-runner ────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body      = await req.json() as Record<string, unknown>;
    const toolId    = (body.toolId as string) ?? "";
    const userInput = (body.input  as string) ?? "";

    const tool = AGENT_TOOLS.find(t => t.id === toolId);
    if (!tool) {
      return NextResponse.json({ error: `Tool "${toolId}" not found` }, { status: 404 });
    }

    const result = tool.isComposite
      ? await runCompositeTool(tool, userInput)
      : await runSingleTool(tool, userInput);

    return NextResponse.json({
      toolId,
      toolName: tool.name,
      agentName: tool.agentName,
      isComposite: tool.isComposite,
      compositeCount: tool.compositeSkills?.length,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[tool-runner]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Tool run failed" },
      { status: 500 }
    );
  }
}

// ─── GET /api/tool-runner ─────────────────────────────────────────────────────

export async function GET() {
  return NextResponse.json({
    tools: AGENT_TOOLS,
    total: AGENT_TOOLS.length,
    composite: AGENT_TOOLS.filter(t => t.isComposite).length,
    agents: [...new Set(AGENT_TOOLS.map(t => t.agentName))],
  });
}
