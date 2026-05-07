export type PaymentRequirement = {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
};

export type BlueAgentClientOptions = {
  /** Base URL for the Blue Agent API. Defaults to process.env.BLUEAGENT_API_URL */
  baseUrl?: string;
  /** Optional API key, sent as Authorization: Bearer */
  apiKey?: string;
  /** Optional function to sign x402 payment requirements. Receives the requirement and returns base64-encoded X-Payment header value */
  signPayment?: (requirement: PaymentRequirement) => Promise<string>;
};

/**
 * Call a Blue Agent x402 tool by name.
 * Handles 402 Payment Required by invoking signPayment if provided.
 */
export async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  options: BlueAgentClientOptions = {}
): Promise<string> {
  const baseUrl = options.baseUrl ?? process.env.BLUEAGENT_API_URL;
  if (!baseUrl) {
    throw new Error(
      "Blue Agent API base URL not set. Provide baseUrl option or set BLUEAGENT_API_URL environment variable."
    );
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/tools/${toolName}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (options.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`;
  }

  const body = JSON.stringify(args);

  let response = await fetch(url, { method: "POST", headers, body });

  if (response.status === 402) {
    if (!options.signPayment) {
      const paymentHeader = response.headers.get("X-Payment-Required");
      const requirement = paymentHeader ? JSON.parse(paymentHeader) : null;
      const price = requirement?.maxAmountRequired ?? "unknown";
      throw new Error(
        `Payment required for tool '${toolName}' (${price}). ` +
        "Provide a signPayment function in options to handle x402 payments automatically."
      );
    }

    const paymentHeader = response.headers.get("X-Payment-Required");
    if (!paymentHeader) {
      throw new Error(`Tool '${toolName}' returned 402 but no X-Payment-Required header`);
    }

    const requirement: PaymentRequirement = JSON.parse(paymentHeader);
    const signedPayment = await options.signPayment(requirement);

    headers["X-Payment"] = signedPayment;
    response = await fetch(url, { method: "POST", headers, body });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Tool '${toolName}' failed with status ${response.status}: ${text}`);
  }

  const data = await response.json();
  return typeof data === "string" ? data : JSON.stringify(data);
}
