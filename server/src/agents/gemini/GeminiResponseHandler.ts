import type { GenerateContentResponse } from "@google/genai";
import type { Channel, Event, MessageResponse, StreamChat } from "stream-chat";

export class GeminiResponseHandler {
  private message_text = "";
  private is_done = false;
  private last_update_time = 0;

  constructor(
    private readonly stream: AsyncIterable<GenerateContentResponse>,
    private readonly chatClient: StreamChat,
    private readonly channel: Channel,
    private readonly message: MessageResponse,
    private readonly onDispose: () => void,
  ) {
    this.chatClient.on("ai_indicator.stop", this.handleStopGenerating);
  }

  run = async (): Promise<string> => {
    const { cid, id: message_id } = this.message;

    try {
      console.log("[GeminiResponseHandler] Starting stream processing...");
      let chunkCount = 0;
      for await (const chunk of this.stream) {
        if (this.is_done) break;

        chunkCount++;
        const text = chunk.text;
        if (text) {
          this.message_text += text;

          const now = Date.now();
          if (now - this.last_update_time > 1000) {
            await this.chatClient.partialUpdateMessage(message_id, {
              set: {
                text: this.message_text,
              },
            });
            this.last_update_time = now;
          }
        }
      }
      console.log(
        `[GeminiResponseHandler] Stream done. ${chunkCount} chunks, ${this.message_text.length} chars total.`,
      );

      // Final update with complete text
      if (!this.is_done) {
        await this.chatClient.partialUpdateMessage(message_id, {
          set: {
            text: this.message_text,
          },
        });

        await this.channel.sendEvent({
          type: "ai_indicator.clear",
          cid: cid,
          message_id: message_id,
        });
      }

      return this.message_text;
    } catch (error) {
      console.error("Error during Gemini stream:", error);
      await this.handleError(error as Error);
      return this.message_text;
    } finally {
      await this.dispose();
    }
  };

  dispose = async () => {
    if (this.is_done) {
      return;
    }
    this.is_done = true;
    this.chatClient.off("ai_indicator.stop", this.handleStopGenerating);
    this.onDispose();
  };

  private handleStopGenerating = async (event: Event) => {
    if (this.is_done || event.message_id !== this.message.id) {
      return;
    }
    console.log("Stop generating for message", this.message.id);

    this.is_done = true;

    // Send final text
    if (this.message_text) {
      await this.chatClient.partialUpdateMessage(this.message.id, {
        set: {
          text: this.message_text,
        },
      });
    }

    await this.channel.sendEvent({
      type: "ai_indicator.clear",
      cid: this.message.cid,
      message_id: this.message.id,
    });
    await this.dispose();
  };

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
}
