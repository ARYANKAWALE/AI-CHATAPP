import OpenAI from "openai";
import type { AssistantStream } from "openai/lib/AssistantStream";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

export class OpenAiResponseHandler {
  private message_text = "";
  private chunk_counter = 0;
  private run_id = "";
  private is_done = false;
  private last_update_time = 0;

  constructor(
    private readonly openai: OpenAI,
    private readonly openAiThread: OpenAI.Beta.Thread,
    private readonly assistantStream: AssistantStream,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly onDisposeL: () => void,
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async () => {};
  dispose = async () => {};
  private handleStopGenerating = async (event: Event) => {};
  private handleStreamEvent = async (event: Event) => {};
  private handleError = async (error: Error) => {
    if (this.is_done) {
      return;
    }
    await this.channel.sendEvent({
      type: "ai_indicator.update",
      ai_state: "AI_STATE_ERROR",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.chatClient.partialUpdateMessage(this.message.id, {
      set: {
        text: error.toString() || "Error generating the message",
      },
    });
    await this.dispose();
  };
  private performWebSearch = async (query: string): Promise<string> => {
    const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    if (!TAVILY_API_KEY) {
      return JSON.stringify({
        error: "Web search is not available,APi key not configured",
      });
    }
    console.log(`Performing a web search for ${query}`);
    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TAVILY_API_KEY}`,
        },
        body: JSON.stringify({
          query: query,
          search_depth: "advanced",
          max_results: 5,
          include_answer: true,
          include_raw_content: false,
        }),
      });
      if (!response.ok) {
        const errorText = await response.text();
        console.log(`Tavily search failed for query ${query}:`, errorText);
        return JSON.stringify({
          error: `Search failed with status: ${response.status}`,
        });
      }
      const data = await response.json();
      console.log(`Tavily search successful for query: ${query}`);
      return JSON.stringify(data);
    } catch (error) {
      console.error(
        `An exception occured during Tavily search failed for query ${query}:`,
        error,
      );
      return JSON.stringify({
        error: `An exception occured during web search`,
      });
    }
  };
}
