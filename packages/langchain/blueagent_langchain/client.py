import os
import httpx
from typing import Any, Optional


class BlueAgentClientError(Exception):
    pass


async def call_tool(
    tool_name: str,
    args: dict[str, Any],
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
    timeout: float = 30.0,
) -> str:
    """Call a Blue Agent tool via x402 API.

    Args:
        tool_name: The kebab-case tool name (e.g. "risk-gate").
        args: Dictionary of tool arguments.
        base_url: Base URL for the API. Defaults to BLUEAGENT_API_URL env var.
        api_key: Optional API key. Defaults to BLUEAGENT_API_KEY env var.
        timeout: Request timeout in seconds.

    Returns:
        Tool result as a string.

    Raises:
        BlueAgentClientError: If the API URL is not set, payment is required
            without a key, or the request fails.
    """
    base_url = base_url or os.environ.get("BLUEAGENT_API_URL")
    if not base_url:
        raise BlueAgentClientError(
            "BLUEAGENT_API_URL env var not set. "
            "Set BLUEAGENT_API_URL or pass base_url explicitly."
        )

    api_key = api_key or os.environ.get("BLUEAGENT_API_KEY")

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    url = f"{base_url.rstrip('/')}/api/tools/{tool_name}"

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(url, json=args, headers=headers)

        if resp.status_code == 402:
            raise BlueAgentClientError(
                f"Payment required for tool '{tool_name}'. "
                "Set BLUEAGENT_API_KEY or implement x402 payment signing."
            )

        if not resp.is_success:
            raise BlueAgentClientError(
                f"Tool '{tool_name}' failed: {resp.status_code} {resp.text}"
            )

        data = resp.json()
        return data if isinstance(data, str) else str(data)
