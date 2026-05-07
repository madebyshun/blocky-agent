import { callWithGrounding, type Task } from "@blueagent/core";

export interface BuilderOptions {
  model?: string;
  maxTokens?: number;
}

export class BlueAgentBuilder {
  private options: BuilderOptions;

  constructor(options: BuilderOptions = {}) {
    this.options = options;
  }

  async idea(prompt: string): Promise<string> {
    return callWithGrounding("idea", prompt, this.options);
  }

  async build(prompt: string): Promise<string> {
    return callWithGrounding("build", prompt, this.options);
  }

  async audit(prompt: string): Promise<string> {
    return callWithGrounding("audit", prompt, this.options);
  }

  async ship(prompt: string): Promise<string> {
    return callWithGrounding("ship", prompt, this.options);
  }

  async raise(prompt: string): Promise<string> {
    return callWithGrounding("raise", prompt, this.options);
  }
}
