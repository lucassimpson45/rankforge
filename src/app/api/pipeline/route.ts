import { runPipeline } from "@/lib/pipeline";
import type { SsePayload } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

function encodeSse(data: SsePayload): Uint8Array {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  return new TextEncoder().encode(payload);
}

export async function POST(request: Request): Promise<Response> {
  let topic = "";
  try {
    const body = (await request.json()) as { topic?: string };
    topic = typeof body.topic === "string" ? body.topic : "";
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: SsePayload) => {
        try {
          controller.enqueue(encodeSse(payload));
        } catch {
          /* stream may be closed */
        }
      };

      runPipeline(topic, send)
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          send({ type: "error", message });
        })
        .finally(() => {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
