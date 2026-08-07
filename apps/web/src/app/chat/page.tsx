// /chat → redirect to /app/chat (the app-shell chat), forwarding any query
// string. Clean deep-links such as /chat?prefill=<message> (e.g. the Skills
// page "use" action → seed the composer) only reach this stub on NON-prod
// hosts — localhost and Vercel preview — where middleware passes the clean URL
// through instead of rewriting /chat → /app/chat. A bare redirect("/app/chat")
// would drop the query there, so we rebuild and forward it. The prod app host
// never hits this stub (middleware rewrites /chat and keeps the query), but
// preserving it here makes the prefill behave identically in preview + local QA.
import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ChatRedirectPage({ searchParams }: Props) {
  const sp = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (Array.isArray(value)) value.forEach((v) => qs.append(key, v));
    else if (value != null) qs.append(key, value);
  }
  const q = qs.toString();
  redirect("/app/chat" + (q ? `?${q}` : ""));
}
